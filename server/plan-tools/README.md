# MineAndCraft Plan Tools

Server-side Fabric companion for **Minecraft 26.3, Java 25, Fabric API, Plan 15, and WorldEdit 7.4.6**. It adds teleporting and entity summoning within the caller's active Plan project, plus private WorldEdit schematic libraries for every player. Vanilla clients can use it. Vanilla command permissions are not changed.

## Install

Build with Java 25:

```powershell
cd server/plan-tools
./gradlew.bat build
```

On Linux/macOS use `sh ./gradlew build`. Copy `build/libs/mineandcraft-plan-tools-1.2.0.jar` into the Minecraft server's `mods/` directory alongside Plan, WorldEdit and Fabric API, remove the previous Plan Tools JAR if present, then restart the server. Do not install the `-sources.jar`.

The dependency is pinned to the [Plan 15 Fabric 26.3 release](https://modrinth.com/mod/planned/version/MUnIgib6). Plan is downloaded as a build/runtime dependency, **not bundled** into this mod. The loader rejects unsupported Plan versions; validate the adapter before changing this pin. The mod does not require client installation or operator status for teleporting.

## Commands

### Private schematics

Use WorldEdit's existing `//copy`, `//schem save test`, `//schem list`, `//schem load test`, and `//schem delete test` commands. Every player has an independent library keyed by their Minecraft UUID. Two players can both save `test`; lists and filename completion show only the caller's files. Saving with `-f`, loading, and deleting also stay within that library. Guests and operators use their own libraries, including outside Plan projects, so leaving a project cannot bypass isolation. Existing WorldEdit command permissions still apply. The standard `/schematic`, `/schem`, `//schematic`, and `//schem` aliases all reach the same scoped handlers.

Libraries live under WorldEdit's configured schematic root at `.players/<uuid>/`. Names, project ownership and invites never grant access to another UUID. Java and Bedrock identities retain their respective server UUIDs. Subdirectories are supported; absolute paths, traversal, and symlinks are rejected. The normal `share` command still explicitly shares the caller's current clipboard online; it does not browse stored files. Server console has no personal library; administrators can manage files on disk.

Existing shared schematics are **not automatically claimed or exposed**. Stop the server, back up the schematic folder, and move files with verified owners into `.players/<uuid>/`, preserving filenames and file ownership. Do not overwrite an existing destination. Restart after installing the mod. Unassigned files can remain at the old root for an administrator to resolve later.

This integration pins WorldEdit's Fabric 7.4.6 artifact (`ByRNkO83`). Two required mixins scope its save/load/delete file resolution, list output, argument conversion and suggestions. Missing injection targets fail startup instead of falling back to shared access. Revalidate the mixins and game tests before updating WorldEdit. Privacy is enforced independently of the teleport/summon settings.

Release 1.2.0 activated on the VPS on 24 October 2026 at 20:09 UTC after an empty-server restart. The verified `test.schem` save now belongs to uAiden's UUID library; its bytes are unchanged and the old shared copy is removed. The old JAR and schematic directory are backed up at `/var/backups/mineandcraft-plan-tools/20261024T200839Z-private-schematics`. `/opt/mineandcraft-plan-tools/releases/1.2.0/complete.json` records successful activation and the release/file hashes. The Linux release-JAR symlink checks and all three isolated Fabric game tests passed before deployment.

### Project commands

| Command | Result |
| --- | --- |
| `/ptp 100 80 -200` | Move yourself within your current project dimension |
| `/ptp ~10 ~ ~-5` | Move relative to your actual player position |
| `/ptp ^ ^ ^10` | Move relative to your facing direction |
| `/ptp in overworld 100 80 -200` | Move to your current project's main world |
| `/ptp in nether 10 80 -20` | Move to your current project's Nether |
| `/ptp in end 10 80 -20` | Move to your current project's End |
| `/ptp player PlayerName` | Move yourself to an online player in the same project |
| `/ptp player ".Bedrock Name"` | Quote player names containing spaces |
| `/ptp player @p[tag=builder]` | Move yourself to one matching project player |
| `/ptp @e[type=cow,limit=1,sort=nearest]` | Move yourself to one matching project entity |
| `/ptp @s ~ ~10 ~` | Move yourself using a selector |
| `/ptp @a 100 80 -200` | Move all selected project players to coordinates |
| `/ptp @a in end 10 80 -20` | Move project players into the project's End |
| `/ptp @e[type=cow,distance=..20] ~ ~ ~` | Move nearby cows to you in the current dimension |
| `/ptp @a @s` | Bring project players to you |
| `/psummon minecraft:cow` | Summon a cow at your current position |
| `/psummon minecraft:armor_stand ~ ~ ~2` | Summon an entity at absolute or relative coordinates |
| `/plantools reload` | Reload this mod's settings; requires vanilla admin permission (level 3) or console |

Coordinates are **block coordinates**: Plan's managed teleport API lands at the block's X/Z centre, keeps your facing direction, and resets velocity. Player targeting likewise uses the target's block position. Absolute coordinates must be integers; `~` and `^` use Minecraft's block-position argument syntax. Coordinates are not multiplied/divided by eight when changing dimensions. Relative coordinates always resolve from the caller, including when wrapped by `/execute`.

Selectors (`@s`, `@p`, `@r`, `@a`, `@e`, and vanilla filters) are scoped to the caller's project before sorting and limiting results. Direct names/UUIDs are checked too. A destination must resolve to exactly one entity; add `limit=1` when needed. `/ptp player ...` accepts only player destinations. Without explicit targets only the caller moves; with targets, all matches move. Permission and scope checks finish for the whole batch before movement begins. A runtime teleport failure can still leave earlier targets moved.

Players may cross the project's dimensions. Plan blocks cross-dimension travel for non-player entities, so mob/entity moves must remain in their existing dimension. Such requests are rejected before moving the batch. Vanilla distance/box selector filters remain dimension-local. Arbitrary dimension IDs and project IDs are not accepted. Nether/End destinations obey Plan's global enable settings. Destination loading uses Plan's normal world limit and loading lifecycle. No teleport grants entry to a project: use Plan's existing join/invite controls first.

`/psummon <entity> [x y z]` summons one entity in the caller's actual current project dimension, even under a redirected `/execute` source. It accepts fractional, relative, and local coordinates. Entity NBT/passenger data is not supported. Normal Minecraft summonability, difficulty and world-border/build-height restrictions apply.

The command checks world borders and build height but does not find safe ground or avoid solid blocks/lava. Choose a suitable destination, as with a normal coordinate teleport.

## Settings

First startup creates `config/mineandcraft-plan-tools.json`:

```json
{
  "enabled": true,
  "allowGuests": true,
  "coordinates": true,
  "players": true,
  "crossDimension": true,
  "summon": true
}
```

`enabled` controls all project commands. `allowGuests` permits anyone with an active session in that project, including temporary invitees; set it to `false` for owner-only teleporting and summoning. This is separate from Plan's built-in guest command menu. `coordinates` controls coordinate teleports, while `players` controls teleports to a destination entity (including player targets). `crossDimension: false` restricts teleports to the caller's current dimension. `summon` independently enables `/psummon`. Older configs without `summon` default to `true`; unknown keys or non-boolean values are errors.

Use `/plantools reload` after editing. A failed reload retains the previous settings. Invalid configuration at startup stops initialization rather than granting access under fallback settings. No setting or operator exemption bypasses project isolation in `/ptp`. Operators with existing vanilla commands retain those separate permissions.

## Extending the mod

The code separates command syntax, project integration, and authorization:

| Location | Responsibility |
| --- | --- |
| `command/TeleportCommands.java` | Brigadier syntax, suggestions, messages; forwards to the service |
| `command/ProjectSelectors.java` | Project-filtered vanilla selector parsing and resolution |
| `command/EntityTeleports.java` | Batch validation and entity movement |
| `command/SummonCommands.java`, `entity/ProjectSummoner.java` | Summon syntax and project-scoped entity creation |
| `core/TeleportService.java` | Authorization before world loading; revalidation immediately before moving |
| `core/ProjectAccess.java` | Platform boundary for sessions, worlds, positions, and managed teleporting |
| `plan/PlanProjectAccess.java` | All Plan-specific calls; verifies live session UUID against actual dimension's project UUID |
| `core/TeleportRule.java` | Additional restrictions without weakening project isolation |
| `ToolsConfig.java` | Validated configuration with atomic reload |
| `PlanTools.java` | Composition and command registration |

For another restriction, implement `TeleportRule` and add it to the list passed to `TeleportService` in `PlanTools`. Example:

```java
TeleportRule noGuestEnd = context ->
        !context.caller().owner()
        && context.destination().dimension() == ProjectWorld.Dimension.END
        ? Optional.of("Only the owner can teleport into the project's End.")
        : Optional.empty();
```

Rules must be pure: they run during suggestions, before destination loading, and again before execution. They may reject a request; they cannot allow a different project or a survival destination. For cooldowns, costs, or other stateful changes, add explicit success handling to the service rather than mutating state inside a rule.

To add an alias or another teleport entry point, call the existing service. For a different project command, reuse `ProjectAccess` to resolve the active project and keep that command's policy in its own service. Plan integration uses its public Java methods rather than reflection, private-field mixins, or world-name guesses. Those methods are not a versioned compatibility API, so the exact dependency pin is intentional.

## Validation

```powershell
./gradlew.bat build
./gradlew.bat runGameTest
```

JUnit tests cover all nine dimension routes for coordinates and player targets, project isolation, guests, settings, custom rules, stale sessions, world-load failures, and bounds. The Fabric game test starts an isolated Minecraft server with the real Plan mod. It exercises non-op selectors, filtering before selector limits, bulk player and mob movement, entity summoning, redirected command sources, and survival position/inventory restoration after `/plan leave`. Game-test sources are separate and are not shipped in the release JAR. The test task uses a disposable local world and accepts the Minecraft EULA through Loom's test configuration.

Schematic unit tests cover persistent UUID separation, duplicate names, traversal, subdirectories and symlink rejection (the symlink case requires OS permission to create links). The WorldEdit game test saves different blocks under the same filename for two mock players, checks private list/completion/conversion, rejects direct cross-library load/delete/overwrite, loads the caller's file, and verifies deleting it preserves the other player's file.

Before enabling this on the live server, check it with the full installed mod set: invite a second account, teleport between project dimensions, confirm another project/survival target is rejected, and leave/rejoin with distinct survival/project inventories. Check private schematic lists and filename completion with two real clients too. The isolated game test does not cover interactions with every other server mod.
