---
title: "Crafting tweaks"
description: "The 11 crafting tweaks in the server's Vanilla Tweaks bundle, with ingredients and outputs."
category: "Crafting"
updated: "2026-10-22"
facts:
  - label: "Pack"
    value: "Vanilla Tweaks Crafting Tweaks"
  - label: "Minecraft version"
    value: "26.3"
  - label: "Selected tweaks"
    value: "11"
  - label: "Recipe definitions"
    value: "409"
---
[All recipes and block variants](/wiki/recipe-reference/).

## Double Slabs

Put a supported full block into the crafting grid on its own to make **two slabs**. For example, one andesite block produces two andesite slabs. This is a shapeless recipe.

```recipe
minecraft:slabs/andesite_slab
```

This crafting tweak is separate from [KleeSlabs](/wiki/building/#kleeslabs), which changes how double slabs break in the world.

## Rotten Flesh to Leather

Smelt **rotten flesh in a furnace** to get leather.

```recipe
rotten_flesh_to_leather:leather
```

## More building materials

### More Bricks

Arrange four brick items in a 2×2 square to get **four brick blocks**.

```recipe
minecraft:bricks
```

### More Stairs

Use the normal stair pattern to make **eight stairs** from six blocks.

```recipe
minecraft:oak_stairs
```

### More Trapdoors

Two full rows of oak planks produce **12 oak trapdoors**. Other covered wood variants follow the same output. The archive's copper trapdoor recipe is different: **four copper ingots in a square produce one copper trapdoor**.

```recipe
minecraft:oak_trapdoor
```

```recipe
minecraft:copper_trapdoor
```

## Craftable enchanted golden apples

Place an apple in the center of the crafting table and surround it with **eight gold blocks**:

```recipe
craftable_notch_apples:notch_apple
```

## Unpackable Ice

Place one packed ice in the grid to recover **nine ice**. Place one blue ice in the grid to recover **nine packed ice**. Both unpacking recipes are shapeless.

```recipe
uncraftable_ice:ice
```

```recipe
uncraftable_ice:packed_ice
```

## Unpackable Wool

One wool block produces **four string** in a shapeless recipe. The recipe accepts items in the wool tag.

```recipe
wool_to_string:string
```

## Craftable Gravel

Arrange **four flint** in a 2×2 square to craft **one gravel**.

```recipe
flint_to_gravel:gravel
```

## Back to Blocks

Reclaim full blocks from supported slabs and stairs:

- Place **two matching slabs side by side** to make one original block.
- Place **four matching stairs** anywhere in the grid to make three original blocks.

For example, two oak slabs produce one oak plank block. Four brick stairs produce three brick blocks.

```recipe
slabs_stairs_to_block:slabs/oak_planks
```

```recipe
slabs_stairs_to_block:stairs/bricks
```

## Powder to Glass

Smelt colored concrete powder in a furnace to get the **same color of stained glass**.

```recipe
powder_to_glass:white_stained_glass
```

## What is not in this bundle?

The supplied selection screenshot showed **Craftable Horse Armor**, but the actual ZIP has no horse armor recipe. It is therefore not listed as an available recipe here. If it is installed separately, the owner can add it after checking that pack.

## Sources

Recipe definitions and `Selected Packs.txt` inside the owner-supplied `VanillaTweaks_c223234_MC26.3.zip`. [Vanilla Tweaks](https://vanillatweaks.net/) is the original pack author. The [recipe reference](/wiki/recipe-reference/) records the archive paths so these instructions can be checked against the installed files.
