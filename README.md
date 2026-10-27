# mineandcraft.net

Public Minecraft server wiki. Astro builds guide articles; a Cloudflare Worker and D1 database provide live player pages, Discord sign-in, role checks, and revision history. Pagefind searches guides, with live player results merged into search. The optional music bridge runs on the Minecraft VPS; the wiki itself runs on Cloudflare.

## Local development

Use Node.js 24.13 or later in the Node 24 line.

```powershell
npm ci
npm run dev
```

Development runs at http://localhost:4321. Search is generated during the production build, so use the production preview when checking search:

```powershell
npm run build
npm run preview
```

The build refreshes Astro's content cache, checks Astro/TypeScript, renders pages, creates the search index, then validates all internal links, anchors, and image paths. Refreshing the cache ensures recipe-renderer and recipe-data changes appear in generated articles.

## Edit the wiki

Guide articles live in `src/content/articles`. Edit them locally or through your GitHub account, then rebuild and publish. Player pages are stored in D1 after the initial import; edit them at `/account/`. Building or deploying does not overwrite saved player edits. The original player Markdown files are the initial seed and static preview only.

Each article starts with title, description, category, and an ISO `updated` date. Categories are `Server`, `Guides`, `Crafting`, `Players`, and `Reference`. Set `draft: true` to exclude unfinished pages from routes, indexes, source views, and search.

- Add a player through `/account/`: choose Java or Bedrock, look up the name, then create the page. The roster, directory, category, source view, All pages, and search update immediately. A member needs a held Discord role whose name matches the verified IGN, ignoring capitalization. The owner can add and edit any player.
- Existing uploaded player heads are preserved. The owner can fetch canonical names and new heads, or upload a PNG replacement. Player URLs remain stable when capitalization or a verified account name changes.
- The editor defaults to pages matching your IGN roles, including for the owner. The owner can explicitly enable **Show all players (owner)** to manage other pages; ordinary members cannot enable this mode.
- Upload images into `public/images` and link them as `/images/...`. Use descriptive alt text and add captions/credits.
- Use links such as `[Homes](/wiki/travel/)`. The build fails on broken internal links.
- Change connection information in `src/content/articles/getting-started.md`.

Recipe diagrams use a fenced `recipe` block with a recipe ID on the next line, for example `minecraft:oak_stairs`. See `crafting-tweaks.md` for examples. The build renders these blocks as crafting grids or furnace/process diagrams; unknown recipe IDs fail the build. IDs and exact ingredient/output data live in `src/data/recipes.json`.

Copper Speakers uses the same recipe diagrams. To refresh its three recipes and inventory images, run `node scripts/import-copper-speakers.mjs PATH_TO_MOD_PROJECT PATH_TO_MINECRAFT_CLIENT_JAR` with the 0.1.7 source project and Minecraft 26.3 client JAR. This requires Python for ZIP reading and Playwright Chromium (or `PLAYWRIGHT_CHANNEL=msedge`). Custom icons are rendered from the mod's model geometry and original textures; paper and note-block images use the same pinned mc-assets source as the other recipes. The Vanilla Tweaks importer preserves separately imported mod recipes.

Guide source is public read-only Markdown. Player source is served from D1. Credentials and Discord sessions are never included in public source. Export player content with `npx wrangler d1 export mineandcraft-wiki --remote --output=player-backup.sql` before making manual database changes; keep backups private because they also contain sessions.

## Discord editing setup

Create a Discord application named **mineandcraft.net Wiki**, with a bot named **MineAndCraft Wiki**. Add the bot to the server with the `bot` scope, no administrator permissions, and no privileged gateway intents. OAuth2 redirect URL: `https://wiki.mineandcraft.net/auth/callback/`. Login requests only `identify` and `guilds.members.read`; the bot token is used to read server role names.

Copy `.dev.vars.example` to `.dev.vars` and fill in the application ID, client secret, bot token, server ID, owner user ID, and a random SESSION_KEY of at least 32 characters. `.dev.vars` is ignored by Git. Keep SESSION_KEY stable; changing it invalidates encrypted session credentials. Never paste tokens into chat, Markdown, or Wrangler's public vars.

Additional owners are listed in `DISCORD_OWNER_IDS` in `wrangler.jsonc`, separated by commas or whitespace. They receive the same permissions as `DISCORD_OWNER_ID`, which remains the primary owner. Every owner must still be a current Discord server member.

For local editing, run `npm run build` then `npm run dev:worker` and open `http://127.0.0.1:8787`. Add `http://127.0.0.1:8787/auth/callback/` as a second Discord OAuth redirect if testing real local login.

After building and testing, run `npm run setup:discord` to verify the bot/application and role access. Run `npm run setup:discord -- --publish` to install all six values as Cloudflare secrets. This reads the ignored file and sends secrets through stdin; it does not print them. Authentication stays disabled until all fields are present.

