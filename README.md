# mineandcraft.net

Public Minecraft server wiki. Astro builds guide articles; a Cloudflare Worker and D1 database provide live player pages, Discord sign-in, role checks, and revision history. Pagefind searches guides, with live player results merged into search. Nothing runs on the Minecraft VPS.

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

Guide source is public read-only Markdown. Player source is served from D1. Credentials and Discord sessions are never included in public source. Export player content with `npx wrangler d1 export mineandcraft-wiki --remote --output=player-backup.sql` before making manual database changes; keep backups private because they also contain sessions.

## Discord editing setup

Create a Discord application named **mineandcraft.net Wiki**, with a bot named **MineAndCraft Wiki**. Add the bot to the server with the `bot` scope, no administrator permissions, and no privileged gateway intents. OAuth2 redirect URL: `https://wiki.mineandcraft.net/auth/callback/`. Login requests only `identify` and `guilds.members.read`; the bot token is used to read server role names.

Copy `.dev.vars.example` to `.dev.vars` and fill in the application ID, client secret, bot token, server ID, owner user ID, and a random SESSION_KEY of at least 32 characters. `.dev.vars` is ignored by Git. Keep SESSION_KEY stable; changing it invalidates encrypted session credentials. Never paste tokens into chat, Markdown, or Wrangler's public vars.

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
