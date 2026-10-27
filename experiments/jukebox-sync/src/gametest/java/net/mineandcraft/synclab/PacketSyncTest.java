package net.mineandcraft.synclab;

import com.google.gson.GsonBuilder;
import com.mojang.blaze3d.audio.Library;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.resources.sounds.SoundInstance;
import net.minecraft.client.sounds.ChannelAccess;
import net.minecraft.client.sounds.SoundBufferLibrary;
import net.minecraft.client.sounds.SoundEngine;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientGamePacketListener;
import net.minecraft.network.protocol.game.ClientboundBundlePacket;
import net.minecraft.network.protocol.game.ClientboundLevelEventPacket;
import net.minecraft.resources.Identifier;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.level.block.Blocks;
import org.lwjgl.openal.AL10;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;

import static net.mineandcraft.synclab.AudioSyncTest.*;

/** Same-tick vanilla jukebox events over a loopback dedicated-server connection. */
public final class PacketSyncTest implements FabricClientGameTest {
    record Case(String mode, String delivery, int seconds, int speakers, int repetition) {}
    record Trial(String delivery, String mode, int seconds, int speakers, int repetition,
                 int submitGapMs, long serverTick, double readyMs, double initialSpreadMs,
                 double laterSpreadMs, List<Sample> initial, List<Sample> later) {}