Every protected API request fetches current server membership and roles using the bot's single-member and server-role endpoints. It does not consume the tightly limited OAuth membership endpoint; no member permissions are cached. A page's IGN must match a held role's name, ignoring capitalization; `@everyone` is excluded. No arbitrary claims by typed name or browser-supplied role lists are trusted. The configured owner can edit all player pages but must still be a server member. Use the IGN as the role name, without decorative text or prefixes. Holders of multiple IGN roles can edit each matching page. Other articles remain owner-edited through Git.

Discord GET requests can retry once after a short, provider-specified cooldown; OAuth token exchanges are never automatically replayed. Longer rate limits return `DISCORD_RATE_LIMITED` and `Retry-After` timing. Errors distinguish bot configuration, membership, sign-in expiry, and temporary outages. Logs include only endpoint labels and HTTP statuses, never Discord credentials or response bodies.

Player pages open in the Visual editor, with Markdown available as an alternate mode. Both edit the same Markdown draft; changing modes never publishes it. Unsupported Markdown stays in source mode. The editor is bundled locally and loaded only after selecting an editable page. Preview, conflicts, and revision restores use the same authenticated API as before.

### Images and video

Enable R2 on the Cloudflare account, then create the Standard bucket once:

```powershell
npx wrangler r2 bucket create mineandcraft-wiki-media
```

The `MEDIA` binding uses this private bucket. Files are served publicly through `/media/:id`, with validated raster MIME types and revalidation on every use. Uploads accept PNG, JPEG, WebP, and GIF, up to 5 MiB per file and 50 MiB per player page. GIF bytes are preserved, including animation. Limits include pending uploads; atomic D1 reservations prevent simultaneous requests from exceeding the quota. Uploads do not create page revisions. The scheduled cleanup retries incomplete uploads/deletions hourly.

Players can upload, paste/drop files, reuse their own image library, insert HTTPS image URLs, and edit alt text. Removing an image from a draft does not delete its file. Deleting files is blocked while any current page references them; deleting an unused file can break images in older revisions. Image permissions are checked against current Discord IGN roles on every request; player-head replacement remains owner-only.

Uploads show transfer progress and keep the selected file and unsaved draft after failures. Retry is explicit and respects any Discord cooldown. If sign-in expires, the dialog opens sign-in in another tab and refreshes its CSRF token before retrying. An upload already confirmed by storage is reused when retrying a failed insertion.

The Video button embeds YouTube and Vimeo URLs. In Markdown, put `[Video](https://www.youtube.com/watch?v=VIDEO_ID)` in its own paragraph. Only validated provider URLs can create iframes; arbitrary iframe HTML stays escaped. Video files are not uploaded to R2.

### Coordinate directory

`/coordinates/` is publicly readable, with text search, tag/dimension/access filters, pagination, and alphabetical or recently updated sorting. Each entry has a permanent `/coordinates/:id/` URL. Entries also appear in the main wiki search. Reading the directory and detail pages works without JavaScript.

Players sign in with Discord and publish immediately using an existing player page matching an IGN role. Only the original Discord submitter with current authorization for that posting profile, or the configured owner, can edit/delete an entry. Optional linked owners/builders are attribution only. The posting profile cannot change. Writes require Origin, CSRF, a current version, and the existing write rate limit.

Public locations contain a dimension, integer X/Z, and optional Y. Private listings do not collect a dimension or coordinates; their database columns must all be NULL, and their public responses omit these fields. Switching Public to Private clears location values. Notes, images, tags, and attribution remain public, so authors should check them for location clues. There is no coordinate revision history or hidden-coordinate store. Previously published information may already be known to readers.

Entries support up to eight tags (24 characters each), an 80-character name, and 2,000 characters of plain-text notes. Farm, Build, Base, Shop, Portal, Transport, Landmark, and Resource are presets; custom tags are normalized to lowercase. Images use the posting profile's existing R2 library and shared 5 MiB file / 50 MiB profile limits. Upload progress, explicit retries, and drafts survive temporary errors. A referenced image cannot be deleted, including when attached to a Private listing; deleting the entry leaves its image in the library.

The additive `0004_coordinates.sql` migration creates entries, tag/player relationships, transactional image-reference guards, and an allowlisted OAuth return path. The directory starts empty. Public APIs are `GET /api/coordinates/` and `GET /api/coordinates/:id/`; the authenticated editing context is `GET /api/coordinates/context/`. POST to the collection, PUT/DELETE to an entry. The context exposes editable entry IDs, never author Discord IDs. Entry forms require JavaScript.

Writes also require the matching site origin, session CSRF token, and current page version. Discord outages deny editing. OAuth states are single-use and expire after ten minutes; sessions use HttpOnly, Secure, SameSite cookies and expire after seven days. Provider tokens are encrypted in D1. Saved changes retain revisions; restoring makes a new revision rather than erasing history.

## Personal mapart

