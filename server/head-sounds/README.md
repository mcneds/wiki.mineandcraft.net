# Player-head sounds

Server-only companion for Minecraft Java 26.3, Fabric Loader 0.19.5+, Fabric API 0.163.0+26.3, and Java 25. Clients need the existing server resource pack, without a client mod.

The website resolves an IGN to a canonical Java UUID or Bedrock XUID/Floodgate UUID. The music bridge generates `data/mineandcraft_music/head_sounds/catalog.json` alongside the existing audio packs. The companion reads that snapshot at startup and successful datapack reload, and substitutes its sound when a matching head is used above a note block. No world scanning or per-head rewriting is needed. UUID identity survives name and skin changes; texture-only decorative heads are not matched by appearance.

The live server whitelist protects heads immediately, even between bridge polls. An outsider's mapping is silent once its target becomes whitelisted. Verified-owner mappings remain allowed. Managed head items with an obsolete or unauthorized sound component cannot bypass this check. Unrelated native head sounds retain normal behavior.

The generated `/trigger mac_heads set <code>` gives one head and enforces a 100-tick cooldown. Claims check live whitelist-derived allow flags maintained by the companion. Java claims use a dynamic UUID-only profile so Minecraft resolves the current skin; Bedrock claims carry the Geyser skin texture. Both use the native `minecraft:note_block_sound` component. The mapping also applies to existing heads with the same account UUID.

## Build and verify

Run `gradlew.bat build runGameTest` on Windows or `./gradlew build runGameTest` elsewhere. Python must be on PATH: GameTests generate their datapack with the production music pack generator, then exercise real claims, cooldowns, head-profile parsing, existing-head lookup, and whitelist protection. JUnit tests cover snapshot validation and identity policy. Build output is `build/libs/mineandcraft-head-sounds-1.0.0.jar`.

The Geyser companion in `../bedrock-speakers` translates the head-effect sound namespace to Bedrock position/volume/pitch packets. Rebuild that extension against the **installed** Geyser jar and prepared-audio catalogue using its existing `build.py` workflow. A build against an empty test-server directory is suitable for compilation checks only; it does not contain production's prepared-audio event table.

## Installation order

1. Apply `migrations/0013_head_sounds.sql` to D1 and deploy the matching Worker/site. The migration defaults existing music rows to discs and retains their existing storage and approval behavior. Until whitelist reports arrive, head submissions fail closed.
2. Install the updated `music-server.py` and `music-panel-refresh.py` together. Set an absolute `whitelist_file` path in the existing music service config. Leave `heads_enabled` false while staging.
3. Install this companion and the rebuilt Geyser extension during the next empty-server restart. Preserve backups of the previous extension and music packs.
4. Set `heads_enabled` true and restart the music bridge service. It reports whitelist snapshots on polling and heartbeat cycles and validates pending head uploads before approval. No additional network port or credential is needed.
5. Submit and approve a short effect. Delivery uses the existing empty-server window and transactional pack rollback. The refresh helper requires the companion's `head_release` marker to match the generated release before acknowledging success.

Verify a claimed head and an already placed matching head using manual and redstone activation on Java and Bedrock after reconnecting and accepting packs. Automated packet and GameTests do not prove client audibility. Check an unrelated decorative head and protect a formerly non-whitelisted target to confirm the outsider's sound stops.

For rollback, stop head publishing, restore the previous matching packs/companion/extension, and retain the additive D1 tables. Do not run an old pack generator against an active head catalogue. The existing bridge restores pack files together when installation verification fails.
