# Socket-face connections

This patch changes Copper Speakers wall plates from four-way horizontal junctions to connections through their two visible socket faces. Wire models and audio routing use the same rule. Adjacent plated blocks must both expose a socket along their shared edge. Existing plates retain their saved orientation and refresh adjacent wire states when loaded.

Upstream: https://github.com/mcneds/Copper-Speakers, tag `v0.2.0`, commit `868069b01189a91bfc7adef91b55fcc24fa1eb4a`. The accompanying patch includes implementation, documentation, and registered Minecraft tests. Upstream code is MIT licensed; see LICENSE.

Installed version: `0.2.1+mineandcraft.1`.

Reproduce with JDK 25:

```sh
git clone https://github.com/mcneds/Copper-Speakers.git
cd Copper-Speakers
git checkout 868069b01189a91bfc7adef91b55fcc24fa1eb4a
git apply /path/to/socket-faces.patch
./gradlew build
```

Validation on 2026-10-27: all 45 required Minecraft GameTests and all four JUnit graph tests passed. New coverage checks all four plate orientations with bare and resin-coated wires, wire-port state, actual jukebox playback sources, and aligned/mismatched plate chains. The local GameTest JVM used `-XX:ActiveProcessorCount=2 -XX:TieredStopAtLevel=1 -Xmx2G` to avoid a local JVM startup issue. These flags do not affect the built jar or production server.

Built jar: `copper-speakers-0.2.1+mineandcraft.1.jar`, SHA-256 `c1a72146675f643af8f762436c73738bab715ea95d6150627356f2700d2f8aa2`.

The server deployment helper `../deploy_socket_faces.py` saves the previous jar, stops the server, installs the new jar, and checks mod and Bedrock extension startup. A failed startup restores the previous jar. Backups, the patched jar, sources jar, and installation receipt remain under `/home/ubuntu/copper-bedrock/` on the server. Client rendering and listening checks are separate from the automated tests.