`/mapart/` lets Discord members select an image from an authorized player's library or upload a private temporary image. Artwork supports rectangular grids from 1×1 to 8×8 maps, Fit/Crop, nine alignment positions, dithering, and a tile-grid composition preview. Finished Minecraft-color previews and claim commands stay private to the submitting member with current IGN authorization, or the owner through the explicit all-members management option.

Each `/mapart claim CODE` consumes one blank map per tile, including replacement copies, and requires the selected Java UUID or Floodgate XUID. Single tiles arrive as filled maps; tiled artwork arrives in an included Image2Map placement bundle. Players supply item frames. Completed claims reuse persistent map IDs. Temporary originals never enter the image library and are deleted after conversion; hourly cleanup handles failures and a 24-hour expiry. Converted images remain available until artwork deletion; issued maps remain in the world.

Mapart has a 100 MiB storage allowance per member, including map data, previews, and temporary uploads until removed. There is no saved-artwork count cap. Five conversions may be unfinished at once. The gallery shows storage usage; deleting artwork frees space once its files have been removed.

The service requires migrations `0008_mapart.sql` and `0011_mapart_storage.sql`, a separate `MAPART_BRIDGE_KEY` Cloudflare secret, and the new Java 25 Fabric companion. `MAPART_ENABLED` defaults to `"false"` until server installation and Java/Bedrock acceptance checks are complete. See [companion installation, backups, and acceptance checks](server/mapart-bridge/README.md). Build and test its JAR with `npm run test:mapart-server`. The existing music service runs independently.

## Music discs and member libraries

Album covers are optional HTTPS image URLs, displayed as a centred circular crop with a disc rim and spindle hole. Spotify metadata supplies artwork from its image CDN when available; YouTube sources use the video thumbnail (with a canonical thumbnail fallback), and existing tracks offer a Use YouTube thumbnail action; manual edits are preserved during lookups. Members (or the owner) can edit or clear covers on existing tracks, including installed songs. The website loads images directly without sending a referrer, and a failed image keeps the plain-disc fallback. Migration `0010_music_covers.sql` stores `cover_url` and keeps artwork edits out of audio catalogue revisions.

The public gallery at `/music/` contains installed-song claim commands and collection pagination. `/music/create/` contains uploads, each member's library, delivery progress, and owner review. Both pages link to each other; Discord sign-in returns to the upload page. Gallery refreshes do not load private library data.

`/music/` lists approved and installed custom discs, with search by title, artist or submitting player across all pages. The artist and uploader dropdowns combine with search and use the full approved collection for their choices. Comma-separated credits become individual artist choices, trimmed and deduplicated without regard to case. An artist filter includes collaborations and matches full names before pagination, while each song retains its original displayed credit. Uploader choices use the attributed player profile. Search, filters and pagination also work without JavaScript. Ready audio on approved/installed tracks can be played publicly with native controls and seeking; automatic gallery refreshes preserve playback. Members sign in with Discord and use a player page matching a currently held IGN role to submit a file or an individual Spotify/YouTube link. Each Discord member has their own library across their posting profiles: 20 MiB per file, 100 MiB total stored audio, and 25 active tracks. These limits are separate from player images. Only the original submitter with current IGN authorization, or the owner, can access unapproved audio or manage a submission. Public responses contain player attribution, never Discord author IDs, private file URLs, filenames, or review notes.

Sources accept MP3, WAV, Ogg, FLAC, and M4A signatures; the VPS uses FFprobe to verify that files decode and have a finite, positive duration; there is no song-duration cap. Audio is stored in a private R2 bucket under the `music/` prefix. The gallery playback endpoint checks approval and ready-file state on each request before streaming audio; pending, rejected and deleted submissions are inaccessible publicly. Minecraft players receive generated sound packs. Atomic SQL reservations include unfinished uploads. Failed deletions keep their quota until the hourly sweep succeeds. Pending/rejected submissions may be removed to free storage; approved and installed tracks cannot be deleted, preserving existing disc IDs. Installed tracks remain in subsequent releases.

Spotify links fill the editable title and artists from the public Spotify embed. YouTube links fill the video title and channel name through YouTube oEmbed; members can correct the artist when the channel is not the performer. Lookups are authenticated, rate limited, restricted to fixed provider hosts without redirects or member credentials, and bounded to eight seconds and 256 KiB (Spotify) or 16 KiB (YouTube). Provider failures leave manual entry available; delayed responses preserve edits and ignore older links.

For Spotify, **Find matching recordings** searches YouTube using Spotify's verified title and artists. The request is limited to five searches per member/minute, ten seconds, and a 3 MiB response. Up to five individual recordings with a known positive duration are ranked by title, artist/channel, duration, and version hints. The member chooses a candidate or pastes a specific YouTube video, previews it, and explicitly confirms the recording before submitting without a file. Changing the Spotify link clears the selection and confirmation. Matching is a suggestion, not proof that the version is identical. Original Spotify attribution and the confirmed YouTube audio source are both retained. Existing unapproved Spotify entries without audio can save a confirmed recording from their library; versions, current roles, and active-file checks protect the update.

