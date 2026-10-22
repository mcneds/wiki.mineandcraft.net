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
These recipes come from the actual **VanillaTweaks_c223234_MC26.3.zip** supplied by the owner. Its selection list contains **11 tweaks**, and its recipe files define the inputs and quantities documented below.

## Quick reference

| Tweak | Example input | Output |
| --- | --- | --- |
| Double Slabs | 1 andesite block | 2 andesite slabs |
| Rotten Flesh to Leather | Smelt 1 rotten flesh | 1 leather |
| More Bricks | 4 bricks in a square | 4 brick blocks |
| More Stairs | 6 oak planks in a stair pattern | 8 oak stairs |
| More Trapdoors | 6 oak planks in two full rows | 12 oak trapdoors |
| Craftable Enchanted Golden Apples | Apple surrounded by 8 gold blocks | 1 enchanted golden apple |
| Unpackable Ice | 1 packed ice / 1 blue ice | 9 ice / 9 packed ice |
| Unpackable Wool | 1 wool | 4 string |
| Craftable Gravel | 4 flint in a square | 1 gravel |
| Back to Blocks | 2 matching slabs side by side / 4 matching stairs | 1 / 3 original blocks |
| Powder to Glass | Smelt 1 colored concrete powder | 1 matching stained glass |

The building examples above are representative recipes, not a claim that every block variant has the same recipe. See the [complete recipe reference](/wiki/recipe-reference/) for every definition in the supplied archive.

## Double Slabs

Put a supported full block into the crafting grid on its own to make **two slabs**. For example, one andesite block produces two andesite slabs. This is a shapeless recipe.

This crafting tweak is separate from [KleeSlabs](/wiki/building/#kleeslabs), which changes how double slabs break in the world.

## Rotten Flesh to Leather

Smelt **rotten flesh in a furnace** to get leather. Each input produces one leather. The supplied recipe specifies 200 cooking ticks and 1.0 experience; it does not include a smoker variant.

## More building materials

### More Bricks

Arrange four brick items in a 2×2 square to get **four brick blocks**.

### More Stairs

The familiar six-block stair pattern produces **eight stairs** for the covered recipes. For oak, use six oak planks:

```text
P · ·
P P ·
P P P
```

`P` is an oak plank and `·` is an empty slot.

### More Trapdoors

Two full rows of oak planks produce **12 oak trapdoors**. Other covered wood variants follow the same output. The archive's copper trapdoor recipe is different: **four copper ingots in a square produce one copper trapdoor**.

## Craftable enchanted golden apples

Place an apple in the center of the crafting table and surround it with **eight gold blocks**:

```text
G G G
G A G
G G G
```

`G` is a gold block, not a gold ingot. `A` is an apple. The result is one enchanted golden apple.

## Unpackable Ice

Place one packed ice in the grid to recover **nine ice**. Place one blue ice in the grid to recover **nine packed ice**. Both unpacking recipes are shapeless.

## Unpackable Wool

One wool block produces **four string** in a shapeless recipe. The recipe accepts items in the wool tag.

## Craftable Gravel

Arrange **four flint** in a 2×2 square to craft **one gravel**.

## Back to Blocks

Reclaim full blocks from supported slabs and stairs:

- Place **two matching slabs side by side** to make one original block.
- Place **four matching stairs** anywhere in the grid to make three original blocks.

For example, two oak slabs produce one oak plank block. Four brick stairs produce three brick blocks.

## Powder to Glass

Smelt colored concrete powder in a furnace to get the **same color of stained glass**. One white concrete powder, for example, produces one white stained glass. The recipe specifies 200 cooking ticks and 0.1 experience.

## What is not in this bundle?

The supplied selection screenshot showed **Craftable Horse Armor**, but the actual ZIP has no horse armor recipe. It is therefore not listed as an available recipe here. If it is installed separately, the owner can add it after checking that pack.

## Sources

Recipe definitions and `Selected Packs.txt` inside the owner-supplied `VanillaTweaks_c223234_MC26.3.zip`. [Vanilla Tweaks](https://vanillatweaks.net/) is the original pack author. The [recipe reference](/wiki/recipe-reference/) records the archive paths so these instructions can be checked against the installed files.
