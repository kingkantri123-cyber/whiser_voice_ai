import { menu, findItem } from "./data/menu.js";

// -----------------------------------------------------------------------
// Tool schemas, in Gemini function-declaration format. Never guess a
// price/item from memory -- always call list_menu / list_category_items /
// get_item_details. Descriptions are kept short to save tokens.
// -----------------------------------------------------------------------

const optionSelectionSchema = {
  type: "array",
  description: "One entry per chosen option. Add `nested` if the option has nestedOptionGroups.",
  items: {
    type: "object",
    properties: {
      groupId: { type: "string" },
      optionId: { type: "string" },
      nested: {
        type: "array",
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

export const toolDeclarations = [
  {
    name: "list_menu",
    description: "List menu category ids/names. Call first; no items.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_category_items",
    description: "List items + base prices in one category.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category id from list_menu." },
      },
      required: ["category"],
    },
  },
  {
    name: "get_item_details",
    description: "Get one item's option groups, price deltas, nested choices. Call before add_to_cart.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Item id from list_category_items." },
      },
      required: ["itemId"],
    },
  },
  {
    name: "add_to_cart",
    description: "Add item to cart. Rejected with an error if a required option is missing.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        selection: optionSelectionSchema,
        quantity: { type: ["integer", "null"], description: "Default 1." },
      },
      required: ["itemId"],
    },
  },
  {
    name: "update_cart_item",
    description: "Change quantity/options of an existing cart line.",
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
    description: "Remove a cart line.",
    parameters: {
      type: "object",
      properties: { cartItemId: { type: "string" } },
      required: ["cartItemId"],
    },
  },
  {
    name: "view_cart",
    description: "Get cart contents and total.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "place_order",
    description: "Finalize the order. Call only after reading the cart back and getting confirmation.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "record_contact_info",
    description: "Save caller name/phone/email. Call once you have phone or email.",
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
    description: "End the call.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: ["string", "null"],
          description: "e.g. order_placed, caller_ended, no_order",
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
      return {
        categories: menu.categories.map((c) => ({ id: c.id, name: c.name })),
      };
    }

    case "list_category_items": {
      const category = menu.categories.find((c) => c.id === args.category);
      if (!category) return { error: `No menu category with id "${args.category}".` };
      return {
        category: { id: category.id, name: category.name },
        items: category.items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          basePrice: i.basePrice,
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