Owner approval permits the VPS to fetch exactly that confirmed YouTube video when `allow_youtube` is enabled. It never downloads full audio from Spotify or silently substitutes another recording. YouTube may block downloads from the host; failed updates remain uninstalled, and an owner can request changes so a member supplies an audio file. Uploading a file clears any earlier matched-source attribution. Playlist/album URLs and arbitrary download hosts are rejected. Fetched and converted audio is stored in the original member's R2 library against the same quota before pack installation.

The owner explicitly enables **Show all members’ music (owner)** to review others' submissions. Owner approval queues a track; it does not claim the pack is live. The VPS confirms delivery after installation and its configured refresh command succeeds. The collection then shows **Added to server**, with a `/trigger mac_music set CODE` command. Hold **any music disc** in your main hand to apply the chosen song, including to an existing custom disc. Claims modify only the jukebox song and item label, preserving the original disc type, appearance, count, and other components; Blocks remains Blocks. Discs converted by the previous replacement command have already lost their original base type and cannot be automatically restored. Anyone can claim an installed community disc this way, without operator permission or a client mod. Claim codes and song IDs are stable. Vanilla disc audio is not overwritten.

### Connect the Minecraft VPS

Copper Speakers **0.1.9**, installed on 26 October 2026, plays all standard registered jukebox songs through wired speakers. Custom songs without a valid buffered alias use their original audio settings, including streaming; aliases are optional and streamed tracks can have more timing variation. The bridge still emits a `mineandcraft_music:buffered/disc_<id>` song and a `mineandcraft_music:buffered.disc_<id>` sound for each music-library disc, preserving its label, duration, comparator output and claim code. Buffered Java sounds reference the same Ogg with `stream=false, preload=false`; standalone jukeboxes retain their normal playback. Bedrock sound definitions include the aliases, but speaker behavior through Geyser still needs an in-game check. The 0.1.9 deployment preserved the existing music packs and aliases, with no new resource-pack download.

When upgrading an older music bridge for buffered speaker playback, update `music-server.py` and `music-panel-refresh.py` together. Pack revision 3 causes one rebuild of an unchanged installed catalogue under the existing empty-server publishing policy. The helper verifies the loaded revision, aliases and audio files before confirming delivery; failed refreshes retain the previous installation receipt. Players reconnect when the pack changes and reinsert existing discs. The original items and `/trigger mac_music` commands need no conversion. Buffered songs are fully decoded and retained by the Java client during speaker playback, so their loading time and memory use grow with duration. This bridge upgrade was deployed with Copper Speakers 0.1.8 and is retained by 0.1.9.

The site does not upload via a public SSH endpoint. A small Python service on the VPS polls approved work over HTTPS, converts audio with FFmpeg, writes the generated datapack and Polymer sound assets, updates Geyser's Bedrock sound pack, and runs a fixed local command to refresh the server. The site cannot supply commands, destination paths, or arbitrary URLs to that service. SSH/PuTTY is needed to install and configure it, then normal submissions run automatically without SSH sessions.

The inspected live server runs **Minecraft 26.3**, Fabric Loader **0.19.5**, Polymer **0.18.4**, and Geyser **2.12.1-b1273** on Ubuntu 22.04 ARM64. The example uses its data `[121,0]` and resource `[97,1]` formats. Recheck these values before installing on another server or upgrading Minecraft. Custom music and speaker range extension have been confirmed in game on Java and Bedrock with the compatibility bundle below; check new pack releases after reconnecting.

On 27 October 2026, Bedrock 26.60 joins through Geyser 2.12.1-b1273 failed while the music pack advertised version `1.3.23986718`. Changing only the header and module versions to `2.3.0`, with every sound definition and audio file unchanged, restored joining with both the music and integrated Geyser packs enabled. The generator now uses `[PACK_REVISION, first 12 release-hash bits, next 16 bits]`, preserving the previous 28-bit release fingerprint while keeping every version component at most 65535. The current working pack was repaired separately; future music publications use the corrected generator.

