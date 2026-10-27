---
title: "Copper Speakers"
description: "Extend your jukebox with copper wire and speakers. Recipes, wiring, wall plates, and resin insulation."
category: "Guides"
updated: "2026-10-27"
facts:
  - label: "Server version"
    value: "0.2.0 · Minecraft Java 26.3"
  - label: "Music"
    value: "Your usual jukebox discs"
  - label: "Client requirement"
    value: "Accept the server resource pack"
---
**Copper Speakers** extends your jukebox with wired speakers. Connect them with copper wire, then play your discs as usual to hear the music around your build.

Accept the server resource pack when joining. Java players need no client mod; Bedrock compatibility has not been verified.

**Version 0.2.0 is live on the server.**

## Build your first system

1. Craft **copper wire** and at least one **speaker** using the recipes below.
2. Place a jukebox and a speaker on a floor. Lay a continuous line of wire between their sides, at the same block level.
3. Stand near the jukebox or a connected speaker and insert your disc as usual.
4. The jukebox and connected speakers play the disc. Eject the disc to stop the whole group.

Connect speakers before inserting the disc. You need only **one disc per network**; speakers do not hold their own discs. Copper wire carries music and does not power or connect to redstone dust.

## Crafting

Use a crafting table. Hover over an ingredient or output to see its name.

### Copper wire

Place **three copper ingots in one horizontal row** to make **12 copper wire**.

```recipe
copper_speakers:copper_wire
```

### Speaker

Use **one paper, one note block, and three copper ingots** to make **one speaker**.

```recipe
copper_speakers:speaker
```

The speaker faces you when placed. Music notes emerge from its front while it plays; facing changes the appearance, not the direction of the sound.

### Wall plate

Use **six copper ingots and one copper wire** to make **two wall plates**.

```recipe
copper_speakers:wall_plate
```

Each wall plate item fits a pair of sockets on opposite faces of one block. You do not need a separate item for each face.

## Route the wire

Place wire on a **solid top surface or a hopper**. It connects horizontally and can climb **one-block steps**, like redstone dust: put wire at the foot of the ledge and on top, leaving headroom above the lower wire. The vertical strip appears automatically. Both bare and insulated wire can climb steps.

Wire cannot run straight up an unsupported wall or jump more than one block at a time. **Jukeboxes, speakers, and wall plates connect at their own block level**; use stepped wire to reach that level. Run branches to speakers instead of using a speaker as a cable junction.

### Through a wall

1. Use a wall plate on a **full, solid block**. Clicking a side chooses the socket faces; clicking the top or bottom chooses a horizontal orientation from the direction you face.
2. Connect wire to either socket, or place a **speaker directly against it**. No wire is needed between the socket and speaker, and either can be placed first. Insulated or waterlogged wire works too.
3. For a thicker wall, fit a plate to **each block along the route**. Ordinary unplated wall blocks do not carry music.

The host keeps its original appearance, with copper sockets on two opposite faces. A plated block connects all four horizontal neighbors at its level, even though only two faces show sockets. Plates do not create vertical connections.

Partial blocks, fluids, speakers, and blocks with block entities such as jukeboxes are unsuitable hosts. Each host takes one pair. Punch an exposed plate to remove the pair and recover **one wall plate item** in survival. Breaking its host or blocking a socket face with an ineligible block also removes the pair.

## Protect wire with resin

Right-click placed bare wire with **one resin clump** to insulate it. In survival this consumes the clump; creative uses none. Place and insulate the wire before adding water.

| Wire | Water behavior |
| --- | --- |
| Bare copper wire | Washes away when water enters it |
| Insulated wire | Survives flowing water; source water can waterlog it without breaking its connection |

Rain does not interrupt playback. Use a bucket to drain waterlogged wire.

To remove insulation, right-click **dry insulated wire with an axe**. The wire stays in place and music continues. In survival this uses one durability and does not return the resin. Drain waterlogged wire before stripping it.

Mining insulated wire in survival returns **one ordinary copper wire and one resin clump**, whether the wire was dry or waterlogged. Mining bare wire returns only the wire; creative mining drops neither.

## Discs and listening

Use your jukebox as usual, including discs from the [music library](/music/). Copper wire and speakers simply extend where you can hear it. Eject the disc to stop the music everywhere.

### Listen around your build

If you were already in the dimension when the song started, **walk or teleport into range** to hear it mid-song. Keep the wire route loaded.

After joining the server or returning from another dimension, you can catch up if the server has prepared that track for late joining. Let the sound packs load, then allow about **3–8 seconds**. Everyone else keeps listening uninterrupted.

If the track is not prepared, or is almost over, wait for the next disc or reinsert it.

Music may take a moment to start, especially with longer tracks. Small timing differences between speakers are possible.

### Change a playing network

If at least one speaker was connected when the song began, up to **four additional speakers at a time** can join during that playback. Disconnecting one of these frees its slot for reuse. Further speakers wait for a free slot or the next disc insertion. A jukebox that started without speakers needs its disc reinserted after wiring it up.

Use **one active jukebox per connected network**. The first playing jukebox claims the speakers; a later disc inserted elsewhere in that network stays silent and does not automatically start when the first finishes. Eject and reinsert it to start a new song. Joining two already-playing networks does not combine their current songs; stop both and restart from one jukebox.

Copper Speakers does not keep chunks loaded. If the main jukebox unloads, the network stops and does not resume automatically when you return. Networks also need a fresh disc insertion after a server restart. A connected network is limited to **4,096 nodes**; exceeding that makes the jukebox play alone.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Custom blocks look wrong | Accept the server resource pack and reconnect if needed. These instructions are verified for Java Edition. |
| Jukebox plays but speakers do not | Check the wire route and loaded chunks, then reinsert the disc. |
| Music is missing or speakers sound out of time | Check that the sound pack is installed. Try fewer speakers or fewer jukeboxes playing at once. |
| A wire step will not connect | Put wire above and below a one-block ledge, leave headroom above the lower wire, and keep endpoints at the wire's level. |
| Music is silent after arriving | After logging in or changing dimensions, let the sound packs load and wait a few seconds. If the track is not prepared for late joining or is almost over, wait for the next disc or reinsert it. |
| A newly added speaker is silent | The four extra-speaker slots may be occupied, or the disc began without a connected speaker. Reinsert the disc with the full network connected. |
| A second jukebox is silent | Stop the network's first jukebox, then eject and reinsert the second disc. |
| The end of a song is cut off | Ejection, hopper extraction, or immediate disc replacement stops any remaining audio. Allow time before removing a disc if loading was slow. |

## Sources

[Copper Speakers 0.2.0](https://github.com/mcneds/Copper-Speakers/releases/tag/v0.2.0) documentation, crafting recipes, and source code, reviewed on **27 October 2026**. Server rollout confirmed by the owner.
