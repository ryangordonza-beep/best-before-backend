// categorise.js
// Best Before's `products` table has no category column and products
// arrive from three sources (seed, inventory xlsx, WooCommerce sync), so
// the Shop screen's section grouping is derived from the product name
// with ordered keyword rules. First match wins.
//
// Names from the inventory import are truncated to ~30 chars ("Bravo
// Chef - Whole Peeled Toma", "Chef Professional - Easy Cook S"), so the
// patterns match prefixes/fragments, not just whole words.

const RULES = [
  [/muesl|granola/i, 'Muesli & Granola'],
  [/\boats?\b|porridge|quick cook oat/i, 'Cereals & Oats'],
  [/corn thin|rice crack|rice cake|corn cake|poppadum|ladyfinger|bihappy|boudoir|savoiardi|\bfantico\b|puffed/i, 'Crackers & Snacks'],
  [/cup no|\bnoodle|cannel?oni|\bpasta\b|macaroni|spaghetti|giglio/i, 'Pasta & Noodles'],
  [/dijon|mustard|mayonnaise|ketchup|chutney|\brelish\b|dijona/i, 'Condiments'],
  [/\bjam\b|preserve|marmalade|apricot jam/i, 'Jams & Preserves'],
  [/honey|golden syrup|maple syrup|\bsyrup\b|treacle/i, 'Honey & Syrups'],
  [/toothpaste|dental/i, 'Household & Toiletries'],
  [/margarine|\bbutter\b(?! beans)/i, 'Dairy & Fridge'],
  [/sugar|castor|icing|panko|bread ?crumb|\bflour\b|baking powder|caster/i, 'Sugar & Baking'],
  [/black beans|butter beans|kidney bea|baked beans|cannellini|chick ?pea|lentil|legume|split pea|\bbeans\b/i, 'Canned Vegetables & Beans'],
  [/\btoma|tomato|passata|puree|napoletana|napolitana/i, 'Canned Tomatoes'],
  [/artichoke|guava|\bfigs?\b|lychee|peach|\bpears?\b|apricot halves|mixed veg|vegetabl|sweetcorn|mushroom|\bolives?\b|asparagus|fruit cocktail/i, 'Canned Fruit & Veg'],
  [/\blivers?\b|pilchard|\btuna\b|sardine|anchov|mackerel|corned beef|vienna|\bfish\b|figado/i, 'Canned Fish & Meat'],
  [/easy cook|cooking spray|cook spray|cooking oil|olive oil|sunflower oil|canola oil|coconut oil|\boil\b|\bspray\b/i, 'Cooking Oils & Sprays'],
  [/coconut milk|bulg[au]r|couscous|\bfoil\b|cling ?wrap|sea salt|salt grinder|\bstock\b|bouillon|\bspice|peppercorn|vinegar/i, 'Cooking Essentials'],
  [/cappuccino|\bcoffee\b|malt drink|malted|horlicks|\bmilo\b|ovaltine|hot chocolate|\btea\b|rooibos/i, 'Hot Drinks'],
];

function categorise(name) {
  const n = String(name || '');
  for (const [re, cat] of RULES) if (re.test(n)) return cat;
  return 'Other';
}

module.exports = { categorise };
