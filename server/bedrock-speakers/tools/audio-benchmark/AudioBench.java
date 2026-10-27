package net.mineandcraft.bedrockspeakers.debug;

import com.google.gson.Gson;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.lang.reflect.*;
import org.cloudburstmc.math.vector.Vector3f;
import org.geysermc.geyser.GeyserImpl;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.*;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.*;

/** Controlled, packet-only audio trials for one consenting Bedrock tester. No world edits. */
public final class AudioBench {
    private static final String SOUND = "mineandcraft_music:buffered.disc_488b53e5a55a465d8d093b86d24535fa";
    private static final AtomicLong IDS = new AtomicLong(0x2000000000000000L);
    private static final List<Map<String, Object>> EVENTS = new CopyOnWriteArrayList<>();
    private static volatile Object generation;
    private static long[] handles = new long[0];
    private static long began;
    private static String mode;
    private static final int[] FAKE_IDS = {-2000000001, -2000000002, -2000000003};
    private static Object extension, listener;
    private static org.cloudburstmc.math.vector.Vector3i jukeboxPosition;
    private static Object value(Object instance, String name) throws Exception {
        var field = instance.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(instance);
    }
    private static Object call(Object object, String method, Object... arguments) throws Exception {
        for (var candidate : object.getClass().getDeclaredMethods()) {
            if (!candidate.getName().equals(method) || candidate.getParameterCount() != arguments.length) continue;
            candidate.setAccessible(true); return candidate.invoke(object, arguments);
        }
        throw new NoSuchMethodException(method);
    }
    @SuppressWarnings("unchecked")
    private static void production(GeyserSession session, boolean late) throws Exception {
        extension = GeyserImpl.getInstance().extensionManager().extension("copperbedrock");
        if (extension == null) throw new IllegalStateException("CopperBedrock extension is not loaded");
        listener = call(extension, "listener", session);
        var field = listener.getClass().getDeclaredField("positions"); field.setAccessible(true);
        var positions = (Map<Integer, Vector3f>) field.get(listener);
        if (mode.equals("jukebox")) {
            jukeboxPosition = session.getPlayerEntity().position().toInt();
            var registry = org.geysermc.geyser.registry.java.JavaRegistries.JUKEBOX_SONG;
            int song = java.util.stream.IntStream.range(0, 4096).filter(id -> registry.get(session.javaRegistries(), id)
                    .map(record -> record.soundEvent().equals(SOUND.replace(":buffered.", ":"))).orElse(false))
                    .findFirst().orElseThrow(() -> new IllegalStateException("Test recording is absent from the jukebox registry"));
            Object audio = value(listener, "audio");
            var active = (Map<Long, Object>) value(audio, "active");
            var before = Set.copyOf(active.keySet());
            var packet = new org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.level.ClientboundLevelEventPacket(
                    org.geysermc.mcprotocollib.protocol.data.game.level.event.LevelEventType.SOUND_PLAY_JUKEBOX_SONG,
                    jukeboxPosition, new org.geysermc.mcprotocollib.protocol.data.game.level.event.RecordEventData(song));
            if (!Boolean.TRUE.equals(call(extension, "levelEvent", session, packet))) throw new IllegalStateException("Jukebox translator rejected test song");
            handles[0] = active.keySet().stream().filter(handle -> !before.contains(handle)).findFirst().orElseThrow();
            Object entry = active.get(handles[0]);
            // Preserve the production sound, clock, handle and preparation. Clamp only test
            // volume and position to match the two co-located comparison voices safely.
            call(audio, "start", handles[0], value(entry, "sound"), session.getPlayerEntity().position(),
                    volume(0), 1f, value(entry, "clock"), true);
            event("production-jukebox", 0);
        }
        for (int i = 0; i < 3; i++) {
            if (mode.equals("jukebox") && i == 0) continue;
            var position = session.getPlayerEntity().position();
            positions.put(FAKE_IDS[i], late && i == 2 ? position.add(0, 4096, 0) : position);
            var sound = new org.geysermc.mcprotocollib.protocol.data.game.level.sound.CustomSound(SOUND, false, 0);
            var packet = new org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.ClientboundSoundEntityPacket(
                    sound, org.geysermc.mcprotocollib.protocol.data.game.level.sound.SoundCategory.MASTER,
                    FAKE_IDS[i], volume(i), 1, 0L);
            if (!Boolean.TRUE.equals(call(extension, "soundEntity", session, packet)))
                throw new IllegalStateException("Production translator did not handle benchmark sound");
            handles[i] = 0x4000000000000000L | Integer.toUnsignedLong(FAKE_IDS[i]);
            event("production-play", i);
        }
    }
    private static GeyserSession target() {
        return GeyserImpl.getInstance().getSessionManager().getAllSessions().stream()
                .filter(s -> s.bedrockUsername().equals("Mcneds7663")).findFirst().orElseThrow();
    }
    private static void event(String kind, int voice) {
        var position = target().getPlayerEntity().position();
        EVENTS.add(Map.of("event", kind, "voice", voice, "elapsed", (System.nanoTime() - began) / 1e9,
                "utcMillis", System.currentTimeMillis(), "listenerPosition", List.of(position.getX(), position.getY(), position.getZ())));
    }
    private static void update(GeyserSession session, long handle, SoundData data) {
        var packet = new ClientboundUpdateSoundDataPacket(); packet.setServerSoundHandle(handle); packet.setEvent(data);
        session.sendUpstreamPacket(packet);
    }
    private static float volume(int voice) { return voice == 0 ? .25f : .125f; }
    private static void gate(GeyserSession session, int partner) {
        for (int i = 0; i < handles.length; i++) update(session, handles[i],
                new SetVolumeSoundData(i == 0 || partner < 0 || partner == i ? volume(i) : 0));
        event("pair", partner);
    }
    private static void stop(GeyserSession session) {
        if (extension != null) {
            try {
                if (jukeboxPosition != null) {
                    call(extension, "levelEvent", session,
                            new org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.level.ClientboundLevelEventPacket(
                            org.geysermc.mcprotocollib.protocol.data.game.level.event.LevelEventType.SOUND_STOP_JUKEBOX_SONG,
                            jukeboxPosition, new org.geysermc.mcprotocollib.protocol.data.game.level.event.RecordEventData(0)));
                    jukeboxPosition = null;
                }
                call(extension, "removeEntities", session,
                    new org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.entity.ClientboundRemoveEntitiesPacket(FAKE_IDS)); }
            catch (Exception error) { throw new RuntimeException(error); }
            extension = null; listener = null;
        }
        for (long handle : handles) update(session, handle, new StopSoundData());
    }
    private static void later(GeyserSession session, Object token, long milliseconds, Runnable action) {
        session.scheduleInEventLoop(() -> { if (generation == token && !session.isClosed()) action.run(); }, milliseconds, TimeUnit.MILLISECONDS);
    }
    private static String run(String selected) throws Exception {
        var session = target(); var done = new CountDownLatch(1);
        var error = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        session.executeInEventLoop(() -> {
            try {
                stop(session); generation = new Object(); Object token = generation;
                mode = selected; EVENTS.clear(); began = System.nanoTime();
                // Stop only this event on this tester, so existing music cannot contaminate the capture.
                var clear = new StopSoundPacket(); clear.setSoundName(""); clear.setStoppingAllSound(true);
                clear.setStopMusicLegacy(true); session.sendUpstreamPacket(clear);
                handles = selected.equals("single") ? new long[]{IDS.getAndIncrement()}
                        : new long[]{IDS.getAndIncrement(), IDS.getAndIncrement(), IDS.getAndIncrement()};
                Vector3f position = session.getPlayerEntity().position();
                boolean continuous = selected.equals("continuous");
                boolean real = selected.equals("production") || selected.equals("late") || selected.equals("jukebox") || continuous;
                if (real) production(session, selected.equals("late") || continuous);
                for (int i = 0; !real && i < handles.length; i++) {
                    final int voice = i;
                    Runnable play = () -> {
                        var start = new PlaySoundPacket(); start.setSound(SOUND); start.setPosition(position);
                        start.setPitch(1); start.setVolume(Set.of("seek", "pause", "settle", "pause5", "control").contains(selected) ? 0 : volume(voice));
                        start.setServerSoundHandle(handles[voice]); start.setBypassListenerRangeCheck(true); start.setPlaybackPositionSeconds(0f);
                        session.sendUpstreamPacket(start); event("play", voice);
                    };
                    if (selected.equals("delayed")) later(session, token, i * 150, play); else play.run();
                }
                boolean paused = Set.of("pause", "settle", "pause5", "control").contains(selected);
                if (paused) for (long handle : handles) update(session, handle, new PauseSoundData());
                long preparation = selected.equals("pause5") ? 5000 : Set.of("seek", "pause", "settle", "control").contains(selected) || real ? 2000 : 0;
                long settling = selected.equals("settle") || selected.equals("control") || real ? 250 : 0;
                if (selected.equals("late") || continuous) later(session, token, continuous ? 9000 : 3500, () -> {
                    try {
                        var latePosition = session.getPlayerEntity().position().toDouble();
                        var packet = new org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.entity.ClientboundEntityPositionSyncPacket(
                                FAKE_IDS[2], false, latePosition, null, 0, 0, false);
                        call(extension, "moveEntity", session, packet); event("late-bind", 2);
                    } catch (Exception failure) { throw new RuntimeException(failure); }
                });
                if (!real && preparation > 0) later(session, token, preparation, () -> {
                    for (long handle : handles) update(session, handle, new SeekToSoundData(0));
                });
                if (!real && preparation > 0) later(session, token, preparation + settling, () -> {
                    for (int voice = 0; voice < handles.length; voice++) update(session, handles[voice], new SetVolumeSoundData(volume(voice)));
                    if (selected.equals("control")) {
                        for (int i = 0; i < handles.length; i++) {
                            final int voice = i;
                            later(session, token, i * 150, () -> { update(session, handles[voice], new ResumeSoundData()); event("delayed-resume", voice); });
                        }
                    } else if (paused) for (long handle : handles) update(session, handle, new ResumeSoundData());
                    event("release", -1);
                });
                preparation += settling;
                // Keep voice 0 audible continuously. Compare simultaneous pairs so shared mixer
                // stalls and capture-clock gaps cannot masquerade as inter-speaker desynchronization.
                if (continuous) {
                    later(session, token, 6000, () -> event("observe", 0));
                    later(session, token, 13000, () -> event("observe", 2));
                    later(session, token, 28000, () -> event("observe", 2));
                    later(session, token, 33000, () -> { stop(session); event("stop", -1); });
                } else {
                for (int i = 0; i < 3; i++) {
                    final int voice = i == 2 ? 0 : i + 1;
                    later(session, token, preparation + 6000 + 3000 * i, () -> gate(session, voice));
                    later(session, token, preparation + 23000 + 3000 * i, () -> gate(session, voice));
                }
                later(session, token, preparation + 15000, () -> gate(session, -1));
                later(session, token, preparation + 32000, () -> { stop(session); event("stop", -1); });
                }
                event("began", -1);
            } catch (Throwable failure) { error.set(failure); }
            finally { done.countDown(); }
        });
        if (!done.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test event loop did not respond");
        if (error.get() != null) throw new RuntimeException(error.get());
        return snapshot();
    }
    public static String raw() throws Exception { return run("raw"); }
    public static String single() throws Exception { return run("single"); }
    public static String delayed() throws Exception { return run("delayed"); }
    public static String seek() throws Exception { return run("seek"); }
    public static String pause() throws Exception { return run("pause"); }
    public static String settle() throws Exception { return run("settle"); }
    public static String pause5() throws Exception { return run("pause5"); }
    public static String production() throws Exception { return run("production"); }
    public static String late() throws Exception { return run("late"); }
    public static String control() throws Exception { return run("control"); }
    public static String jukebox() throws Exception { return run("jukebox"); }
    public static String continuous() throws Exception { return run("continuous"); }
    public static String snapshot() { return new Gson().toJson(Map.of("mode", mode == null ? "none" : mode, "events", EVENTS, "sound", SOUND, "gating", "continuous".equals(mode) ? "continuous-3-to-1" : "anchor-pairs-2-to-1")); }
    public static String cleanup() {
        generation = null;
        var session = target(); session.executeInEventLoop(() -> stop(session));
        return "Stopped only benchmark sound handles.";
    }
}
