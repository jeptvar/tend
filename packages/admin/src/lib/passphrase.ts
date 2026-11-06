// Short, common, easy-to-spell words. 5 picks from this list give about 42 bits, on
// top of Argon2id and rate limits. A person typing this on a phone is the design goal.
const WORDS = `able acorn actor adapt agent alarm album alert alley amber ample angle ankle
apple apron arena armor arrow aspen atlas attic audio autumn awake bacon badge bagel baker
balmy bamboo banjo barley basil basket beach beacon beaver begin bench berry bike birch
biscuit blanket blaze bloom board boat bonus book boots bottle brass bread breeze brick
bridge bright brook brush bucket bugle bunny butter button cabin cactus cake camel camera
candle canoe canvas canyon carbon cargo carpet carrot castle cedar celery chair chalk cherry
chess chime cider circle citrus clay clever cliff cloud clover coast cobalt cocoa coffee
comet copper coral cotton cozy crane crayon creek cricket crisp crown cubic curtain daisy
dance dawn deer denim desert diary dolphin donut door dove dragon drift drum eagle early
earth easel echo elbow elm ember engine fable falcon farm feather fence fern ferry fiddle
field finch fireplace flame flute forest fossil fox frame frost fruit garden garlic gate
gentle ginger glacier globe glove golden goose grain grape gravel green guitar hammer harbor
harvest hazel heron hiking hollow honey hood horizon hotel humble iceberg igloo indigo island
ivory jacket jasmine jelly jewel jigsaw journal juniper kayak kettle kitten kiwi ladder lagoon
lantern laurel lava lemon lentil letter lilac linen lively lizard llama lobster locket lotus
lumber lunar magnet mango maple marble market meadow melon mellow mint mirror mitten moon
morning mosaic mossy mountain muffin museum napkin nectar needle nest noble noodle north
nutmeg oasis ocean olive onion opal orange orbit orchard otter oven owl oyster paddle
paint palm pantry paper parade peach peanut pearl pebble pencil penguin pepper piano pickle
pillow pine planet plum pocket polar pond poppy potato prairie pretzel pumpkin puzzle quail
quiet quill quilt rabbit radish rain raven reef ribbon river robin rocket rose rustic saddle
saffron sail salmon sandal scarf school seashell shadow shelf shell shore silver sketch sleepy
slipper smooth snow socks sofa solar spark spice spoon spring spruce stable star stone
stream sugar summer sunny swan table tadpole teapot thimble thistle thunder tiger timber toast
tomato trail tulip tunnel turtle umbrella valley velvet violet violin walnut water wheat
whistle willow window winter wooden woolen yarn yellow zebra zipper`.split(/\s+/);

// Plain `random % length` would favour words near the start of the list.
function randomIndex(length: number): number {
  const limit = Math.floor(2 ** 32 / length) * length;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while ((value[0] ?? limit) >= limit);
  return (value[0] ?? 0) % length;
}

export function suggestPassphrase(words = 5): string {
  return Array.from({ length: words }, () => WORDS[randomIndex(WORDS.length)]).join("-");
}
