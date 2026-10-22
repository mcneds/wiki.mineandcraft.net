import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import recipeBlocks from './scripts/recipe-blocks.mjs';

export default defineConfig({
  site: 'https://wiki.mineandcraft.net',
  output: 'static',
  trailingSlash: 'always',
  markdown: { processor: unified({ remarkPlugins: [recipeBlocks] }) },
});
