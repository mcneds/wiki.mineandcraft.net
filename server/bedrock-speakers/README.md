# Copper Speakers on Bedrock

Compatibility work for Copper Speakers 0.2.0 with the local socket-face patch, Geyser-Fabric 2.12.1-b1273 and Bedrock 1.26.60 (protocol 2225). This uses Geyser internals and must be recompiled and checked when Geyser changes. The separate [socket-face patch](copper-speakers-patches/README.md) restricts both wire branches and audio routes to the two wall-plate sockets on Java and Bedrock.

## Current support

Bedrock players need to accept the server resource packs; no client mod is required. Speaker range extension, including custom music, has been confirmed in game on both Java and Bedrock. Wire, resin, wall-plate and speaker-note rendering use generated Bedrock assets and a patched display bridge. The operator subsequently reported that Bedrock sources are not synchronized; relative playback timing is under investigation. Automated startup and codec tests do not measure client audio timing.

| Component | Tested version |
| --- | --- |
| Minecraft Java / Fabric Loader / Java runtime | 26.3 / 0.19.5 / 25 |
| Polymer | 0.18.4 |
| Copper Speakers | `0.2.1+mineandcraft.1` (socket-face patch) |
| Geyser-Fabric | `2.12.1-b1273`, commit `a24ba9c` |
| Bedrock | 26.60, protocol 2225 |
| Copper visual pack / display pack | 1.2.1 / 1.2.1 |

This is a separate server compatibility bundle. Installing the Java mod or stock GeyserDisplayEntity alone is insufficient. Both extension jars, both matching visual packs and the generated mappings are required. Keep the existing music pack for custom songs. Rebuild and retest the integration when Geyser internals, Bedrock protocol, or Polymer model/carrier allocations change.

## Implementation

`CopperBedrock` translates the mod's entity-bound speaker recordings into Bedrock sound handles. Prepared tail events are mapped to the original recording plus Bedrock's playback offset, so Bedrock does not need the large Java tail packs. Moving a parked spare voice starts it at the elapsed song position; deleting a voice stops its handle. The extension also supplies the missing `StopSoundData` event when stopping records: the stock b1273 packet has a null event and crashes the 2225 serializer. Other Bedrock protocols retain Geyser's translators.

Java `MARKER` spawn packets are retained as audio positions without spawning a Bedrock actor. Stock b1273 has no marker entity factory and throws when asked to spawn these anchors; the extension handles the marker before Geyser's entity translator.

Minecraft 26.3 anchor movement can contain steps and a null end position. The extension uses the last step, ignores empty or unchanged movement, and retains a separate sound handle and playback clock for every anchor. The previous null dereference was observed in the live log when spare voices moved to their sources. `/copperbedrock voices` shows each Bedrock listener's translated entity voices, playing/parked state, position, sound, and handle; use it while a record plays to verify that the jukebox and connected speakers are represented separately.

`convert_visuals.py` converts the exact live Polymer pack's Copper Speakers carrier states and cuboid models into Bedrock geometry, an atlas, inventory icons, and Geyser JSON mappings. It uses original textures from the mod and the Minecraft 26.3 client jar. The 0.2.0 release omits the referenced speaker-note PNG, so those eight tinted sprites use Minecraft's note particle silhouette. Rebuild after a mod change reallocates Polymer carrier states. Increment the visual pack's version if its contents change.