    @Override
    public void runTest(ClientGameTestContext context) {
        if (Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_MUSIC", "false"))) return;
        if (!System.getenv().getOrDefault("SYNCLAB_NETWORK", "false").equals("true")) return;
        try {
            measure(context);
        } catch (Exception failure) {
            throw new RuntimeException("Loopback packet test failed", failure);
        }
    }

    private void measure(ClientGameTestContext context) throws Exception {
        int rounds = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_ROUNDS", "10"));
        boolean full = Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_FULL", "false"));
        int stressThreads = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_STRESS", "0"));
        context.runOnClient(client -> client.options.renderDistance().set(8));
        String run = System.getenv().getOrDefault("SYNCLAB_RUN", "packets");
        Properties properties = new Properties();
        properties.setProperty("server-ip", "127.0.0.1");
        properties.setProperty("online-mode", "false");
        // The gametest connector uses server.getPort(), which retains the configured
        // value rather than the actual bound port when configured as zero.
        try (var reservation = new java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            properties.setProperty("server-port", Integer.toString(reservation.getLocalPort()));
        }
        properties.setProperty("view-distance", "8");
        properties.setProperty("simulation-distance", "8");
        Path build = Path.of("build").toAbsolutePath().normalize();
        Path world = build.resolve("packet-world").normalize();
        if (!world.startsWith(build)) throw new IllegalStateException("Test world escaped build directory");
        properties.setProperty("level-name", world.toString());
        try (var server = context.worldBuilder().setUseConsistentSettings(false)
                .adjustSettings(settings -> settings.setSeed("1")).createServer(properties); var connection = server.connect()) {
            server.runCommand("tp @a 7.5 92 -8 0 20");
            server.runCommand("gamemode spectator @a");
            List<BlockPos> positions = new ArrayList<>();
            for (int i = 0; i < 8; i++) positions.add(new BlockPos(i * 2, 90, 3));
            server.runOnServer(instance -> {
                for (var pos : positions) {
                    instance.overworld().setBlockAndUpdate(pos.below(), Blocks.COPPER_BLOCK.weathering().unaffected().defaultBlockState());
                    instance.overworld().setBlockAndUpdate(pos, (pos.equals(positions.getFirst()) ? Blocks.JUKEBOX : Blocks.NOTE_BLOCK).defaultBlockState());
                }
            });
            connection.waitForClientboundPackets();
            context.waitFor(client -> client.level.getBlockState(positions.getFirst()).is(Blocks.JUKEBOX));
            context.waitTicks(20);
            SoundEngine engine = context.computeOnClient(client -> field(client.getSoundManager(), "soundEngine"));
            SoundBufferLibrary buffers = field(engine, "soundBuffers");
            ChannelAccess access = field(engine, "channelAccess");
            Library library = field(engine, "library");
            context.runOnClient(client -> {
                client.options.getSoundSourceOptionInstance(SoundSource.MASTER).set(1.0);
                client.options.getSoundSourceOptionInstance(SoundSource.RECORDS).set(0.03);
                client.options.getSoundSourceOptionInstance(SoundSource.MUSIC).set(0.0);
                client.options.broadcastOptions();
            });
            connection.waitForServerboundPackets();
            int requestedViewDistance = server.computeOnServer(instance -> instance.getPlayerList().getPlayers().getFirst().requestedViewDistance());
            if (requestedViewDistance != 8) throw new IllegalStateException("Client did not request the intended view distance");
            // The helper's download check expects a full square, while vanilla
            // sends a rounded region. Wait for received meshes instead.
            connection.waitForChunksRender(false);
            context.waitTicks(20);
            Map<String, Object> report = new LinkedHashMap<>();
            List<Trial> trials = new ArrayList<>();
            report.put("started", Instant.now().toString());
            report.put("minecraft", "26.3");
            report.put("java", System.getProperty("java.version"));
            report.put("javaVendor", System.getProperty("java.vendor"));
            report.put("diagnosticVmFlags", java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments().stream()
                .filter(arg -> arg.startsWith("-X")).toList());
            report.put("device", library.currentDeviceName());
            report.put("rounds", rounds);
            report.put("stressThreads", stressThreads);
            report.put("scope", "Local dedicated server; real vanilla level-event packets and LevelEventHandler; one instrumented client");
            report.put("world", "Normal terrain, seed 1, view/simulation distance 8; gametest ticks advance during observations");
            report.put("waitedForTerrainRender", true);
            report.put("serverRequestedViewDistance", requestedViewDistance);
            report.put("initialWorldTick", server.computeOnServer(instance -> instance.overworld().getGameTime()));
            report.put("viewport", context.computeOnClient(client -> Map.of(
                "width", client.getWindow().getScreenWidth(), "height", client.getWindow().getScreenHeight())));
            if (Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_SCREENSHOT", "false")))
                report.put("screenshot", context.takeScreenshot("speaker-scene").toString());
            report.put("mods", FabricLoader.getInstance().getAllMods().stream()
                .map(mod -> mod.getMetadata().getId() + "=" + mod.getMetadata().getVersion()).sorted().toList());
            report.put("trials", trials);
            Path output = Path.of("results", run + ".json");
            Files.createDirectories(output.getParent());
            List<Case> cases = new ArrayList<>();
            for (int seconds : full ? new int[]{12, 180} : new int[]{12})
                for (String mode : List.of("streamed", "buffered-cold", "preloaded"))
                    for (String delivery : List.of("individual", "bundle"))
                        for (int count : new int[]{2, 4, 8})
                            for (int i = 0; i < rounds; i++) cases.add(new Case(mode, delivery, seconds, count, i));
            Collections.shuffle(cases, new Random(20261026));
            report.put("expectedTrials", cases.size());
            try (var load = new CpuLoad(stressThreads)) {
                for (Case scenario : cases) {
                    server.runOnServer(instance -> {
                        var player = instance.getPlayerList().getPlayers().getFirst();
                        for (var pos : positions) player.connection.send(new ClientboundLevelEventPacket(1011, pos, 0, false));
                    });
                    connection.waitForClientboundPackets();
                    context.runOnClient(client -> client.getSoundManager().stop());
                    barrier(access);
                    buffers.clear();
                    barrier(access);
                    if (scenario.mode().equals("preloaded"))
                        buffers.getCompleteBuffer(Identifier.fromNamespaceAndPath("synclab", scenario.seconds() == 12 ? "sounds/probe.ogg" : "sounds/long_probe.ogg")).get(15, TimeUnit.SECONDS);
                    String songName = (scenario.mode().equals("buffered-cold") ? "buffered" : scenario.mode()) + (scenario.seconds() == 180 ? "_long" : "");
                    long sent = System.nanoTime();
                    long tick = server.computeOnServer(instance -> {
                        var registry = instance.registryAccess().lookupOrThrow(Registries.JUKEBOX_SONG);
                        int songId = registry.getId(registry.get(Identifier.fromNamespaceAndPath("synclab", songName)).orElseThrow().value());
                        var player = instance.getPlayerList().getPlayers().getFirst();
                        List<Packet<? super ClientGamePacketListener>> packets = new ArrayList<>();
                        for (int i = 0; i < scenario.speakers(); i++)
                            packets.add(new ClientboundLevelEventPacket(1010, positions.get(i), songId, false));
                        if (scenario.delivery().equals("bundle")) player.connection.send(new ClientboundBundlePacket(packets));
                        else for (var packet : packets) player.connection.send(packet);
                        return instance.overworld().getGameTime();
                    });
                    connection.waitForClientboundPackets();
                    List<ChannelAccess.ChannelHandle> handles = context.computeOnClient(client -> {
                        Object eventHandler = field(client.level, "levelEventHandler");
                        Map<BlockPos, SoundInstance> songs = field(eventHandler, "playingJukeboxSongs");
                        Map<SoundInstance, ChannelAccess.ChannelHandle> channels = field(engine, "instanceToChannel");
                        return positions.subList(0, scenario.speakers()).stream().map(songs::get).map(channels::get).toList();
                    });
                    List<Sample> initial;
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                    do {
                        initial = observe(access, handles);
                        if (initial.size() == scenario.speakers() && initial.stream().allMatch(s -> s.state() == AL10.AL_PLAYING && s.offsetSeconds() > .025)) break;
                        if (System.nanoTime() > deadline) throw new IllegalStateException("Missing packet-created sound sources: " + scenario + " / " + initial);
                        context.waitTick();
                    } while (true);
                    double readyMs = (System.nanoTime() - sent) / 1e6;
                    long observeUntil = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(200);
                    do { context.waitTick(); } while (System.nanoTime() < observeUntil);
                    List<Sample> later = observe(access, handles);
                    if (later.size() != scenario.speakers() || later.stream().anyMatch(s -> s.state() != AL10.AL_PLAYING))
                        throw new IllegalStateException("Source stopped during observation");
                    Trial result = new Trial(scenario.delivery(), scenario.mode(), scenario.seconds(), scenario.speakers(), scenario.repetition(),
                        0, tick, readyMs, spread(initial), spread(later), initial, later);
                    trials.add(result);
                    Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report) + "\n");
                }
                report.put("status", "complete");
                report.put("finalWorldTick", server.computeOnServer(instance -> instance.overworld().getGameTime()));
                report.put("completed", Instant.now().toString());
            } finally {
                Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report) + "\n");
            }
        }
    }
}
