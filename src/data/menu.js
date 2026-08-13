// Single source of truth for menu items and prices.
// Tools read from this file directly -- the LLM never sees or invents
// a price/item; it only gets what these functions return.

export const menu = {
  categories: [
    {
      id: "pizza",
      name: "Pizza",
      items: [
        {
          id: "pz_margherita",
          name: "Margherita Pizza",
          description: "Tomato, fresh mozzarella, basil",
          basePrice: 9.0,
          optionGroups: [
            {
              id: "pz_size",
              name: "Size",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "sz_small", name: "Small (10\")", priceDelta: 0 },
                { id: "sz_medium", name: "Medium (12\")", priceDelta: 3.0 },
                { id: "sz_large", name: "Large (14\")", priceDelta: 6.0 },
              ],
            },
            {
              id: "pz_crust",
              name: "Crust",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "cr_thin", name: "Thin crust", priceDelta: 0 },
                { id: "cr_stuffed", name: "Stuffed crust", priceDelta: 2.5 },
              ],
            },
            {
              id: "pz_toppings",
              name: "Extra toppings",
              required: false,
              min: 0,
              max: 6,
              options: [
                { id: "tp_pepperoni", name: "Pepperoni", priceDelta: 1.5 },
                { id: "tp_mushroom", name: "Mushroom", priceDelta: 1.0 },
                { id: "tp_olives", name: "Olives", priceDelta: 1.0 },
                { id: "tp_extra_cheese", name: "Extra cheese", priceDelta: 1.5 },
                { id: "tp_jalapeno", name: "Jalapeño", priceDelta: 1.0 },
              ],
            },
          ],
        },
        {
          id: "pz_pepperoni",
          name: "Pepperoni Pizza",
          description: "Tomato, mozzarella, double pepperoni",
          basePrice: 10.5,
          optionGroups: [
            {
              id: "pz_size",
              name: "Size",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "sz_small", name: "Small (10\")", priceDelta: 0 },
                { id: "sz_medium", name: "Medium (12\")", priceDelta: 3.0 },
                { id: "sz_large", name: "Large (14\")", priceDelta: 6.0 },
              ],
            },
            {
              id: "pz_crust",
              name: "Crust",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "cr_thin", name: "Thin crust", priceDelta: 0 },
                { id: "cr_stuffed", name: "Stuffed crust", priceDelta: 2.5 },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "burritos",
      name: "Burritos",
      items: [
        {
          id: "burrito_classic",
          name: "Classic Burrito",
          description: "Rice, beans, salsa, cheese, wrapped in a flour tortilla",
          basePrice: 7.5,
          optionGroups: [
            {
              id: "burrito_protein",
              name: "Protein",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "pr_chicken", name: "Grilled chicken", priceDelta: 0 },
                { id: "pr_steak", name: "Steak", priceDelta: 1.5 },
                { id: "pr_veggie", name: "Veggie / no meat", priceDelta: -1.0 },
              ],
            },
            {
              id: "burrito_spice",
              name: "Spice level",
              required: false,
              min: 0,
              max: 1,
              options: [
                { id: "sp_mild", name: "Mild", priceDelta: 0 },
                { id: "sp_hot", name: "Hot", priceDelta: 0 },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "combos",
      name: "Combos",
      items: [
        {
          id: "combo_lunch",
          name: "Lunch Combo",
          description: "Choice of entrée with a side and a drink",
          basePrice: 11.0,
          optionGroups: [
            {
              id: "combo_entree",
              name: "Entrée",
              required: true,
              min: 1,
              max: 1,
              // Nested required choice: each entrée choice has its OWN
              // required sub-group (the side that comes with it).
              options: [
                {
                  id: "entree_pepperoni_slice",
                  name: "Pepperoni Pizza Slice",
                  priceDelta: 0,
                  nestedOptionGroups: [
                    {
                      id: "combo_side_for_pizza",
                      name: "Side (with pizza slice)",
                      required: true,
                      min: 1,
                      max: 1,
                      options: [
                        { id: "side_salad", name: "Side salad", priceDelta: 0 },
                        { id: "side_fries", name: "Fries", priceDelta: 0.5 },
                      ],
                    },
                  ],
                },
                {
                  id: "entree_burrito",
                  name: "Classic Burrito",
                  priceDelta: 1.0,
                  nestedOptionGroups: [
                    {
                      id: "combo_side_for_burrito",
                      name: "Side (with burrito)",
                      required: true,
                      min: 1,
                      max: 1,
                      options: [
                        { id: "side_chips", name: "Chips & salsa", priceDelta: 0 },
                        { id: "side_fries", name: "Fries", priceDelta: 0.5 },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "combo_drink",
              name: "Drink",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "dr_cola", name: "Cola", priceDelta: 0 },
                { id: "dr_lemonade", name: "Lemonade", priceDelta: 0 },
                { id: "dr_water", name: "Water", priceDelta: -0.5 },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "drinks",
      name: "Drinks",
      items: [
        {
          id: "drink_cola",
          name: "Cola",
          description: "",
          basePrice: 2.0,
          optionGroups: [
            {
              id: "drink_size",
              name: "Size",
              required: true,
              min: 1,
              max: 1,
              options: [
                { id: "dsz_regular", name: "Regular", priceDelta: 0 },
                { id: "dsz_large", name: "Large", priceDelta: 0.75 },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export function findItem(itemId) {
  for (const category of menu.categories) {
    const item = category.items.find((i) => i.id === itemId);
    if (item) return item;
  }
  return null;
}

export function findOptionGroup(item, groupId) {
  return item.optionGroups.find((g) => g.id === groupId) || null;
}

export function findOption(group, optionId) {
  return group.options.find((o) => o.id === optionId) || null;
}