Item displays additionally require [GeyserDisplayEntity](https://github.com/GeyserExtensionists/GeyserDisplayEntity). Source is pinned to `847d7a9a08b49b503c9d4e828de8e3dc7eb384e9`. `build_display.py` recompiles that source with Fabric's relocated protocol namespace and the release jar's relocated Configurate dependency. Its original source archive, release jar, pack, and provenance are retained on the server. Upstream is AGPL-3.0; preserve its license and provide its corresponding source when distributing the built extension.

The visual revision 1.1.0 reflects Java model X coordinates, converts block rotations and upper/lower UVs, and gives the empty resin carrier a valid transparent block material. These coordinate conventions follow [Rainbow's geometry mapping](https://github.com/GeyserMC/Rainbow/blob/master/rainbow/src/main/java/org/geysermc/rainbow/mapping/geometry/GeometryMapper.java). Asymmetric endpoints are covered by regression tests.

`patch_display.py` and `display-native-methods.java.inc` add a Copper-specific native mesh path to the pinned display bridge. `display-models.json` supplies the same model indices to the extension and resource pack. This avoids armor-slot offsets, keeps the Java item-display origin and scale, and cancels Java's item-renderer half-turn. Other display identifiers retain upstream rendering. The eight notes use short-lived Bedrock billboard particles instead of armor attachables. `CopperFrameEntity` replaces only frames holding `copperbedrock:wall_plate` with a plate mesh, retaining the Java entity ID and ordinary frame behavior for all other items, including maps. Both visual packs must be installed together.

## Build and install

Build from this directory on the Linux server against its installed Geyser jar. Python 3 and a JDK are required; the deployed build uses JDK 24 and emits Java 21 extension classes. The Minecraft server itself requires Java 25. The build reads the existing prepared-audio catalogue at `config/copper-speakers/tails/catalog.json`.

```sh
python3 build.py --server /var/lib/pufferpanel/servers/1fc61e68 --output /home/ubuntu/copper-bedrock/build --javac /usr/lib/jvm/temurin-24-jdk-arm64/bin/javac
```

This also runs `ProtocolSmoke` against the installed codec. It reproduces the original stop-packet error, verifies corrected stops and sound handles, round-trips playback offsets, and checks that moved voices retain elapsed playback time.

After generating visuals, rebuild the display bridge with `--display-models /home/ubuntu/copper-bedrock/display-models.json` in addition to its source ZIP, release jar, classpath file, output directory, and compiler arguments. The generated indices and the bridge must match. `smoke_bundle.py --stage /home/ubuntu/copper-bedrock` recompiles an isolated Standalone copy and checks registration without touching the running server. It binds only to loopback port 29132 and stops its process when finished.

Generate visuals on a computer with Python, Pillow and the Minecraft client jar. `java-visuals.zip` must contain the exact generated Polymer Copper Speakers models, textures, item definitions and carrier states; do not substitute assets from a different allocation. The `--icons` directory contains the project's existing inventory images.

```sh
python convert_visuals.py --java-pack java-visuals.zip --client-jar minecraft-client.jar --output output --icons ../../public/images/items
python -m unittest discover -s . -p test_visuals.py
```

Install the two Fabric-compatible extension jars in Geyser's `extensions`, the converted visual pack and upstream `GeyserDisplayEntityPack.mcpack` in `packs`, and both generated mapping JSON files in `custom_mappings`. Keep the existing music pack: the audio extension references its original sound events. Restart during an empty-server window; mappings and extensions need startup registration. Back up replaced files and remove only these compatibility files to roll back.

The prepared-audio event table is embedded from `config/copper-speakers/tails/catalog.json` at build time. Rebuild the extension after that catalogue changes. Bedrock audio timing, visual transforms, wire steps, plates, range entry, attachment, and stopping require in-game verification; successful codec or startup tests do not prove client rendering or audibility.

The deployment scripts and isolated smoke harness contain mineandcraft's server paths, PufferPanel integration and staging layout. They are operational helpers for this installation, rather than general-purpose installers. For another server, use the build outputs and installation paths above, with that server's backup and restart procedure.

## Verification and deployment history

The entries below record each deployment's state at that time. The current status is summarized above; the final restart activates the permanent fixes without the temporary diagnostic hooks.

Installed on the live server on 27 October 2026. Startup at 19:11 UTC confirmed both extensions, 236 block overrides, 44 custom items, two custom entities, and 1,684 prepared-audio event mappings. The pre-install state is backed up in `/home/ubuntu/copper-bedrock/backup-20261027-191001`. Client verification is pending. The deployment helper defaults to waiting for an empty server; `--restart-occupied` is reserved for an authorized restart that disconnects current players.

Revision 1.1.0 adds a third custom entity for wall plates. Local geometry/pack regression tests, the installed Fabric codec tests (including stepped movement), and isolated Geyser startup pass. Installed and restarted at 19:41:49 UTC on 27 October 2026, with all six deployed files matching their staged hashes. Backup: `/home/ubuntu/copper-bedrock/backup-20261027-194041`. The regenerated Polymer model/carrier inputs are unchanged. Both visual packs are version 1.1.0; the working music pack stays at 2.3.0. The live voices command works and reported zero listeners before a client rejoined. In-game rendering and simultaneous audio still require Bedrock verification; startup does not prove either.

Revision 1.2.0 preserves `mineandcraft_music:buffered.*` rather than replacing it with the streaming event. Prepared sounds also use buffered events. Vanilla record aliases reference the original audio paths from [Mojang's Bedrock samples](https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/sounds/sound_definitions.json), copied in `bedrock-records.json`; the converter makes those aliases non-streaming. The user confirmed speaker range extension on both clients after the 20:13:38 UTC restart. Backup: `/home/ubuntu/copper-bedrock/backup-20261027-201224`. Java playback was unchanged; the apparent Java silence was its muted record volume.

The 1.2 visual pack replaces the missing `geometry.full_block` reference with an explicitly packaged invisible mesh. Block defaults use custom thin geometry, and held items use icons rather than unbound meshes. The display bridge keeps the source item's yaw; its previous extra half-turn was observed as Java -180 becoming Bedrock 0 in a live snapshot. The GeyserDisplayEntity pack is now 1.2.1: invalid property aliases and the old interpolation expression are removed, and empty `scripts.initialize` / `scripts.pre_animation` keys are omitted because the actual Bedrock client rejects empty lists. Pack-only hotfix backup: `/home/ubuntu/copper-bedrock/hotfix-20261027-202826`.

`VoxelSupport` repairs only an entirely empty protocol-2225 `VoxelShapesPacket`, supplying the vanilla empty/unit-cube shapes before `StartGame`. Geyser b1273 sends an empty registry; the client log showed missing unit-cube and invalid empty handles. The repair round-trips through the installed codec. It is installed as an outbound hook and preserves nonempty registries. During diagnosis it was activated without restarting Java; a full Bedrock restart and rejoin produced no further voxel registry errors. The corrected extension jar is also persisted for the next server restart.

Diagnostics under `tools/` use the local JVM attach API because the live server has no JDWP session. `LiveSnapshot` reads Geyser state on its event loop and Java network state on the server thread. `DisplayTrace` keeps bounded, read-only observations of outgoing display packets; `TraceControl` reads or clears only that temporary buffer. They do not edit world blocks. The live content log is under `%APPDATA%/Minecraft Bedrock/logs/`; compare new sessions/timestamps rather than treating older errors as current. The client script debugger settings are unrelated to the Java-backed server and JSON resource-pack rendering.

The fresh client log from 21:34 local time contains no Copper display-pack or voxel errors. The outgoing trace shows riser/resin model indices 1–35, unit scale and `INVISIBLE=false`; the latest screenshots show these meshes drawing. Wall-plate spawning additionally needs coherent yaw, head rotation and body rotation. The old manual packet set only yaw, leaving the other rotations at zero. `CopperFrameEntity.spawnPacket` now sets all three; the codec regression checks all four horizontal faces. `RepairPlateRotation` applies the same correction to current actors and new spawns while the existing JVM remains running; the corrected jar is persisted for the next normal restart. Client confirmation of all plate faces is pending.

At 20:59:04 UTC, the server restarted successfully with Copper Speakers `0.2.1+mineandcraft.1` and the socket-face restriction requested by the user. All 45 Minecraft tests and four graph tests passed before installation. Backup: `/home/ubuntu/copper-bedrock/socket-faces-backup-20261027-205749`; receipt: `/home/ubuntu/copper-bedrock/socket-faces-install.json`. Regenerated Polymer inputs match all 105 previous input entries semantically (95 JSON files differ only in formatting). Startup confirmed 236 block overrides, 44 items, three custom entities and 1,684 prepared sound events. The normal restart activates the persisted voxel and plate-rotation fixes and removes the temporary diagnostic hooks. After this deployment, the server operator confirmed that Bedrock functionality had reached parity with Java on the tested setup.

Visual pack 1.2.1 corrects the speaker block front by 180 degrees in all four carrier orientations. Only those four speaker mappings change; wire/display and wall-plate rotations retain their own paths. Three geometry/pack regression tests pass. Installed at 21:36:17 UTC on 27 October 2026; backup: `/home/ubuntu/copper-bedrock/speaker-facing-fix/backup-20261027-213511`. The operator confirmed that the speakers now face correctly. This deployment does not change audio timing.