1. Apply `0006_music.sql` and `0007_music_matching.sql` to D1 before deploying the updated Worker. Existing image/player data and earlier music submissions are preserved.
2. Install Python 3.10+, FFmpeg/FFprobe (including the Vorbis encoder), and optionally `yt-dlp[default]` with Deno for YouTube. Run the service as the Minecraft service user, with write access only to its state directory and the configured music pack locations. The live host has these tools installed. YouTube currently rejects this host with a sign-in/bot check; affected submissions need an uploaded file.
3. Generate a random `MUSIC_BRIDGE_KEY` of at least 32 characters. Install it as a Cloudflare secret using `npx wrangler secret put MUSIC_BRIDGE_KEY`, and as a private environment variable for the VPS service. Do not put it in JSON, Git, logs, chat, or command arguments. It grants access only to approved music and delivery reports, not wiki editing or approval.
4. Copy both `scripts/music-server.py` and `scripts/music-panel-refresh.py`, plus an adjusted `scripts/music-server.example.json`, to the VPS. All destination directories must be explicit absolute paths. `polymer_source_dir` is normally `SERVER/polymer/source_assets`; the bridge writes only `assets/mineandcraft_music`. Existing mod assets and other datapacks are preserved. Enable Polymer AutoHost, make its parent output directory writable by Minecraft, and use the actual Geyser `packs` directory for the generated Bedrock `.mcpack`.
5. For PufferPanel 2.x, set `panel_server_id` and `panel_credentials` in the example. Keep the credential JSON (`client_id`, `client_secret`) private with mode 600, readable by the service user. The helper uses OAuth through localhost and checks the player count before preparation and again before stopping. If anyone is online, publishing waits. It gracefully stops and starts Minecraft, confirms startup and the loaded datapack release, and verifies Polymer's generated ZIP. The fixed preflight, refresh, and recovery commands in the example implement this policy. PufferPanel must grant status, console read/send, stop, and start access. No RCON or extra inbound port is needed.
6. Adjust the paths in `scripts/music-server.service.example` and install it as `mineandcraft-music.service`, as on the live host. The first run installs the empty core pack when the server is empty. Later approved batches use the same policy, polling every 60 seconds. With the first approved song, check Java/Bedrock playback, duration, disc claims, and pack downloads after reconnecting. `geyser reload` kicks Bedrock players, so publishing uses a full controlled restart during an empty-server window instead.

Only one bridge may use a given state directory. Original downloads are checksum-verified, and conversion permits local file/pipe protocols only. There is no Spotify ripping or unconfirmed source substitution. `allow_youtube` is disabled in the sample config. Converted files are cached; retries do not repeatedly install a confirmed release. Before changing Minecraft files the bridge verifies that the approved catalogue has not changed. Failed refreshes restore previous files and invoke the recovery command; the PufferPanel helper again checks that the server is empty before restarting. Failed updates never mark tracks installed. The state directory includes the installed manifest ID and operator disc commands.

The default music-only pack budget is 100 MiB; account for other assets in the combined Polymer pack when choosing this budget. Every player downloads the approved community sound collection, rather than only their own private library. New tracks usually require players to reconnect to receive the updated pack, especially Bedrock clients. The size/CPU/time limits and the server refresh strategy must be checked on the actual host before enabling automatic publishing.

Public API: `GET /api/music/` (optional `q`, `artist`, `uploader` player slug and `page`), and `GET/HEAD /api/music/:id/play/` for approved, ready audio with single byte-range support. Private member context: `GET /api/music/context/` (optional `scope=all` for the owner). Authenticated creation: `POST /api/music/`; private upload/preview: `POST/GET /api/music/:id/audio/`; owner review: `POST /api/music/:id/review/`; removal: `DELETE /api/music/:id/`. `DELETE /api/music/:id/audio/` removes an unapproved audio file so a member can attach a replacement; it blocks approval until storage deletion completes. Mutations require Origin, CSRF, live Discord authorization, and the existing write rate limit; creation is additionally limited to five per minute. Reviews and deletions check versions, creation/upload retries are idempotent, and an audio upload or deletion in progress blocks approval.

The bridge uses a dedicated Bearer credential on `/api/music/bridge/manifest/`, `/api/music/bridge/:id/audio/`, and `/api/music/bridge/report/`. It cannot read pending originals, approve tracks, or edit other pages. Reports use catalogue checksums and transactional catalogue revisions so a changed approval cannot be acknowledged as an installed snapshot. Pending credentials, disconnected server status, and delivery errors are visible to the owner. No bot sends Discord messages.

