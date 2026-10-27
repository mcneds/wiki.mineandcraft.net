# MineAndCraft mapart companion

Server-only Fabric companion for Minecraft **26.3**, Fabric Loader **0.19.5+**, Fabric API **0.163.0+26.3**, and Image2Map **0.15.0+26.3**. Requires Java 25. Clients do not install this companion.

## Build and install

1. Run `npm run test:mapart-server` from the repository root. The Gradle wrapper downloads its pinned distribution and dependencies. Install `build/libs/mineandcraft-mapart-1.3.0.jar` into the Minecraft server's `mods` directory, alongside the pinned Image2Map release and Fabric API.
2. Copy `config.example.json` to `SERVER/config/mineandcraft-mapart.json`. Keep `site_origin` set to the wiki's HTTPS origin. Set `enabled` to `true` when ready to connect.
3. Set `MAPART_BRIDGE_KEY` in the **Minecraft process environment**, matching the Cloudflare secret of that name. Use a random value of 32–256 characters. This is separate from the music-service key. Do not put it in the JSON config, Java command line, logs, or Git. With systemd, use a private `EnvironmentFile`; with PufferPanel, configure the Minecraft process environment rather than the music Python service.
4. Apply migration `0008_mapart.sql` and deploy the updated Worker before starting the companion. Keep the Worker's `MAPART_ENABLED` at `"false"` until the acceptance checks below pass.
5. Back up the world and install the mod during a controlled restart. Check the console for the bridge-start message. The companion then polls outbound HTTPS every 15 seconds. It opens no inbound port and does not use RCON, SSH, or resource-pack rebuilding.

The companion restricts Image2Map's direct commands to permission level 4 and disables local-file imports. Do not give ordinary members permission-plugin overrides for Image2Map creation commands. `/mapart claim CODE` itself requires no operator permission.

## Claims and persistence

Claims require the submitting Discord member's current IGN role and the selected Java UUID or Floodgate XUID. Floodgate identity is obtained from its server API; usernames and prefixes are not used as identity. Website or Discord outages deny claims without taking materials.

Each copy costs one blank map per tile from the main 36-slot inventory, except in creative mode where claims are free in every world. Game mode is checked at delivery time. Close containers before claiming. The companion simulates payment first and requires a free delivery slot after payment. Free creative claims need an empty slot and never consume existing maps. Single maps arrive directly; multiple maps arrive in an included Image2Map placement bundle. Item frames are supplied by the player.

Place a bundle at the top-left of an empty frame grid. The companion validates the complete grid, fixed-frame flags, spawn/build permissions, and Fabric entity-use callbacks before permitting Image2Map placement. Missing or occupied frames retain the bundle. Removing a tile uses normal per-frame item drops, preserving neighboring tiles. Protection integrations must use the standard server/Fabric permission checks; verify the actual protection mods used on your server during acceptance.

`WORLD/mineandcraft-mapart/registry.json` associates artwork with its map IDs. Converted `.pixels` files in the same directory are temporary recovery caches. Map data and its allocator are saved before atomically publishing the registry, and the registry is written before delivering an item. Replacement claims reuse the same IDs. **Back up and restore this directory together with the entire world**, including its saved map data. A damaged registry disables the bridge rather than silently allocating replacement IDs. Do not delete registry entries while their maps are in use.

Deleting artwork removes cloud artifacts and local pixel caches on the next poll, and prevents future claims. Issued map IDs and their world data are retained. Library originals remain under the existing library's ownership and retention rules. Temporary originals are never publicly served; successful conversion deletes them, and the hourly cleanup retries failed deletion or expires unfinished sources after 24 hours. Retained converted pixels and previews are still images of the artwork.

## Before enabling submissions

Temporarily enable `MAPART_ENABLED` for the owner acceptance session, then check the following with both a Java account and a Bedrock/Floodgate account:

- Use a verified player profile with a matching Discord IGN role; test library and temporary sources.
- Compare fit/crop and all alignment directions using a non-square image. Confirm the final map-color preview and tile order.
- Claim a single map and an 8×8 artwork. Verify exact blank-map charges, insufficient materials, full inventory, and a second paid copy.
- Place bundles on walls, floors, and ceilings. A missing, occupied, fixed, or protected frame must leave the bundle intact.
- Restart Minecraft, claim another copy, and confirm the original maps and map IDs remain intact.
- Remove the Discord role and verify a new claim is denied. Delete artwork and verify its code stops working.

Bedrock does not render Java's invisible-frame flag identically; visible frames on Bedrock are a known Geyser limitation. Do not promise matching frame invisibility. If map rendering or bundle placement fails either client check, return `MAPART_ENABLED` to `"false"` until corrected. Existing issued maps remain in the world.

Once these checks pass, keep `MAPART_ENABLED` set to `"true"` in Wrangler vars and deploy. Further artwork conversion and claims run without restarting Minecraft.

## Development checks

Run `npm run test:worker`, `npm run build`, `npx playwright test tests/mapart.spec.ts`, and `npm run test:mapart-server`. Java tests cover layout geometry, source decoding, and payment planning. Run `gradlew.bat runGameTest` from this directory for real creative/survival claim delivery checks; actual packet translation and placement still require the crossplay session above.

Mapart storage defaults to 100 MiB per Discord member, with five unfinished jobs at a time and no saved-artwork count cap. Apply `0011_mapart_storage.sql` when upgrading. An owner can configure `mapart_limits.storage_limit_bytes` and `pending_limit`; the legacy `saved_limit` column is no longer enforced. Storage counts converted pixel data, previews, temporary sources, and reserved writes. Deletion frees space after R2 confirms removal; failed cleanup keeps its charge until retried. Library originals use the separate image-library allowance. Existing R2 objects are measured on first use or scheduled cleanup. Input limits are 5 MiB and 16 × 1024 × 1024 decoded pixels. Animated images use frame zero.

Transparent source pixels and unused fit padding remain transparent during conversion and in PNG previews. The website shows a checkerboard behind transparent areas. Minecraft map colors use the Image2Map transparency conversion rather than a white background. Existing converted artwork keeps its original pixels; create it again from the source to use transparency.

Artwork layouts allow 256 tiles total and up to 64 maps on either side (for example 16 x 16, 32 x 8, or 64 x 4). Both website and companion validate the tile budget. Pixel data is capped at 4 MiB, converted PNG previews at 20 MiB, and source uploads remain 5 MiB. Survival copies cost one blank map per tile, summed across inventory stacks. Upgrade the companion before publishing larger site limits. Do not downgrade below 1.3.0 once larger artworks have been issued: older registries reject more than 64 map IDs.
