# MineAndCraft guild chat

Server-only companion for Minecraft 26.3, Fabric Loader 0.19.5+, Fabric API 0.163.0+26.3 and Java 25. Build with `gradlew.bat build` on Windows or `./gradlew build` elsewhere. Clients install nothing.

The companion forwards accepted ordinary public player chat through Fabric's `CHAT_MESSAGE` event. Whispers, team messages, commands and system broadcasts are excluded. Incoming Discord messages are plain system text sent to all dimensions. An IGN-role mention triggers one private note-block sound for the matching online player, matched case-insensitively against their actual in-game name. The same message's retry cannot repeat its chat or sound.

## Bot and channel setup

The existing `scripts/discord-status.py` service also loads `scripts/discord_bridge.py` when `CHAT_BRIDGE_CHANNEL_ID` is configured. It retains the live roster presence. Install `scripts/discord-status.requirements.txt` in the service venv. Enable **Message Content Intent** and **Server Members Intent** in the bot's Developer Portal settings. The latter supplies Discord username completion. Grant View Channel, Send Messages, Read Message History, and Mention Everyone permissions; temporarily grant Manage Channels during setup.

Run `node scripts/configure-chat.mjs` to inspect requirements. `--enable-intents` enables the two required limited intent flags through Discord's supported application API. Then run `node scripts/configure-chat.mjs --apply` to create `#minecraft-chat` under Text Channels and register `/macnet bridgechat`. It preserves other slash commands. Remove the temporary Manage Channels grant once setup finishes. It must not remove existing permissions from a shared role.

Add the returned `CHAT_BRIDGE_GUILD_ID` and `CHAT_BRIDGE_CHANNEL_ID`, plus a random URL-safe `CHAT_BRIDGE_KEY` (32–256 characters), to private `/etc/mineandcraft-discord/status.env`. Keep the existing Discord token and site origin. Use the updated service example: its `StateDirectory=mineandcraft-discord` stores persistent per-user toggles and duplicate IDs, without chat bodies. The HTTP transport listens only on `127.0.0.1:25586`.

Save the same chat key to root-owned `/etc/mineandcraft-discord/chat.key`, mode 640 with the Minecraft service's group. Grant that group traversal of the parent directory without exposing the root-only bot environment. The Discord token never goes into Minecraft. Copy `config.example.json` to the Minecraft `config/mineandcraft-chat.json` and install the JAR during an empty-server restart under the existing music operation lock.

`scripts/install-chat-bridge.py` automates the private configuration, backups, installation, safe restart and connection checks for a prepared release. Its optional `--wait-empty` checks every 30 seconds and releases the music operation lock between checks. Run it as a supervised one-shot job when players are online. Installation failures are not retried automatically; inspect its logs and rollback report first. The current rollout job is `mineandcraft-chat-install.service`; inspect it with `journalctl -u mineandcraft-chat-install`.

## Behavior

Anyone permitted to view and send messages in #minecraft-chat can use it. `/macnet bridgechat` is a personal toggle, default off, with private confirmation; preferences survive bot restarts. Enabled users' messages from public text channels and public threads are copied to Minecraft and then to the bridge channel after game acknowledgement. Public means visible to `@everyone`. Private channels/threads, DMs, other guilds, bots and webhooks are excluded. The dedicated channel always works regardless of a person's toggle.

Text and attachment links are relayed; files are not downloaded. Edits, deletes, reactions and embeds are not mirrored. Bot-generated messages never loop. Member names are display text, not commands. Discord copies preserve actual user/role mention IDs. In Minecraft, `@username` resolves to a Discord user, `@Role` (or `@"Role Name"` for names with spaces) to a role, and `@everyone`/`@here` work normally. Java chat gets these entries through the standard Tab-completion packet, refreshed every 30 seconds. Geyser/Bedrock's chat UI may not expose Java's custom completion entries; manually typed mentions still work. Unknown names stay plain text. No extra mention restrictions are imposed by the bridge.

Each sender is limited to five relayed messages per ten seconds. Both in-memory queues hold at most 100 messages and expire after 30 seconds; no history is replayed after a restart. Discord send failures with ambiguous outcomes are not retried. Delivery is best-effort, with duplicate IDs retained for reconnects. Offline and expired Discord messages receive a failure reply. A running empty server accepts chat normally; messages are never saved for players who join later. Other public-channel copies are created only after Minecraft acknowledges delivery. Existing conversations are not backfilled.

## Checks and rollout

Run the Python tests with a venv containing the requirements: `python -m unittest discover -s tests-worker -p 'discord*_test.py'`. Build the Fabric project to run Java text tests and API compatibility checks. Verify live transport authentication, Discord guild/channel permissions, slash-command registration, and service health before enabling. Test real public messages in both directions, toggle persistence, private-channel exclusion, role notification sound, and Java Tab-completion. Verify Bedrock chat/sound with a player; do not claim client behavior was checked without that session.

Roll back by stopping the bot, restoring the previous bot files/environment, and restarting its status-only service. Remove or disable the companion at the next safe Minecraft restart. Do not delete the persistent preference database. Channel creation and test messages are not automatically undone.
