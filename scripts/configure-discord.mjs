import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const names = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_OWNER_ID', 'SESSION_KEY'];
const text = readFileSync('.dev.vars', 'utf8');
const values = {};
for (const name of names) {
  const raw = text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
  values[name] = raw?.replace(/^(["'])(.*)\1$/, '$2') || '';
}
const missing = names.filter(name => !values[name]);
if (missing.length) { console.error(`Fill in these fields in .dev.vars: ${missing.join(', ')}`); process.exit(1); }
if (values.SESSION_KEY.length < 32 || names.filter(name => name.endsWith('_ID')).some(name => !/^\d{17,20}$/.test(values[name]))) {
  console.error('Check the Discord IDs and use a SESSION_KEY of at least 32 characters.'); process.exit(1);
}
const options = { headers: { Authorization: `Bot ${values.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(10000) };
const bot = await fetch('https://discord.com/api/v10/users/@me', options);
if (!bot.ok || (await bot.json()).id !== values.DISCORD_CLIENT_ID) { console.error('The bot token is invalid or belongs to a different application.'); process.exit(1); }
const roles = await fetch(`https://discord.com/api/v10/guilds/${values.DISCORD_GUILD_ID}/roles`, options);
if (!roles.ok) { console.error('The bot cannot read roles in the selected Discord server. Check the server ID and bot invitation.'); process.exit(1); }
console.log('Discord application and server role access verified. No secret values were displayed.');
if (!process.argv.includes('--publish')) { console.log('Run npm run setup:discord -- --publish to install the credentials in Cloudflare.'); process.exit(0); }
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], { input: JSON.stringify(values), encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