References: [Minecraft 26.3 technical changes](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3), [Polymer custom asset paths](https://polymer.pb4.eu/latest/user/resource-pack-custom-assets/), [Polymer AutoHost](https://polymer.pb4.eu/latest/user/resource-pack-hosting/), [Geyser pack delivery](https://geysermc.org/wiki/geyser/packs/), [yt-dlp options](https://github.com/yt-dlp/yt-dlp/blob/master/README.md).

### Copper Speakers on Bedrock

The live server supports Copper Speakers through Geyser using the companion in [server/bedrock-speakers](server/bedrock-speakers/README.md). Bedrock players accept the server resource packs; no client mod is required. Speaker range extension has been confirmed in game on both Java and Bedrock, including custom music. The companion supplies buffered playback, wire and resin geometry, wall-plate entities, and speaker-note particles through a patched GeyserDisplayEntity bridge.

This integration targets Minecraft Java 26.3, Geyser-Fabric 2.12.1-b1273 and Bedrock 26.60 (protocol 2225). Copper Speakers `0.2.1+mineandcraft.1` also restricts wall-plate connections to their two socket faces for both wire branches and audio routing. The server operator has confirmed Bedrock functionality has reached parity with Java on this setup. All 45 Minecraft tests and four graph tests pass. Build, installation, version requirements and verification details are in the companion README.

## Additional server resource packs

[Casino chips](server/resource-packs/casino-chips/README.md) contains the six supplied chip textures and their written-book matching rules. Its assets are installed in the live Polymer pack; see that directory for the source files, installation checks, and rollback record.

## Profile comments

Player profiles have public, plain-text comments (up to 2,000 characters). Posting requires Discord sign-in, an existing player page, and its matching IGN role. Authors can delete their own comments while they retain that role; the configured wiki owner can delete any comment. Posting as another player is denied, including for the owner. Comments record the Discord author privately and link the chosen player page publicly. They do not change profile revisions. Writes use current Discord checks, Origin, CSRF, the shared write limit, and an additional five-comments-per-minute limit per account.

Apply the additive `0005_comments.sql` D1 migration before deploying. Public comments are rendered on the server, 30 at a time, newest first. Older comments, posting, and deletion use JavaScript. Public `GET /api/players/:slug/comments/` supports `?page=2`; the private `context/` endpoint adds posting profiles and deletion permissions. POST to the collection and DELETE `:id/`. Discord sign-in can return to the same profile using an allowlisted local path. Comments have no replies, attachments, or Markdown rendering.

## Content provenance

The initial roster includes the 14 PNGs supplied by the owner. Only those images were copied; local server configuration and statistics archives were not imported or published.

The 19 datapack descriptions and commands were checked against the author's 26.3 catalog:
https://vanillatweaks.net/assets/resources/json/26.3/dpcategories.json

Crafting documentation was derived from the supplied `VanillaTweaks_c223234_MC26.3.zip`, including its 11 selections and 409 recipe definitions. The source ZIP is not distributed. To regenerate the roster and full recipe reference from a local asset directory:

```powershell
python scripts/import-roster-and-recipes.py 'C:/path/to/MACNET'
```

The importer preserves existing biographies and regenerates the recipe data and visual reference. Review `crafting-tweaks.md` if the archive changes. The selection screenshot showed Craftable Horse Armor, but the supplied archive does not contain that recipe.

To regenerate just recipe data and the reference, run `python scripts/import-recipes.py PATH_TO_ZIP`. Item renders are downloaded once from the pinned source commit listed in `public/images/items/CREDITS.txt` and served locally; builds and page views never depend on the image provider. Existing cached PNGs are reused.

Java identities use Mojang's profile lookup, with [PlayerDB](https://playerdb.co/) as a fallback when Mojang blocks Cloudflare or is unavailable. Returned names and UUIDs are validated before use. Bedrock identities use Geyser's Xbox gamertag/XUID and skin endpoints; lookups can be unavailable when the player is not cached. Automatically added heads are fetched from MCHeads and stored as PNG snapshots in D1. Existing supplied heads remain local files.

## Browser checks

```powershell
npm run build
npm run test:worker
npm run test:music-server
npm test
```

API tests use real SQLite with mocked Discord/profile providers to cover OAuth state replay, sessions, role matching/removal, cross-page denial, CSRF, conflicts, revision restores, lookup, and creation. Browser tests use local Wrangler/D1, installed Microsoft Edge on Windows, and Playwright Chromium in CI. For another local browser, set `PLAYWRIGHT_CHANNEL=chrome`; or set `CI=true` after `npx playwright install chromium`. Tests cover desktop/mobile navigation, player pages, search, the editor, appearance, recipes, and missing pages. Screenshots go to ignored `test-results/`.

## Publish to Cloudflare

First build and test locally. Log in through Cloudflare's browser flow, then confirm the account:

```powershell
npx wrangler login
npx wrangler whoami
npx wrangler d1 migrations apply mineandcraft-wiki --remote
npm run deploy
```

The Worker is named `mineandcraft-wiki`. Wrangler config declares `wiki.mineandcraft.net` as its custom domain and also enables a workers.dev fallback URL. Deploying attaches that wiki subdomain to the Worker; the existing Minecraft server's domain and SRV records remain separate. The site's canonical URL is `https://wiki.mineandcraft.net`.

Source repository: https://github.com/mcneds/wiki.mineandcraft.net

To enable later deployments from GitHub using Cloudflare Workers Builds, connect that repository, select `main`, use `npm run build` as the build command and `npx wrangler d1 migrations apply mineandcraft-wiki --remote && npx wrangler deploy` as the deploy command. Secrets belong in Cloudflare, never this repository.

## Credits

Original wiki layout inspired by traditional Minecraft Wiki/Wikipedia navigation. No MediaWiki runtime is used. Original player head images were generated with [MC Skins Avatar Maker](https://mcskins.top/avatar-maker) and supplied by the server owner. Automatic heads use [MCHeads](https://mc-heads.net/). Third-party names and pack content belong to their respective authors. The existing repository license is preserved.


### Live player status and delivery progress

Apply `0009_server_status.sql` before this update. `music_progress` stores per-track delivery independently of catalogue mutations; reports require both the release digest and catalogue revision. Public labels distinguish fetching, conversion, an actual empty-server wait, installation, and safe failure reasons. The music bridge heartbeats every 15 seconds in a separate thread, including during provider calls and restarts. Old attempts never re-fetch a newer manifest to report their errors. Background page refreshes preserve draft text, review notes and selected files.

`GET /api/server-status/` is public and returns only the full roster's display names, count, capacity, availability and receive time. Snapshots older than 45 seconds become unavailable. `POST /api/server-status/report/` requires the separate `SERVER_STATUS_KEY`; this key cannot submit music, edit content or authenticate players.

Install `scripts/server-status.py` and `scripts/server-status.service.example` alongside the music bridge, using its venv (`websockets` 16+). Put `SERVER_STATUS_KEY` in root-only `/etc/mineandcraft-music/status.env`, and a `status.json` containing `site_origin` and the absolute `server_properties` path. Configure Minecraft with `management-server-enabled=true`, `management-server-host=127.0.0.1`, `management-server-port=25585`, `management-server-tls-enabled=false`, a random management secret, and empty allowed origins. Never expose this management port publicly. Activate changed properties with a controlled restart after fresh empty-server checks. The management credential remains local; only the status-specific credential leaves the host.

The collector gets a complete initial roster, follows join/leave events, re-snapshots on reconnect, and reports changes plus a 15-second heartbeat independently of music processing. WebSocket pings retain liveness without polling console commands or waking the paused server to issue `list`. A refused local game port means offline; failed management access with Minecraft reachable means status unavailable. Both Java and Geyser players appear across all dimensions. The mapart companion remains independent; music claiming uses the existing server datapack and requires no extra client mod.

### Discord live player presence

`scripts/discord-status.py` keeps the existing wiki bot's custom Discord status in sync with the same public `/api/server-status/` endpoint every 15 seconds. It displays `2/20 online · Alex, Steve`, explicitly labels an empty server, and rotates through pages of names when the roster exceeds 128 characters. Offline servers display `Server offline`; failed requests, stale snapshots and unavailable data display `Status unavailable` without old player names. It requests no Gateway intents and sends no channel messages. Discord connection recovery is handled by discord.py; systemd restarts the process after failures and at boot.

The optional [guild chat companion](server/chat-bridge/README.md) extends that same bot with two-way #minecraft-chat, persistent `/macnet bridgechat` toggles for public Discord channels, mention completion, and private in-game notification sounds for IGN-role mentions. Chat mode enables guild/member/message intents; status-only mode keeps its original permissions and behavior. See the companion guide for setup, tests, delivery limits and safe installation.

Install the script under `/opt/mineandcraft-discord`, create a separate Python venv there, and install `scripts/discord-status.requirements.txt`. Put the existing `DISCORD_BOT_TOKEN` and `SITE_ORIGIN=https://wiki.mineandcraft.net` in root-owned, mode-600 `/etc/mineandcraft-discord/status.env`. Install `scripts/discord-status.service.example` as `/etc/systemd/system/mineandcraft-discord-status.service`, then run `systemctl daemon-reload` and `systemctl enable --now mineandcraft-discord-status`. Only one presence service should run for this bot. The wiki's Discord sign-in and role checks continue using the same bot credentials independently. No Minecraft restart is required. Run its regression checks with `python -m unittest discover -s tests-worker -p discord_status_test.py`.


The live bridge also has the pinned **BgUtils PO-token provider 2.0.2** installed, using Deno and `bgutil-ytdlp-pot-provider==2.0.2` in its venv. The provider listens only on `127.0.0.1:4416` as `mineandcraft-pot.service`. Set `youtube_pot: true` in the private bridge config to select `mweb,tv,web_safari` and request tokens automatically. A token was generated on this host, but the selected video still returned YouTube's sign-in/bot check; tokens alone do not remove IP-based login restrictions. Do not interpret an installed provider as successful audio delivery. No Google account credentials have been collected.

If separately configured by the owner, `youtube_cookies` may point to an absolute private Netscape cookie file on the VPS. The service copies it into the current private temporary job before use, so yt-dlp can update its cookie jar without writing to `/etc`. Cookies never enter D1, R2, public reports or browser forms. Keep the original readable only by the bridge's service account. This option is not enabled on the live host.

Startup receipts prefer Minecraft's `Done` feedback and can also confirm readiness through the private management API when PufferPanel's incremental console misses that line. Music installation still verifies the expected datapack release and generated pack before publishing claim commands. The one-time status activation timer is disabled after completion.

### YouTube connection testing and private relay

On 2026-10-24, the VPS's direct connection failed playback with yt-dlp 2026.10.21, Lavalink 4.2.2 + youtube-source 1.18.2, BgUtils tokens, and browser-generated WebPoClient tokens. A fresh browser on the VPS also received the sign-in challenge. Metadata loading alone was successful and is not a playback check.

The exact approved YouTube recording `8FboDWxVuxc` downloaded successfully both on the owner's PC and **on the VPS through a private SSH relay using the PC's connection**. FFprobe verified 289.381 seconds and 4,373,541 bytes of Opus audio; the VPS converted it to a 2,360,514-byte mono Vorbis file. It was attached through the normal member-library quota checks and published as an installed disc, claim code `1524953312`. Subsequent repeated tests hit HTTP 429 on the PC connection too, so the relay is a demonstrated transport option, not a guarantee against YouTube rate limits. No authenticated Google cookies or OAuth tokens were used in that earlier relay test.

`scripts/youtube-relay.py` provides the reusable relay. It binds only to loopback on both hosts, permits HTTPS CONNECT only for YouTube/media hosts and Google's consent flow, rejects private DNS destinations, limits concurrent connections, and reconnects SSH. It does not read browser profiles or decrypt HTTPS. Run it on the computer providing the connection:

```powershell
python scripts/youtube-relay.py --session minecraft --ssh-user ubuntu --key-file "C:\path\to\private-key.ppk"
```

The PuTTY session must already trust the server's host key. For an enabled relay, set `youtube_proxy` to `http://127.0.0.1:18443` and `youtube_pot` to `false` in the VPS's private music configuration, then restart only the music service. Proxy configuration applies only to yt-dlp; wiki credentials and game traffic use their usual connections. This transport requires the relay computer to remain connected for new imports; installed discs continue working without it. The owner requires imports to work without their PC: the relay remains a diagnostic tool, all temporary tunnels were stopped, and `youtube_proxy` remains unset on the VPS.

Downloads now space requests, bound network retries, and persist per-track cooldowns across service restarts: blocked/rate-limited downloads wait 15 minutes, then exponentially longer up to six hours; other provider failures start at five minutes. An attached audio file proceeds immediately, and a changed source or connection resets that track's cooldown. These delays prevent the former one-minute retry loop from repeatedly hitting YouTube while access is blocked.

### Server-only YouTube sign-in

The VPS now has Lavalink 4.2.2 with youtube-source snapshot `2be8e542d3f6f178e048dca565892684c2e40177` listening only on loopback port 2333, and a local `yt-cipher` helper on loopback port 8001. The cipher source is pinned to `1e1fd8e2f34ca90cf23545be72e46307bd3d3d2a`, with the upstream-documented EJS revision `cd4e87f52e87ab6d8b318fd3a817adda6fafa8dc`. Services are `mineandcraft-lavalink` and `mineandcraft-cipher`; both start with the VPS and have memory/CPU limits. No PC connection or public cipher service is needed.

Google device authorization is initiated through Lavalink's private `/youtube` endpoint. The owner completes it at Google's device page using a separate account, as recommended by youtube-source. The one-time code must not be committed or saved in documentation. Provider console logs can contain refresh tokens, so they are written only to mode-600 files under `/var/lib/mineandcraft-music/lavalink`, not the public site or ordinary service journal. `mineandcraft-youtube-auth.timer` runs `scripts/youtube-auth-status.py` to capture a completed authorization into the private server configuration atomically; it never prints tokens. Completing sign-in can be done from a phone and does not create a continuing dependency on that device.

The bridge supports `youtube_lavalink_config`, an absolute path to private JSON containing `origin` (loopback HTTP only) and a strong `password`. The live connection file is `/etc/mineandcraft-music/lavalink-client.json`. With this option set, only the explicitly confirmed video ID is requested from Lavalink. Redirects are refused, downloads are bounded, and the same 20 MB checks and audio conversion apply, without a song-duration cap. Google authorization is saved privately on the VPS and survives service restarts. A complete server-only import of the exact recording `8FboDWxVuxc` was verified: 15,496,632 bytes downloaded, strict FFmpeg decoding succeeded, and the mono Vorbis result is 2,321,247 bytes / 289.367 seconds. The bridge uses this local authenticated backend for new imports; the PC relay remains disabled. Spotify continues to use the member-confirmed YouTube recording, not audio from Spotify. Provider restrictions can still reject individual videos; failures remain visible and preserve the file-upload alternative.

`scripts/patch-youtube-source.py` reproducibly patches the pinned plugin and retains its original JAR outside the plugin folder. It recovers missing lengths from `clen` when available, requests a complete HTTP response when the total length is unknown, and reports the resolved HTTP length to callers. This avoids treating the first 11.86 MB download chunk as the full song. It compiles the patch and runs Java regression checks before installing it; stop only Lavalink while applying it. The music bridge also rejects decoder errors and converted durations that differ by more than 1% (minimum one second), preventing shortened audio from being published. Existing installed audio and claim codes are retained; changing this download provider does not require a Minecraft restart.
