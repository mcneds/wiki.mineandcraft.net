# mineandcraft.net

Public, owner-edited Minecraft server wiki. Astro builds ordinary Markdown articles into a static site; Pagefind provides local site search. Hosting uses Cloudflare Workers Static Assets and does not use the Minecraft VPS.

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

The build checks Astro/TypeScript, renders pages, creates the search index, then validates all internal links, anchors, and image paths.

## Edit the wiki

Articles live in `src/content/articles`. Edit them locally or through your own GitHub account, then rebuild and publish. Public visitors have no editing endpoint. The repository owner's account controls changes; do not grant repository write access to anyone you do not want editing the wiki.

Each article starts with title, description, category, and an ISO `updated` date. Categories are `Server`, `Guides`, `Crafting`, `Players`, `Lore`, and `Reference`. Set `draft: true` to exclude unfinished pages from routes, indexes, source views, and search.

- Edit a player biography in `src/content/articles/players/IGN.md`. Preserve the exact IGN and image filename. Put additional player heads under `public/images/players`.
- Copy `templates/lore.md` into `src/content/articles/lore/your-story.md`, write the story, and remove `draft: true` when ready. The optional `date` controls the Lore timeline; undated stories get their own section. Lore entries appear automatically on the home page and Lore index.
- Copy `templates/player.md` for a new player. The Players directory and home-page roster update automatically.
- Upload images into `public/images` and link them as `/images/...`. Use descriptive alt text and add captions/credits.
- Use links such as `[Homes](/wiki/travel/)`. The build fails on broken internal links.
- Change connection information in `src/content/articles/getting-started.md`.

Recipe diagrams use a fenced `recipe` block with a recipe ID on the next line, for example `minecraft:oak_stairs`. See `crafting-tweaks.md` for examples. The build renders these blocks as crafting grids or furnace/process diagrams; unknown recipe IDs fail the build. IDs and exact ingredient/output data live in `src/data/recipes.json`.

No CMS, database, or web-editing credentials are required. Page source is public read-only Markdown; it contains article text, never environment variables or server configurations.

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

Bedrock port, current supported client versions, mod activation, server-specific limits, and historical player details remain unconfirmed. The articles mark these limits rather than inventing information.

## Browser checks

```powershell
npm run build
npm test
```

Tests use installed Microsoft Edge on Windows and Playwright Chromium in CI. For another local browser, set `PLAYWRIGHT_CHANNEL=chrome`; or set `CI=true` after `npx playwright install chromium` to use the downloaded Chromium. Tests cover desktop/mobile navigation, player pages, search, appearance persistence, recipe ingredients/quantities/images, and missing-page behavior. Screenshots go to ignored `test-results/`.

## Publish to Cloudflare

First build and test locally. Log in through Cloudflare's browser flow, then confirm the account:

```powershell
npx wrangler login
npx wrangler whoami
npm run deploy
```

The Worker is named `mineandcraft-wiki`. Wrangler config declares `wiki.mineandcraft.net` as its custom domain and also enables a workers.dev fallback URL. Deploying attaches that wiki subdomain to the Worker; the existing Minecraft server's domain and SRV records remain separate. The site's canonical URL is `https://wiki.mineandcraft.net`.

Source repository: https://github.com/mcneds/wiki.mineandcraft.net

To enable later deployments from GitHub using Cloudflare Workers Builds, connect that repository, select `main`, use `npm run build` as the build command and `npx wrangler deploy` as the deploy command. No account IDs or secrets belong in this repository. Domain registration alone does not connect the repository or authorize deployment.

## Credits

Original wiki layout inspired by traditional Minecraft Wiki/Wikipedia navigation. No MediaWiki runtime is used. Player-head images are owner-supplied assets; third-party names and pack content belong to their respective authors. The existing repository license is preserved.
