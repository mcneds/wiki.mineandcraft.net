export const MAPART_FILE_LIMIT = 5 * 1024 * 1024;
export const MAPART_PIXEL_LIMIT = 16 * 1024 * 1024;
export const MAPART_TILE_LIMIT = 256;
export const MAPART_SIDE_LIMIT = 64;
export const MAPART_DATA_LIMIT = MAPART_TILE_LIMIT * 128 * 128;
export const MAPART_PREVIEW_LIMIT = 20 * 1024 * 1024;
export function mapartSizeError(columns, rows) {
  if (![columns, rows].every(value => Number.isInteger(value) && value >= 1 && value <= MAPART_SIDE_LIMIT)) return `Enter a whole number from 1 to ${MAPART_SIDE_LIMIT} for columns and rows.`;
  if (columns * rows > MAPART_TILE_LIMIT) return `This layout uses ${columns * rows} tiles. Choose at most ${MAPART_TILE_LIMIT} tiles total.`;
  return '';
}
export const MAPART_DEFAULTS = { columns: 1, rows: 1, fit: 'fit', horizontalAlignment: 'center', verticalAlignment: 'center', dither: true };
export function mapartFields(input) {
  const fields = { ...MAPART_DEFAULTS, ...input };
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  if (!title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Give the artwork a name of 1–80 characters.');
  const sizeError = mapartSizeError(fields.columns, fields.rows);
  if (sizeError) throw new Error(sizeError);
  if (!['fit', 'crop'].includes(fields.fit) || !['left', 'center', 'right'].includes(fields.horizontalAlignment) || !['top', 'center', 'bottom'].includes(fields.verticalAlignment) || typeof fields.dither !== 'boolean') throw new Error('Choose valid fitting, alignment, and dithering settings.');
  return Object.fromEntries(['title', ...Object.keys(MAPART_DEFAULTS)].map(key => [key, key === 'title' ? title : fields[key]]));
}
export function mapartLayout(sourceWidth, sourceHeight, settings) {
  const width = settings.columns * 128, height = settings.rows * 128;
  const scale = (settings.fit === 'fit' ? Math.min : Math.max)(width / sourceWidth, height / sourceHeight);
  const resizedWidth = Math.max(1, Math.round(sourceWidth * scale)), resizedHeight = Math.max(1, Math.round(sourceHeight * scale));
  return { width, height, resizedWidth, resizedHeight, x: Math.floor((width - resizedWidth) * { left: 0, center: .5, right: 1 }[settings.horizontalAlignment]) || 0, y: Math.floor((height - resizedHeight) * { top: 0, center: .5, bottom: 1 }[settings.verticalAlignment]) || 0 };
}
