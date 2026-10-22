import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(['Server', 'Guides', 'Crafting', 'Players', 'Lore', 'Reference']),
    updated: z.string(),
    image: z.string().optional(),
    facts: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    date: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articles };
