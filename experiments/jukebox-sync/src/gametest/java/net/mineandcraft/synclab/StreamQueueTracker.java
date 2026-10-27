package net.mineandcraft.synclab;

import org.lwjgl.openal.AL10;
import java.util.*;

/** Observation only: retain durations of removed OpenAL buffers for absolute stream playheads. */
public final class StreamQueueTracker {
    private static final boolean ENABLED = Boolean.parseBoolean(System.getenv().getOrDefault("SYNCLAB_MUSIC_COMPARE", "false"));
    private static final Map<Integer, State> SOURCES = new HashMap<>();
    private static final class State {
        final Deque<Double> queuedSeconds = new ArrayDeque<>();
        double removedSeconds;
        long decodedBytes;
    }
    public static void created(int source) { if (ENABLED) SOURCES.remove(source); }
    public static void queued(int source, int buffer) {
        if (!ENABLED) return;
        int bytes = AL10.alGetBufferi(buffer, AL10.AL_SIZE);
        int rate = AL10.alGetBufferi(buffer, AL10.AL_FREQUENCY);
        int bits = AL10.alGetBufferi(buffer, AL10.AL_BITS);
        int channels = AL10.alGetBufferi(buffer, AL10.AL_CHANNELS);
        State state = SOURCES.computeIfAbsent(source, ignored -> new State());
        state.queuedSeconds.add((double) bytes / (rate * channels * bits / 8));
        state.decodedBytes += bytes;
    }
    public static void removed(int source, int count) {
        if (!ENABLED || count == 0) return;
        State state = SOURCES.get(source);
        if (state == null || state.queuedSeconds.size() < count) throw new IllegalStateException("Missing stream queue observations");
        for (int i = 0; i < count; i++) state.removedSeconds += state.queuedSeconds.removeFirst();
    }
    public static double removedSeconds(int source) {
        State state = SOURCES.get(source);
        return state == null ? 0 : state.removedSeconds;
    }
    public static Map<String, Object> stats(int source) {
        State state = SOURCES.get(source);
        if (state == null) return Map.of();
        return Map.of("removedSeconds", state.removedSeconds, "queuedSeconds", state.queuedSeconds.stream().mapToDouble(Double::doubleValue).sum(),
                "decodedBytes", state.decodedBytes, "queueCount", state.queuedSeconds.size());
    }
}
