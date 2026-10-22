import { readFileSync } from 'node:fs';

const { recipes } = JSON.parse(readFileSync(new URL('../src/data/recipes.json', import.meta.url), 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function icon(item, extraClass = '') {
  const name = item.item.split(':')[1];
  return `<img class="recipe-item ${extraClass}" src="/images/items/${escape(name)}.png" alt="${escape(item.name)}" width="40" height="40" loading="lazy" decoding="async">`;
}
function slot(item, extraClass = '') {
  if (!item) return '<span class="recipe-slot empty" aria-hidden="true"></span>';
  const count = item.count ?? 1;
  const title = `${item.name}${count > 1 ? ` × ${count}` : ''}`;
  return `<span class="recipe-slot ${extraClass}" title="${escape(title)}">${icon(item)}${count > 1 ? `<span class="recipe-count" aria-label="Quantity ${count}">${count}</span>` : ''}</span>`;
}
function renderRecipe(id) {
  const recipe = recipes[id];
  if (!recipe) throw new Error(`Unknown recipe '${id}'. Add it to src/data/recipes.json or check the Markdown recipe block.`);
  const output = slot(recipe.result, 'recipe-output');
  const arrow = '<span class="recipe-arrow" aria-hidden="true">→</span>';
  let method;
  let body;
  if (recipe.type === 'conversion') {
    method = recipe.method;
    body = `<div class="recipe-process-inputs">${recipe.inputs.map(i => slot(i)).join('')}<span class="recipe-plus" aria-hidden="true">+</span>${slot(recipe.station)}</div>${arrow}${output}`;
  } else if (recipe.type === 'smelting') {
    method = 'Furnace';
    body = `<div class="recipe-furnace-input"><span class="recipe-input-label">Input</span>${slot(recipe.slots[0])}<span class="recipe-fuel" aria-label="Requires furnace fuel">Fuel</span></div><span class="recipe-station" title="Furnace">${icon({ item: 'minecraft:furnace', name: 'Furnace' })}</span>${arrow}${output}`;
  } else {
    method = recipe.type === 'crafting_shapeless' ? 'Crafting · Shapeless' : 'Crafting';
    body = `<div class="crafting-grid" role="group" aria-label="3 by 3 crafting grid">${recipe.slots.map(i => slot(i)).join('')}</div>${arrow}${output}`;
  }
  const timing = recipe.type === 'smelting' ? `<span class="recipe-timing">${recipe.cookingtime / 20} seconds · ${recipe.experience} XP</span>` : '';
  const tags = [...new Set((recipe.slots ?? []).filter(Boolean).filter(i => i.tag).map(i => i.name))];
  const note = tags.length ? `<span class="recipe-note">Accepts: ${tags.map(escape).join('; ')}</span>` : '';
  return `<figure class="recipe-card ${recipe.type === 'conversion' ? 'conversion-card' : ''}" data-recipe-id="${escape(id)}" aria-label="${escape(recipe.summary)}"><div class="recipe-method">${escape(method)}</div><div class="recipe-interface">${body}</div><figcaption>${escape(recipe.summary)}</figcaption>${timing}${note}</figure>`;
}

export default function recipeBlocks() {
  return tree => {
    function visit(node) {
      if (!Array.isArray(node.children)) return;
      const children = [];
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index];
        if (child.type === 'code' && child.lang === 'recipe') {
          const cards = [renderRecipe(child.value.trim())];
          while (node.children[index + 1]?.type === 'code' && node.children[index + 1]?.lang === 'recipe') cards.push(renderRecipe(node.children[++index].value.trim()));
          children.push({ type: 'html', value: `<div class="recipe-gallery">${cards.join('')}</div>` });
        } else { visit(child); children.push(child); }
      }
      node.children = children;
    }
    visit(tree);
  };
}
