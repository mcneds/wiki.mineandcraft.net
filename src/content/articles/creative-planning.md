---
title: "Creative planning"
description: "Create a private creative project, invite friends, and teleport within its Overworld, Nether, and End. One project per user."
category: "Guides"
updated: "2026-10-24"
facts:
  - label: "Mod"
    value: "Plan"
  - label: "World limit"
    value: "1 per user"
  - label: "Menu"
    value: "/plan"
---
**Plan** gives you a private creative world, called a **project**, for testing builds. No client installation is needed.

## Your world

**The server allows one project world per user.** Rejoin yours to continue building.

Open `/plan`, then look at a menu button and click. Or create your world with either command:

```text
/plan create superflat MyBuild
/plan create regular MyBuild
```

Choose one: creation takes you into the project.

| Action | Command |
| --- | --- |
| Rejoin your last project | `/plan join` |
| Return to your previous survival location and inventory | `/plan leave` |
| Set the project's arrival point | `/plan setspawn` |

Creative items stay in the project. Your build is saved when the empty world unloads.

## Teleport within your project

Use `/ptp` while inside a Plan project. **You can teleport only within that project's Overworld, Nether, and End.** You cannot use it to reach survival worlds or another project.

| Action | Command |
| --- | --- |
| Teleport to coordinates in your current dimension | `/ptp 100 80 -200` |
| Move relative to your current position | `/ptp ~10 ~ ~-5` |
| Move 10 blocks in the direction you are facing | `/ptp ^ ^ ^10` |
| Teleport to the project's Overworld | `/ptp in overworld 100 80 -200` |
| Teleport to the project's Nether | `/ptp in nether 10 80 -20` |
| Teleport to the project's End | `/ptp in end 10 80 -20` |
| Teleport to an online player in the same project | `/ptp player PlayerName` |
| Teleport to a matching player using a selector | `/ptp player @p[tag=builder]` |
| Move yourself up 10 blocks using a selector | `/ptp @s ~ ~10 ~` |
| Bring all players in your project to you | `/ptp @a @s` |
| Move nearby cows to you | `/ptp @e[type=cow,distance=..20] ~ ~ ~` |

Replace the example coordinates or player name with your destination. Quote names containing spaces, for example `/ptp player ".Bedrock Name"`. `/ptp player ...` moves only you. `/ptp <targets> <coordinates or destination>` moves the selected targets.

Selectors such as `@s`, `@p`, `@r`, `@a`, and `@e` match only entities in your current project. Filters such as `type`, `tag`, `distance`, and `limit` work too. A destination must match exactly one entity: for example, `/ptp @e[type=cow,sort=nearest,limit=1]` takes you to the nearest cow in the project. Players can move between the project's dimensions; mobs and other non-player entities can teleport only within their current dimension.

**Guests can use these commands too, without operator status.** Join through Plan's normal invite or whitelist controls first. Player suggestions include only eligible players in the same project.

Coordinates are block positions: you arrive at the block's center horizontally. Changing dimensions uses the coordinates you enter, with no automatic Nether scaling. Choose a clear landing spot—the command checks the world border and build height but does not avoid solid blocks or lava. Nether and End travel is available only while those dimensions are enabled in Plan.

## Summon entities

Use `/psummon <entity> [x y z]` to summon an entity in your current project dimension. Guests can use it too, without operator status.

| Action | Command |
| --- | --- |
| Summon a cow at your position | `/psummon minecraft:cow` |
| Summon an armor stand two blocks along the Z axis | `/psummon minecraft:armor_stand ~ ~ ~2` |
| Summon a pig at coordinates | `/psummon minecraft:pig 100 80 -200` |

Omit coordinates to use your current position. Summoning works only inside a Plan project, respects the world border and build height, and does not accept entity NBT data.

## Save and paste schematics

**When pasting a schematic with Litematica, change Litematica's paste method to WorldEdit mode first.**

Your schematic library is private: lists and filename suggestions show only your own schematics. You can only load, overwrite, or delete your own files. Different players can use the same schematic name.

| Action | Command |
| --- | --- |
| Copy your WorldEdit selection | `//copy` |
| Save your clipboard as `test` | `//schem save test` |
| Replace your existing `test` schematic | `//schem save -f test` |
| List your schematics | `//schem list` |
| Load your `test` schematic into the clipboard | `//schem load test` |
| Paste the clipboard | `//paste` |
| Delete your `test` schematic | `//schem delete test` |

Replace `test` with your schematic's name. To paste a saved build, load it first, then use `//paste`.

## Build together

| Access | Command |
| --- | --- |
| Invite for one visit | `/plan invite PlayerName` |
| Allow future visits | `/plan whitelist PlayerName` |
| Remove access | `/plan revoke PlayerName` |

Replace `PlayerName` with your friend's name. The owner controls Plan's built-in guest commands and gamemode through the menu. The server separately enables `/ptp` and `/psummon` for project guests.

## Sources

- [Plan documentation](https://modrinth.com/mod/planned).
- One-world limit supplied by the server owner.
- Project teleport and summon commands supplied by the server's Plan Tools companion, installed and verified on 24 October 2026.
- Private schematic libraries supplied by Plan Tools 1.2.0; the Litematica paste-method requirement was supplied by the server owner.
