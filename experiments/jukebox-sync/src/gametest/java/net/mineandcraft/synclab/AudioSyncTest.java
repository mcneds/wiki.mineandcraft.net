package net.mineandcraft.synclab;

import com.google.gson.GsonBuilder;
import com.mojang.blaze3d.audio.Channel;
import com.mojang.blaze3d.audio.Library;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.client.resources.sounds.SoundInstance;
import net.minecraft.client.sounds.ChannelAccess;
import net.minecraft.client.sounds.SoundBufferLibrary;
import net.minecraft.client.sounds.SoundEngine;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.resources.Identifier;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.phys.Vec3;
import org.lwjgl.openal.AL;
import org.lwjgl.openal.AL10;
import org.lwjgl.openal.SOFTDeviceClock;
import org.lwjgl.openal.SOFTSourceLatency;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.Collections;
import java.util.Random;

/** Observation harness: vanilla SoundEngine/Channel playback is not patched. */
public final class AudioSyncTest implements FabricClientGameTest {
    private static final Identifier AUDIO = Identifier.fromNamespaceAndPath("synclab", "sounds/probe.ogg");
    private final List<Trial> results = new ArrayList<>();

    public record Sample(int source, int state, double offsetSeconds, double deviceClockSeconds,
                         double inferredStartSeconds, int error) {}
    public record Trial(String mode, int seconds, int speakers, int repetition, int submitGapMs, double submitMs,
                        double readyMs, double initialSpreadMs, double laterSpreadMs,
                        List<Sample> initial, List<Sample> later) {}

