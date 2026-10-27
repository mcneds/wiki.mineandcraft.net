// Verify first; --apply creates the channel and upserts only our slash command.
import { readFileSync } from 'node:fs';
const values = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2')];
}));
const guild = values.DISCORD_GUILD_ID, appId = values.DISCORD_CLIENT_ID;
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://discord.com/api/v10/${path}`, {
    method, headers: { Authorization: `Bot ${values.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Discord setup request failed (HTTP ${response.status}, ${method} ${path}).`);
  return response.status === 204 ? null : response.json();
}
let app = await api('applications/@me');
if (app.id !== appId) throw new Error('The configured application does not match the bot.');
if (process.argv.includes('--enable-intents')) {
  app = await api('applications/@me', 'PATCH', { flags: app.flags | (1 << 15) | (1 << 19) });
}
const [member, roles, channels, commands] = await Promise.all([
  api(`guilds/${guild}/members/${appId}`), api(`guilds/${guild}/roles`),
  api(`guilds/${guild}/channels`), api(`applications/${appId}/guilds/${guild}/commands`),
]);
const permissions = roles.filter(role => role.id === guild || member.roles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n);
const has = bit => Boolean(permissions & ((1n << 3n) | (1n << BigInt(bit))));
const content = Boolean(app.flags & ((1 << 18) | (1 << 19)));
const members = Boolean(app.flags & ((1 << 14) | (1 << 15)));
const found = channels.filter(channel => channel.name === 'minecraft-chat' && channel.type === 0);
if (found.length > 1) throw new Error('Multiple #minecraft-chat channels exist; resolve the duplicate before setup.');
console.log(JSON.stringify({ guild, application: appId, messageContent: content, memberAutocomplete: members,
  manageChannels: has(4), mentionEveryoneAndRoles: has(17), existingChannel: found[0]?.id || null }));
if (!process.argv.includes('--apply')) process.exit(0);
if (!content || !members) throw new Error('Enable Message Content Intent and Server Members Intent in the Discord Developer Portal first.');
if (!has(17)) throw new Error('Grant the bot Mention Everyone permission so requested role/everyone mentions can notify.');
if (!found.length && !has(4)) throw new Error('Temporarily grant the bot Manage Channels to create #minecraft-chat.');
const category = channels.find(channel => channel.type === 4 && channel.name === 'Text Channels');
const channel = found[0] || await api(`guilds/${guild}/channels`, 'POST', {
  name: 'minecraft-chat', type: 0, ...(category ? { parent_id: category.id } : {}),
  topic: 'Two-way Minecraft chat. Messages here go into the game. /macnet bridgechat toggles forwarding your messages from other public channels. Mention an IGN role to notify that player in game.',
});
const current = commands.find(command => command.name === 'macnet' && command.type === 1);
const command = { name: 'macnet', description: current?.description || 'MineAndCraft server tools',
  options: [...(current?.options || []).filter(option => option.name !== 'bridgechat'),
    { type: 1, name: 'bridgechat', description: 'Toggle relaying your public-channel messages to Minecraft' }] };
await api(`applications/${appId}/guilds/${guild}/commands${current ? '/' + current.id : ''}`, current ? 'PATCH' : 'POST', command);
console.log(JSON.stringify({ configured: true, guildId: guild, channelId: channel.id,
  channelUrl: `https://discord.com/channels/${guild}/${channel.id}` }));
