export const PRESET_TAGS = ['Farm', 'Build', 'Base', 'Shop', 'Portal', 'Transport', 'Landmark', 'Resource'];
export const DIMENSIONS = { overworld: 'Overworld', nether: 'Nether', end: 'End' };
export const coordinateUrl = id => `/coordinates/${id}/`;
export const tagName = value => PRESET_TAGS.find(tag => tag.toLowerCase() === value) || value;
