package net.mineandcraft.synclab;

import com.google.gson.GsonBuilder;
import com.mojang.blaze3d.audio.Library;
import com.mojang.blaze3d.audio.Channel;
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
import org.lwjgl.openal.AL11;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static net.mineandcraft.synclab.AudioSyncTest.*;

/** Actual endpoint recordings: vanilla packet starts versus an atomic audio-engine reference. */
public final class MusicCaptureTest implements FabricClientGameTest {
    private final Map<String, Object> report = new LinkedHashMap<>();
    private final List<Map<String, Object>> recordings = new ArrayList<>();
    private Path output;
    private Path exchange;
    private double seconds;
    private int speakerCount;
    private boolean compare;
    private boolean capture;
    private record Scenario(String mode, int repetition, double seconds, boolean capture) {}

    @Override
    public void runTest(ClientGameTestContext context) {
        if (!Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_MUSIC", "false"))) return;
        try { run(context); }
        catch (Exception failure) { throw new RuntimeException("Music output capture failed", failure); }
    }

    private void run(ClientGameTestContext context) throws Exception {
        seconds = Double.parseDouble(System.getenv().getOrDefault("SYNCLAB_MUSIC_SECONDS", "20"));
        int rounds = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_ROUNDS", "6"));
        compare = Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_MUSIC_COMPARE", "false"));
        speakerCount = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_SPEAKERS", "8"));
        capture = true;
        int stress = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_STRESS", "0"));
        Path root = Path.of(System.getenv("SYNCLAB_CAPTURE_DIR")).toAbsolutePath().normalize();
        exchange = root.resolve("exchange");
        Files.createDirectories(exchange);
        output = root.resolve("source-timing.json");
        report.put("started", Instant.now().toString());
        report.put("java", System.getProperty("java.version"));
        report.put("minecraft", "26.3");
        report.put("secondsPerRecording", seconds);
        report.put("rounds", rounds);
        report.put("speakers", speakerCount);
        report.put("comparisonSuite", compare);
        report.put("stressThreads", stress);
        report.put("streamClock", "Native remaining-queue offset plus observed removed-buffer durations");
        report.put("mods", FabricLoader.getInstance().getAllMods().stream().map(m -> m.getMetadata().getId() + "=" + m.getMetadata().getVersion()).sorted().toList());
        report.put("candidate", "Eight vanilla jukebox level events, one server tick, one bundle; stream=false; cold decoded cache");
        report.put("reference", "Same eight native sources, positions and gains; rewind and restart using alSourcePlayv; client-only reference control");
        report.put("recordings", recordings);
        Properties properties = new Properties();
        properties.setProperty("server-ip", "127.0.0.1");
        properties.setProperty("online-mode", "false");
        properties.setProperty("view-distance", "8");
        properties.setProperty("simulation-distance", "8");
        try (var reservation = new java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            properties.setProperty("server-port", Integer.toString(reservation.getLocalPort()));
        }
        Path build = Path.of("build").toAbsolutePath().normalize();
        Path world = build.resolve("music-world").normalize();
        if (!world.startsWith(build)) throw new IllegalStateException("World escaped build directory");
        properties.setProperty("level-name", world.toString());
        context.runOnClient(client -> client.options.renderDistance().set(8));
        try (var server = context.worldBuilder().setUseConsistentSettings(false)
                .adjustSettings(settings -> settings.setSeed("1")).createServer(properties);
             var connection = server.connect()) {
            server.runCommand("tp @a 7.5 92 -8 0 20");
            server.runCommand("gamemode spectator @a");
            List<BlockPos> positions = new ArrayList<>();
            for (int i = 0; i < speakerCount; i++) positions.add(new BlockPos(2 * i, 90, 3));
            server.runOnServer(instance -> {
                for (var pos : positions) {
                    instance.overworld().setBlockAndUpdate(pos.below(), Blocks.COPPER_BLOCK.weathering().unaffected().defaultBlockState());
                    instance.overworld().setBlockAndUpdate(pos, (pos.equals(positions.getFirst()) ? Blocks.JUKEBOX : Blocks.NOTE_BLOCK).defaultBlockState());
                }
            });
            connection.waitForClientboundPackets();
            context.waitFor(client -> client.level.getBlockState(positions.getFirst()).is(Blocks.JUKEBOX));
            context.runOnClient(client -> {
                for (SoundSource category : SoundSource.values())
                    client.options.getSoundSourceOptionInstance(category).set(category == SoundSource.MASTER ? 1.0 : category == SoundSource.RECORDS ? .08 : 0.0);
                client.options.broadcastOptions();
                client.getSoundManager().stop();
            });
            connection.waitForServerboundPackets();
            connection.waitForChunksRender(false);
            context.waitTicks(20);
            SoundEngine engine = context.computeOnClient(client -> field(client.getSoundManager(), "soundEngine"));
            SoundBufferLibrary buffers = field(engine, "soundBuffers");
            ChannelAccess access = field(engine, "channelAccess");
            Library library = field(engine, "library");
            report.put("device", library.currentDeviceName());
            report.put("positions", positions.stream().map(p -> List.of(p.getX(), p.getY(), p.getZ())).toList());
            report.put("recordVolume", .08);
            report.put("serverRequestedViewDistance", server.computeOnServer(instance -> instance.getPlayerList().getPlayers().getFirst().requestedViewDistance()));
            report.put("waitedForTerrainRender", true);
            report.put("screenshot", context.takeScreenshot("music-speakers").toString());
            save();
            List<Scenario> scenarios = new ArrayList<>();
            if (compare) {
                // References first; remaining methods interleaved deterministically.
                scenarios.add(new Scenario("calibration", 0, seconds, true));
                for (int r = 0; r < rounds; r++) {
                    // Hot replay follows a real cold playback, retaining the
                    // already-uploaded native buffer. Alternate streamed order.
                    List<String> modes = r % 2 == 0 ? List.of("streamed", "buffered", "warm") : List.of("buffered", "warm", "streamed");
                    for (String mode : modes) scenarios.add(new Scenario(mode, r + 1, seconds, true));
                }
                double longSeconds = Double.parseDouble(System.getenv().getOrDefault("SYNCLAB_LONG_SECONDS", "0"));
                if (longSeconds > 0) {
                    scenarios.add(new Scenario("streamed", 999, longSeconds, true));
                    scenarios.add(new Scenario("buffered", 999, longSeconds, true));
                }
                int quick = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_QUICK_ROUNDS", "0"));
                for (int r = 0; r < quick; r++)
                    for (String mode : List.of("buffered", "warm")) scenarios.add(new Scenario(mode, 1000 + r, .25, false));
            } else for (int r = 0; r < rounds; r++) scenarios.add(new Scenario("buffered", r + 1, seconds, true));
            report.put("expectedTrials", scenarios.size() + (compare ? 2 : 4));
            report.put("expectedCaptures", (int) scenarios.stream().filter(Scenario::capture).count() + (compare ? 2 : 4));
            try (var load = new CpuLoad(stress)) {
            for (Scenario scenario : scenarios) {
                seconds = scenario.seconds();
                capture = scenario.capture();
                server.runOnServer(instance -> {
                    var player = instance.getPlayerList().getPlayers().getFirst();
                    for (var pos : positions) player.connection.send(new ClientboundLevelEventPacket(1011, pos, 0, false));
                });
                connection.waitForClientboundPackets();
                context.runOnClient(client -> client.getSoundManager().stop());
                barrier(access);
                double prepareMs = 0;
                if (scenario.mode().equals("warm")) {
                    Map<Identifier, CompletableFuture<?>> cached = field(buffers, "cache");
                    var readyBuffer = cached.get(Identifier.fromNamespaceAndPath("musiclab", "sounds/music.ogg"));
                    if (readyBuffer == null || !readyBuffer.isDone() || !(boolean) field(readyBuffer.join(), "hasAlBuffer"))
                        throw new IllegalStateException("Hot replay requires a native buffer retained from the preceding cold playback");
                } else {
                    buffers.clear();
                    barrier(access);
                }
                waitSeconds(context, capture ? .6 : .05);
                String id = compare ? "%s-%03d".formatted(scenario.mode(), scenario.repetition()) : "candidate-%02d".formatted(scenario.repetition());
                begin(context, id);
                PerformanceProbe.Snapshot before = PerformanceProbe.snapshot();
                long submitted = System.nanoTime();
                long tick = server.computeOnServer(instance -> {
                    var registry = instance.registryAccess().lookupOrThrow(Registries.JUKEBOX_SONG);
                    int songId = registry.getId(registry.get(Identifier.fromNamespaceAndPath("musiclab", scenario.mode().equals("streamed") ? "streamed" : "buffered")).orElseThrow().value());
                    List<Packet<? super ClientGamePacketListener>> packets = new ArrayList<>();
                    for (var pos : positions) packets.add(new ClientboundLevelEventPacket(1010, pos, songId, false));
                    instance.getPlayerList().getPlayers().getFirst().connection.send(new ClientboundBundlePacket(packets));
                    return instance.overworld().getGameTime();
                });
                connection.waitForClientboundPackets();
                List<ChannelAccess.ChannelHandle> handles = context.computeOnClient(client -> {
                    Object events = field(client.level, "levelEventHandler");
                    Map<BlockPos, SoundInstance> songs = field(events, "playingJukeboxSongs");
                    Map<SoundInstance, ChannelAccess.ChannelHandle> channels = field(engine, "instanceToChannel");
                    return positions.stream().map(songs::get).map(channels::get).toList();
                });
                record(context, access, handles, id, "vanilla-server", tick, 0, submitted, before, prepareMs);
                if (scenario.mode().equals("calibration") || (!compare && scenario.repetition() == 1)) {
                    for (String control : compare ? List.of("reference-a", "reference-b") : List.of("reference-a", "reference-b", "delay-10ms", "delay-50ms")) {
                        int gap = control.equals("delay-10ms") ? 10 : control.equals("delay-50ms") ? 50 : 0;
                        begin(context, control);
                        before = PerformanceProbe.snapshot();
                        submitted = System.nanoTime();
                        sourceCommand(access, handles, "restart", gap);
                        record(context, access, handles, control, "client-reference-control", -1, gap, submitted, before, 0);
                    }
                }
            }
            }
            context.runOnClient(client -> client.getSoundManager().stop());
            barrier(access);
            report.put("status", "complete");
            report.put("completed", Instant.now().toString());
            save();
        }
    }

    private void begin(ClientGameTestContext context, String id) throws Exception {
        if (!capture) return;
        Files.writeString(exchange.resolve(id + ".start"), "capture\n");
        awaitFile(context, exchange.resolve(id + ".ready"));
        waitSeconds(context, .8); // Record a quiet lead-in for contamination checks.
    }

    private void record(ClientGameTestContext context, ChannelAccess access, List<ChannelAccess.ChannelHandle> handles,
                        String id, String kind, long serverTick, int gap, long submitted, PerformanceProbe.Snapshot before, double prepareMs) throws Exception {
        List<Map<String, Object>> observations = new ArrayList<>();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        List<Sample> samples;
        do {
            samples = observe(access, handles);
            if (samples.size() == speakerCount && samples.stream().allMatch(s -> s.state() == AL10.AL_PLAYING && s.offsetSeconds() > .05)) break;
            if (System.nanoTime() > deadline) throw new IllegalStateException("Sources never became ready: " + samples);
            context.waitTick();
        } while (true);
        long start = System.nanoTime();
        double observedReadyMs = (start - submitted) / 1e6;
        double approximateFirstStartMs = observedReadyMs - samples.stream().mapToDouble(Sample::offsetSeconds).max().orElseThrow() * 1000;
        PerformanceProbe.Snapshot ready = PerformanceProbe.snapshot();
        Map<String, Object> bufferInfo = bufferStats(access, handles);
        double next = 0;
        while (true) {
            double elapsed = (System.nanoTime() - start) / 1e9;
            if (elapsed >= next) {
                samples = observe(access, handles);
                if (samples.size() != speakerCount || samples.stream().anyMatch(s -> s.state() != AL10.AL_PLAYING || s.error() != 0))
                    throw new IllegalStateException("Invalid source during capture: " + id);
                observations.add(Map.of("elapsedSeconds", elapsed, "spreadMs", spread(samples), "sources", samples));
                next += Math.min(1, seconds / 2);
            }
            if (elapsed >= seconds) break;
            context.waitTick();
        }
        PerformanceProbe.Snapshot end = PerformanceProbe.snapshot();
        Map<String, Object> finalBuffers = bufferStats(access, handles);
        sourceCommand(access, handles, "pause", 0);
        if (capture) {
        waitSeconds(context, .7);
        Files.writeString(exchange.resolve(id + ".stop"), "capture complete\n");
        awaitFile(context, exchange.resolve(id + ".done"));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", id);
        result.put("kind", kind);
        result.put("serverTick", serverTick);
        result.put("intentionalHalfGroupDelayMs", gap);
        result.put("captured", capture);
        result.put("durationSeconds", seconds);
        result.put("prepareBufferMs", prepareMs);
        result.put("observedReadyMs", observedReadyMs);
        result.put("approximateFirstStartMs", approximateFirstStartMs);
        result.put("startupPerformance", PerformanceProbe.delta(before, ready));
        result.put("playbackPerformance", PerformanceProbe.delta(ready, end));
        result.put("initialBuffers", bufferInfo);
        result.put("finalBuffers", finalBuffers);
        result.put("observations", observations);
        recordings.add(result);
        save();
        System.out.println("MUSIC_CAPTURE " + id + " spreadMs=" + observations.getFirst().get("spreadMs"));
    }

    private static Map<String, Object> bufferStats(ChannelAccess access, List<ChannelAccess.ChannelHandle> handles) throws Exception {
        CompletableFuture<Map<String, Object>> done = new CompletableFuture<>();
        access.executeOnChannels(ignored -> {
            try {
                List<Map<String, Object>> sources = new ArrayList<>();
                Map<Integer, Integer> staticBuffers = new HashMap<>();
                for (var handle : handles) {
                    Channel channel = field(handle, "channel");
                    int source = field(channel, "source");
                    int buffer = AL10.alGetSourcei(source, AL10.AL_BUFFER);
                    boolean streamed = field(channel, "stream") != null;
                    if (!streamed && buffer != 0) staticBuffers.put(buffer, AL10.alGetBufferi(buffer, AL10.AL_SIZE));
                    sources.add(Map.of("source", source, "staticBuffer", streamed ? 0 : buffer,
                            "streamed", streamed, "queuedBuffers", AL10.alGetSourcei(source, AL10.AL_BUFFERS_QUEUED),
                            "streamingBufferSize", (int) field(channel, "streamingBufferSize"), "streamQueue", StreamQueueTracker.stats(source)));
                }
                int error = AL10.alGetError();
                if (error != 0) throw new IllegalStateException("Buffer observation error " + error);
                done.complete(Map.of("sources", sources, "uniqueStaticBuffers", staticBuffers.size(),
                        "staticPcmBytes", staticBuffers.values().stream().mapToLong(Integer::longValue).sum()));
            } catch (Throwable failure) { done.completeExceptionally(failure); }
        });
        return done.get(10, TimeUnit.SECONDS);
    }

    private static void sourceCommand(ChannelAccess access, List<ChannelAccess.ChannelHandle> handles,
                                      String command, int gapMs) throws Exception {
        CompletableFuture<Void> done = new CompletableFuture<>();
        access.executeOnChannels(ignored -> {
            try {
                int[] ids = new int[handles.size()];
                for (int i = 0; i < ids.length; i++) ids[i] = field(field(handles.get(i), "channel"), "source");
                if (command.equals("pause")) AL10.alSourcePausev(ids);
                else {
                    AL10.alSourceRewindv(ids);
                    // A deterministic relative offset for positive controls.
                    // Advancing alternate sources avoids scheduler jitter in a
                    // Thread.sleep-based delay. The asset is exactly 48 kHz.
                    for (int i = 0; i < ids.length; i++)
                        AL10.alSourcei(ids[i], AL11.AL_SAMPLE_OFFSET, i % 2 == 0 ? gapMs * 48 : 0);
                    AL10.alSourcePlayv(ids);
                }
                int error = AL10.alGetError();
                if (error != AL10.AL_NO_ERROR) throw new IllegalStateException("Control error " + error);
                done.complete(null);
            } catch (Throwable failure) { done.completeExceptionally(failure); }
        });
        done.get(10, TimeUnit.SECONDS);
    }

    private static void waitSeconds(ClientGameTestContext context, double seconds) {
        long until = System.nanoTime() + (long) (seconds * 1e9);
        do { context.waitTick(); } while (System.nanoTime() < until);
    }

    private static void awaitFile(ClientGameTestContext context, Path path) {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (!Files.exists(path)) {
            if (System.nanoTime() > until) throw new IllegalStateException("Recorder did not acknowledge " + path);
            context.waitTick();
        }
    }

    private void save() throws Exception {
        Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report) + "\n");
    }
}
