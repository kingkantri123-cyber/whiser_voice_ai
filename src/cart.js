import { nanoid } from "nanoid";
import { findItem, findOptionGroup, findOption } from "./data/menu.js";

/**
 * A "selection" coming from the tool call looks like:
 * [
 *   { groupId: "pz_size", optionId: "sz_medium" },
 *   { groupId: "pz_toppings", optionId: "tp_pepperoni" },
 *   { groupId: "pz_toppings", optionId: "tp_mushroom" },
 *   { groupId: "combo_entree", optionId: "entree_burrito", nested: [
 *       { groupId: "combo_side_for_burrito", optionId: "side_fries" }
 *   ]}
 * ]
 *
 * validateAndPriceSelection throws a descriptive error (never silently
 * accepts an incomplete required choice) and returns the computed price
 * plus a normalized, human-readable breakdown for the transcript/cart UI.
 */
export function validateAndPriceSelection(item, selection) {
  const errors = [];
  let price = item.basePrice;
  const chosen = [];

  for (const group of item.optionGroups) {
    const picks = selection.filter((s) => s.groupId === group.id);

    if (group.required && picks.length < group.min) {
      errors.push(
        `"${group.name}" is required for ${item.name} (choose ${group.min}).`
      );
      continue;
    }
    if (picks.length > group.max) {
      errors.push(
        `Too many choices for "${group.name}" on ${item.name} (max ${group.max}).`
      );
      continue;
    }

    for (const pick of picks) {
      const option = findOption(group, pick.optionId);
      if (!option) {
        errors.push(
          `"${pick.optionId}" is not a valid choice for "${group.name}" on ${item.name}.`
        );
        continue;
      }
      price += option.priceDelta;
      const chosenEntry = { groupName: group.name, optionName: option.name, nested: [] };

      // Nested required choice (e.g. combo entree -> that entree's side)
      if (option.nestedOptionGroups && option.nestedOptionGroups.length > 0) {
        for (const nestedGroup of option.nestedOptionGroups) {
          const nestedPicks = (pick.nested || []).filter(
            (n) => n.groupId === nestedGroup.id
          );
          if (nestedGroup.required && nestedPicks.length < nestedGroup.min) {
            errors.push(
              `"${nestedGroup.name}" is required after choosing "${option.name}" (choose ${nestedGroup.min}).`
            );
            continue;
          }
          for (const np of nestedPicks) {
            const nestedOption = findOption(nestedGroup, np.optionId);
            if (!nestedOption) {
              errors.push(
                `"${np.optionId}" is not a valid choice for "${nestedGroup.name}".`
              );
              continue;
            }
            price += nestedOption.priceDelta;
            chosenEntry.nested.push({
              groupName: nestedGroup.name,
              optionName: nestedOption.name,
            });
          }
        }
      }

      chosen.push(chosenEntry);
    }
  }

  if (errors.length > 0) {
    const err = new Error(errors.join(" "));
    err.code = "INVALID_SELECTION";
    err.details = errors;
    throw err;
  }

  return { price: Math.round(price * 100) / 100, chosen };
}

export class Cart {
  constructor() {
    this.lines = []; // { cartItemId, itemId, itemName, quantity, unitPrice, chosen, lineTotal }
    this.placed = false;
    this.placedAt = null;
  }

  addItem({ itemId, selection = [], quantity = 1 }) {
    const item = findItem(itemId);
    if (!item) {
      const err = new Error(`No menu item with id "${itemId}".`);
      err.code = "UNKNOWN_ITEM";
      throw err;
    }
    const { price, chosen } = validateAndPriceSelection(item, selection);
    const cartItemId = nanoid(8);
    const line = {
      cartItemId,
      itemId: item.id,
      itemName: item.name,
      quantity,
      unitPrice: price,
      chosen,
      lineTotal: Math.round(price * quantity * 100) / 100,
    };
    this.lines.push(line);
    return line;
  }

  updateItem(cartItemId, { selection, quantity }) {
    const line = this.lines.find((l) => l.cartItemId === cartItemId);
    if (!line) {
      const err = new Error(`No cart item with id "${cartItemId}".`);
      err.code = "UNKNOWN_CART_ITEM";
      throw err;
    }
    if (selection) {
      const item = findItem(line.itemId);
      const { price, chosen } = validateAndPriceSelection(item, selection);
      line.unitPrice = price;
      line.chosen = chosen;
    }
    if (quantity != null) line.quantity = quantity;
    line.lineTotal = Math.round(line.unitPrice * line.quantity * 100) / 100;
    return line;
  }

  removeItem(cartItemId) {
    const before = this.lines.length;
    this.lines = this.lines.filter((l) => l.cartItemId !== cartItemId);
    if (this.lines.length === before) {
      const err = new Error(`No cart item with id "${cartItemId}".`);
      err.code = "UNKNOWN_CART_ITEM";
      throw err;
    }
  }

  total() {
    return Math.round(this.lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100;
  }

  view() {
    return { lines: this.lines, total: this.total(), placed: this.placed };
  }

  place() {
    if (this.lines.length === 0) {
      const err = new Error("Cannot place an empty order.");
      err.code = "EMPTY_CART";
      throw err;
    }
    this.placed = true;
    this.placedAt = new Date().toISOString();
    return this.view();
  }
}
