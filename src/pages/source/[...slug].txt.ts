import type { APIRoute } from 'astro';
import { getArticles } from '../../lib/wiki';
export async function getStaticPaths() {
  return (await getArticles()).map(article => ({ params: { slug: article.id }, props: { body: article.body ?? '', title: article.data.title } }));
}
export const GET: APIRoute = ({ props }) => new Response(`# ${props.title}\n\n${props.body}`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
