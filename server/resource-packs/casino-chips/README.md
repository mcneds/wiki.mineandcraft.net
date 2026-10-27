# Casino chips

Java resource-pack assets from the supplied `Casino Chips Example.zip`. Installed into the live server's `polymer/source_assets/assets` on 26 October 2026. Polymer includes them in the combined server pack; players reconnect and accept that pack to load the textures.

The original 13 asset files are unchanged. The standalone `pack.mcmeta` uses Minecraft 26.3's `[97, 1]` format bounds, and the ZIP's extra enclosing directory is removed. Only `assets/` was copied to the server, preserving Polymer's generated metadata.

## Book matching

The pack changes the appearance of written books whose complete `minecraft:written_book_content` component matches the supplied example:

- Author: `APokeFish` (case sensitive).
- Title: `5 Chip`, `25 Chip`, `100 Chip`, `500 Chip`, `2500 Chip`, or `10000 Chip`.
- Pages: one empty text page (`[{"text":""}]`).
- Generation: `1` (copy of original).
- Resolved: `true`.

Other written books use the vanilla model. These are visual assets only; they do not issue items or add casino mechanics. The supplied pack is Java-only; no Bedrock conversion is included. Client rendering still needs an in-game check.

## Installation and verification

Copy this directory's `assets/` contents into `SERVER/polymer/source_assets/assets/`, checking for existing files before replacing anything. Keep other namespaces and assets intact. Run `polymer generate-pack` in the server console, wait for the successful generation message, then verify the generated ZIP and its hosted download. This does not require a Minecraft restart. See [Polymer's custom asset documentation](https://polymer.pb4.eu/latest/user/resource-pack-custom-assets/) and [command reference](https://github.com/Patbox/polymer#commands).

The live installation used `/var/lib/pufferpanel/servers/1fc61e68/polymer/source_assets`. Verification confirmed all 13 added assets, byte-for-byte preservation of all 133 previous pack files, and a successful public HTTP download with the expected SHA-1. Minecraft remained running throughout.

- Installed: `2026-10-26T22:08:07Z`.
- Previous pack, imported ZIP, added-file list, and installation receipt: `/var/backups/mineandcraft-casino-chips/20261026T220803Z`.
- Combined pack SHA-1 at installation: `61c34fb7d5d39a9cd06eeb3c3eb394a567cf33c9`.
- Original supplied ZIP SHA-256: `603bf7f777a11a2a592e13bd3f617fc600515dfe4fa6f4fd4f900e46d241f72d`.

To roll back, remove only the 13 paths recorded in the backup's `added-paths.json` from `polymer/source_assets`, then regenerate the pack. Rebuilding preserves subsequent music and mod updates; restoring the saved combined ZIP would revert those updates too.
