---
title: "Homes & teleporting"
description: "Set a home, return to spawn, and request a visit to another player."
category: "Guides"
updated: "2026-10-22"
facts:
  - label: "Datapacks"
    value: "Homes · Spawn · Back · TPA"
  - label: "Command system"
    value: "/trigger"
---
The server's travel helpers come from **Vanilla Tweaks**. These commands use Minecraft's `/trigger` system; they are not the `/home` or `/tpa` commands used by some plugin servers.

## Set a home

Stand where you want your home to be and enter:

```text
/trigger sethome
```

Return to that home with:

```text
/trigger home
```

### Numbered homes

The Homes pack also supports numbered home IDs. Replace `2` with the home ID you want to use:

| Action | Example command |
| --- | --- |
| Save home 2 at your current location | `/trigger sethome set 2` |
| Travel to home 2 | `/trigger home set 2` |

The server's home limit and any other configured restrictions have not been confirmed. Ask the owner if a numbered slot is unavailable.

## Return to spawn

Use `/trigger spawn` to travel to the world spawn point.

## Go back

Use `/trigger back` to return to the previous location recorded by Homes, Spawn, or TPA.

## Visit another player

1. Press **Tab** in Java to see player IDs (PIDs).
2. Find the PID of the person you want to visit.
3. Enter `/trigger tpa set 3`, replacing `3` with their PID.
4. Let the other player respond to the request shown in game.

For Bedrock controls and request-response interactions, check the in-game prompts or ask the owner. No unverified accept/deny command is listed here.

## If a command does not work

Check the spelling and make sure you included `/trigger`. If Minecraft reports an unavailable trigger, ask the owner to check that the relevant datapack is enabled and that your player is allowed to use it. Configured limits or restrictions can differ from the pack defaults.

## Sources

Verified against the [official Vanilla Tweaks 26.3 pack descriptions](https://vanillatweaks.net/assets/resources/json/26.3/dpcategories.json): Homes 1.5.20, Spawn 2.3.18, Back 1.3.18, and TPA 2.3.18. These match the supplied inventory.
