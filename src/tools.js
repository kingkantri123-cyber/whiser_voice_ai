import { menu, findItem } from "./data/menu.js";

// -----------------------------------------------------------------------
// Tool schemas, in Gemini function-declaration format. Keep descriptions
// explicit about *never guessing* -- the model should always call
// list_menu / get_item_details rather than recall a price from earlier
// in the conversation.
//
// Descriptions here are kept deliberately tight: this whole array is
// re-sent as the `tools` param on every single LLM call (not just once
// per turn), so every word here is a recurring token cost, not a one-time
// one. Trim wording, not the behavioral constraints (never-guess,
// error-driven retry, confirm-before-place-order) -- those are load-
// bearing for correctness.
// -----------------------------------------------------------------------

const optionSelectionSchema = {
  type: "array",
  description:
    "One entry per chosen option group. Add a `nested` array when the chosen option has its own required sub-choice (e.g. a combo's side).",
  items: {
    type: "object",
    properties: {
      groupId: { type: "string", description: "Option group id, from get_item_details." },
      optionId: { type: "string", description: "Chosen option id within that group." },
      nested: {
        type: "array",
        description: "Only when the chosen option has nestedOptionGroups.",
        items: {
          type: "object",
          properties: {
            groupId: { type: "string" },
            optionId: { type: "string" },
          },
          required: ["groupId", "optionId"],
        },
      },
    },
    required: ["groupId", "optionId"],
  },
};

// Tools only relevant once the cart has at least one line. Excluding these
// during the item-selection phase of a call (the majority of most orders)
// shrinks the tool schema sent on every round -- see getToolDeclarations().
export const CHECKOUT_TOOL_NAMES = ["update_cart_item", "remove_from_cart", "place_order", "record_contact_info"];

export const toolDeclarations = [
  {
    name: "list_menu",
    description:
      "List menu categories/items with prices. Never recall prices from memory -- always call this. Optional category filter.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: ["string", "null"],
          description: "Optional category id to filter by (e.g. 'pizza'). Omit or pass null for the full menu.",
        },
      },
    },
  },
  {
    name: "get_item_details",
    description:
      "Get an item's full option details (required/optional groups, price deltas, nested choices). Call before add_to_cart.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Menu item id, from list_menu." },
      },
      required: ["itemId"],
    },
  },
  {
    name: "add_to_cart",
    description:
      "Add an item to the cart. Missing required options return a specific error -- ask the caller for exactly what it names, then retry.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        selection: optionSelectionSchema,
        quantity: { type: ["integer", "null"], description: "Defaults to 1." },
      },
      required: ["itemId"],
    },
  },
  {
    name: "update_cart_item",
    description: "Change the quantity and/or selected options of an existing cart line.",
    parameters: {
      type: "object",
      properties: {
        cartItemId: { type: "string" },
        selection: optionSelectionSchema,
        quantity: { type: ["integer", "null"] },
      },
      required: ["cartItemId"],
    },
  },
  {
    name: "remove_from_cart",
    description: "Remove a line item from the cart.",
    parameters: {
      type: "object",
      properties: { cartItemId: { type: "string" } },
      required: ["cartItemId"],
    },
  },
  {
    name: "view_cart",
    description: "Get cart contents and total. Use to read back the order before placing it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "place_order",
    description:
      "Finalize the order. Only call after reading the cart back and getting explicit confirmation. Fails if the cart is empty.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "record_contact_info",
    description:
      "Save caller name/phone/email for the confirmation. Call once you have a phone or email, ideally before place_order.",
    parameters: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
      },
    },
  },
  {
    name: "end_call",
    description: "End the call/session. Use once the caller is done (order placed, or they want to hang up without ordering).",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: ["string", "null"],
          description: "e.g. 'order_placed', 'caller_ended', 'no_order'",
        },
      },
    },
  },
];

// -----------------------------------------------------------------------
// Executor: runs a single tool call against a session, returns a plain
// object that gets serialized straight back to the model as the
// function response. All validation happens here, not in the prompt.
// -----------------------------------------------------------------------

export function executeTool(session, name, args) {
  switch (name) {
    case "list_menu": {
      const categories = args.category
        ? menu.categories.filter((c) => c.id === args.category)
        : menu.categories;
      return {
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          items: c.items.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            basePrice: i.basePrice,
          })),
        })),
      };
    }

    case "get_item_details": {
      const item = findItem(args.itemId);
      if (!item) return { error: `No menu item with id "${args.itemId}".` };
      return { item };
    }

    case "add_to_cart": {
      try {
        const line = session.cart.addItem({
          itemId: args.itemId,
          selection: args.selection || [],
          quantity: args.quantity || 1,
        });
        return { added: line, cartTotal: session.cart.total() };
      } catch (e) {
        return { error: e.message, code: e.code };
      }
    }

    case "update_cart_item": {
      try {
        const line = session.cart.updateItem(args.cartItemId, {
          selection: args.selection,
          quantity: args.quantity,
        });
        return { updated: line, cartTotal: session.cart.total() };
      } catch (e) {
        return { error: e.message, code: e.code };
      }
    }

    case "remove_from_cart": {
      try {
        session.cart.removeItem(args.cartItemId);
        return { removed: args.cartItemId, cartTotal: session.cart.total() };
      } catch (e) {
        return { error: e.message, code: e.code };
      }
    }

    case "view_cart": {
      return session.cart.view();
    }

    case "place_order": {
      try {
        const result = session.cart.place();
        return { placed: true, order: result, contact: session.contact };
      } catch (e) {
        return { error: e.message, code: e.code };
      }
    }

    case "record_contact_info": {
      session.contact = { ...(session.contact || {}), ...args };
      return { contact: session.contact };
    }

    case "end_call": {
      session.status = "ended";
      session.endedAt = new Date().toISOString();
      return { ended: true, reason: args.reason || "unspecified" };
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}