    @Override
    public void runTest(ClientGameTestContext context) {
        if (Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_MUSIC", "false"))) return;
        if (System.getenv().getOrDefault("SYNCLAB_NETWORK", "false").equals("true")) return;
        try {
            runMeasurements(context);
        } catch (Exception failure) {
            throw new RuntimeException("Audio synchronization experiment failed", failure);
        }
    }

    private void runMeasurements(ClientGameTestContext context) throws Exception {
        int rounds = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_ROUNDS", "3"));
        boolean full = System.getenv().getOrDefault("SYNCLAB_FULL", "false").equals("true");
        int stressThreads = Integer.parseInt(System.getenv().getOrDefault("SYNCLAB_STRESS", "0"));
        String runName = System.getenv().getOrDefault("SYNCLAB_RUN", "debug-smoke");
        SoundEngine engine = context.computeOnClient(client -> field(client.getSoundManager(), "soundEngine"));
        SoundBufferLibrary buffers = field(engine, "soundBuffers");
        ChannelAccess access = field(engine, "channelAccess");
        Library library = field(engine, "library");
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("started", Instant.now().toString());
        report.put("minecraft", "26.3");
        report.put("java", System.getProperty("java.version"));
        report.put("javaVendor", System.getProperty("java.vendor"));
        report.put("diagnosticVmFlags", java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments().stream()
            .filter(arg -> arg.startsWith("-X")).toList());
        report.put("os", System.getProperty("os.name"));
        report.put("device", library.currentDeviceName());
        report.put("sampleRate", 44100);
        report.put("rounds", rounds);
        report.put("stressThreads", stressThreads);
        report.put("mods", FabricLoader.getInstance().getAllMods().stream()
            .map(mod -> mod.getMetadata().getId() + "=" + mod.getMetadata().getVersion()).sorted().toList());
        report.put("method", "Vanilla SoundManager.play -> SoundEngine -> Channel; AL_SEC_OFFSET_CLOCK_SOFT observations on sound thread");
        report.put("scope", "One client, same client task; no server/network, no physical output recording");
        report.put("trials", results);
        Path output = Path.of("results", runName + ".json").toAbsolutePath().normalize();
        Files.createDirectories(output.getParent());
        context.runOnClient(client -> {
            client.options.getSoundSourceOptionInstance(SoundSource.MASTER).set(1.0);
            client.options.getSoundSourceOptionInstance(SoundSource.RECORDS).set(0.03);
            client.options.getSoundSourceOptionInstance(SoundSource.MUSIC).set(0.0);
            client.getSoundManager().stop();
        });
        barrier(access);
        try (var load = new CpuLoad(stressThreads)) {
            record Case(String mode, int seconds, int count, int repetition, int gapMs) {}
            List<Case> cases = new ArrayList<>();
            for (int seconds : full ? new int[]{12, 180} : new int[]{12})
                for (String mode : List.of("streamed", "buffered-cold", "preloaded"))
                    for (int count : new int[]{2, 4, 8})
                        for (int repetition = 0; repetition < rounds; repetition++)
                            cases.add(new Case(mode, seconds, count, repetition, 0));
            // Known delayed starts validate that a zero result is not a broken measurement.
            for (int gap : new int[]{20, 50})
                for (int repetition = 0; repetition < rounds; repetition++)
                    cases.add(new Case("preloaded", 12, 2, repetition, gap));
            Collections.shuffle(cases, new Random(20261026));
            report.put("expectedTrials", cases.size());
            for (Case scenario : cases) {
                String mode = scenario.mode();
                int count = scenario.count();
                int repetition = scenario.repetition();
                Identifier audio = scenario.seconds() == 12 ? AUDIO : Identifier.fromNamespaceAndPath("synclab", "sounds/long_probe.ogg");
                context.runOnClient(client -> client.getSoundManager().stop());
                barrier(access);
                buffers.clear();
                barrier(access);
                if (mode.equals("preloaded")) buffers.getCompleteBuffer(audio).get(15, TimeUnit.SECONDS);
                String soundName = (mode.equals("buffered-cold") ? "buffered" : mode) + (scenario.seconds() == 180 ? "_long" : "");
                List<SoundInstance> sounds = new ArrayList<>();
                long submitted = System.nanoTime();
                context.runOnClient(client -> {
                    SoundManager manager = client.getSoundManager();
                    for (int i = 0; i < count; i++) {
                        if (i > 0 && scenario.gapMs() > 0) Thread.sleep(scenario.gapMs());
                        // Exactly the factory used by vanilla LevelEventHandler for jukebox playback.
                        var sound = SimpleSoundInstance.forJukeboxSong(
                            SoundEvent.createVariableRangeEvent(Identifier.fromNamespaceAndPath("synclab", soundName)),
                            new Vec3(i - count / 2.0, 0, -2));
                        sounds.add(sound);
                        if (manager.play(sound) != SoundEngine.PlayResult.STARTED)
                            throw new IllegalStateException("Playback rejected: " + soundName + " / " + count);
                    }
                });
                double submitMs = (System.nanoTime() - submitted) / 1e6;
                List<ChannelAccess.ChannelHandle> handles = context.computeOnClient(client -> {
                    Map<SoundInstance, ChannelAccess.ChannelHandle> channels = field(engine, "instanceToChannel");
                    return sounds.stream().map(channels::get).toList();
                });
                List<Sample> initial;
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                do {
                    initial = observe(access, handles);
                    if (initial.size() == count && initial.stream().allMatch(s -> s.state == AL10.AL_PLAYING && s.offsetSeconds > 0.025)) break;
                    if (System.nanoTime() > deadline) throw new IllegalStateException("Channels never ready: " + initial);
                    Thread.sleep(5);
                } while (true);
                double readyMs = (System.nanoTime() - submitted) / 1e6;
                Thread.sleep(200);
                List<Sample> later = observe(access, handles);
                Trial result = new Trial(mode, scenario.seconds(), count, repetition, scenario.gapMs(), submitMs, readyMs,
                    spread(initial), spread(later), initial, later);
                if (initial.stream().anyMatch(s -> s.error() != 0) || later.size() != count ||
                    later.stream().anyMatch(s -> s.state() != AL10.AL_PLAYING || s.error() != 0))
                    throw new IllegalStateException("Incomplete or invalid source measurements");
                if (scenario.gapMs() == 50 && result.initialSpreadMs() < 30)
                    throw new IllegalStateException("Delayed-start control failed: " + result);
                results.add(result); // Safe debugger logpoint: measurement already completed.
                writeReport(output, report);
                context.waitTick(); // Pump the window between isolated audio trials.
            }
            report.put("completed", Instant.now().toString());
            report.put("status", "complete");
        } finally {
            context.runOnClient(client -> client.getSoundManager().stop());
            barrier(access);
            writeReport(output, report);
        }
    }

    private static void writeReport(Path output, Map<String, Object> report) throws Exception {
        Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report) + "\n");
    }

    static double spread(List<Sample> samples) {
        double[] starts = samples.stream().mapToDouble(Sample::inferredStartSeconds).toArray();
        return (Arrays.stream(starts).max().orElseThrow() - Arrays.stream(starts).min().orElseThrow()) * 1000;
    }

    static List<Sample> observe(ChannelAccess access, List<ChannelAccess.ChannelHandle> handles) throws Exception {
        CompletableFuture<List<Sample>> future = new CompletableFuture<>();
        access.executeOnChannels(ignored -> {
            try {
                if (!AL.getCapabilities().AL_SOFT_source_latency)
                    throw new IllegalStateException("AL_SOFT_source_latency required for clock-paired measurements");
                List<Sample> samples = new ArrayList<>();
                for (var handle : handles) {
                    if (handle == null) continue;
                    Channel channel = field(handle, "channel");
                    if (channel == null) continue;
                    int source = field(channel, "source");
                    int state = AL10.alGetSourcei(source, AL10.AL_SOURCE_STATE);
                    double[] timing = new double[2];
                    SOFTSourceLatency.alGetSourcedvSOFT(source, SOFTDeviceClock.AL_SEC_OFFSET_CLOCK_SOFT, timing);
                    // Native stream offsets are relative to the remaining queue.
                    // Counting removed buffers preserves the absolute song position.
                    timing[0] += StreamQueueTracker.removedSeconds(source);
                    int error = AL10.alGetError();
                    if (error != AL10.AL_NO_ERROR) throw new IllegalStateException("OpenAL timing query error: " + error);
                    samples.add(new Sample(source, state, timing[0], timing[1], timing[1] - timing[0], error));
                }
                future.complete(samples);
            } catch (Throwable failure) {
                future.completeExceptionally(failure);
            }
        });
        return future.get(10, TimeUnit.SECONDS);
    }

    static void barrier(ChannelAccess access) throws Exception {
        CompletableFuture<Void> done = new CompletableFuture<>();
        access.executeOnChannels(ignored -> done.complete(null));
        done.get(10, TimeUnit.SECONDS);
    }

    @SuppressWarnings("unchecked")
    static <T> T field(Object target, String name) {
        try {
            Field field = target.getClass().getDeclaredField(name);
            field.setAccessible(true);
            return (T) field.get(target);
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("Minecraft field changed: " + name, failure);
        }
    }
}
