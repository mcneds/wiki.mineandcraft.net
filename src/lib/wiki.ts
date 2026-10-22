import { getCollection } from 'astro:content';

export const articleUrl = (id: string) => `/wiki/${id}/`;
export const categories = ['Server', 'Guides', 'Crafting', 'Players', 'Lore', 'Reference'] as const;
export const getArticles = async () => (await getCollection('articles', ({ data }) => !data.draft))
  .sort((a, b) => a.data.title.localeCompare(b.data.title, 'en'));
