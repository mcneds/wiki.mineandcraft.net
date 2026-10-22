---
title: "Building & gathering"
description: "Timber, faster leaf decay, cauldron conversions, and easier slab work."
category: "Guides"
updated: "2026-10-22"
---
A few additions make collecting materials and finishing builds more convenient. These are the features listed in the server's supplied inventory.

## Timber

**Timber** lets you chop down a tree with an axe in survival. Use this command to toggle the feature for yourself:

```text
/trigger TimberToggle
```

Capitalization matters: the trigger is `TimberToggle`. Turn it off when you want normal, individual log breaking. The pack's administrative help function is `/function timber:help`; it is not presented here as a command every player can run.

## Fast leaf decay

Once a survival tree is mined, its leaves decay much faster. There is no player command needed for the normal effect.

## Cauldron concrete

Fill a cauldron with water, then **drop concrete powder into it** to harden the powder into concrete. Drop the item; simply holding the powder and clicking is not the documented action.

```recipe
conversion:cauldron-concrete
```

## Cauldron mud

**Drop dirt into a water-filled cauldron** to turn it into mud. This is a different feature from Cauldron Concrete, with dirt as its input.

```recipe
conversion:cauldron-mud
```

## More effective tools

This pack gives appropriate mining tools to additional blocks. Examples from the author include using a **pickaxe on glass** and an **axe on cactus**. Blocks deliberately designed without an effective tool are excluded; the examples given include powder snow, reinforced deepslate, and vaults.

An effective mining tool does not by itself guarantee that a block drops an item. Enchantment and normal drop requirements still matter.

## KleeSlabs

When breaking a double slab, **aim at the half you want to remove**. KleeSlabs allows that half to be broken without removing the other half. This is separate from the [Double Slabs crafting tweak](/wiki/crafting-tweaks/#double-slabs).

## Useful next pages

The changed stair and trapdoor recipes are useful when gathering materials for a build:

```recipe
minecraft:oak_stairs
```

```recipe
minecraft:oak_trapdoor
```

- [Crafting tweaks](/wiki/crafting-tweaks/) for better building yields and reclaiming blocks.
- [Chunk loaders](/wiki/chunk-loaders/) for the loadstone feature.
- [Heads & collectibles](/wiki/collectibles/) for mini-block decoration.

## Sources

- [Official Vanilla Tweaks 26.3 descriptions](https://vanillatweaks.net/assets/resources/json/26.3/dpcategories.json): Timber 2.1.22, Fast Leaf Decay 2.0.23, Cauldron Concrete 3.1.2, Cauldron Mud 1.0.11, and More Effective Tools 1.0.12.
- [KleeSlabs — Twelve Iterations](https://mods.twelveiterations.com/minecraft/kleeslabs/).
