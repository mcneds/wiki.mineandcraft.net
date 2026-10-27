package net.mineandcraft.bedrockspeakers;

import com.google.gson.JsonParser;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import java.nio.charset.StandardCharsets;

/** Atomic runtime mappings from Copper Speakers; no disk access on Geyser's packet loop. */
final class PreparedEventCatalog implements AutoCloseable {
    record Entry(String sound, float offsetSeconds) {}
    private final Path file;
    private final Consumer<String> warning;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(task -> {
        var thread = new Thread(task, "copperbedrock-prepared-events");
        thread.setDaemon(true);
        return thread;
    });
    private volatile Map<String, Entry> entries = Map.of();
    private String lastError;
    PreparedEventCatalog(Path file, Consumer<String> warning) { this.file = file; this.warning = warning; }
    Entry find(String event) { return entries.get(event); }
    static Entry decode(String event) {
        if (!event.startsWith("copper_speakers:tail/v1/")) return null;
        try {
            String[] fields = event.substring("copper_speakers:tail/v1/".length()).split("/", -1);
            if (fields.length != 4 || !fields[1].matches("[0-9a-f]{24}")) return null;
            String sound = new String(HexFormat.of().parseHex(fields[0]), StandardCharsets.UTF_8);
            if (!sound.matches("[a-z0-9_.-]+:[a-z0-9/._-]+")) return null;
            int rate = Integer.parseInt(fields[2]);
            long frames = Long.parseLong(fields[3]);
            if (rate <= 0 || frames < 0) return null;
            float seconds = (float)((double)frames / rate);
            return Float.isFinite(seconds) ? new Entry(sound, seconds) : null;
        } catch (RuntimeException ignored) { return null; }
    }
    void start() { worker.scheduleWithFixedDelay(this::reload, 0, 1, TimeUnit.SECONDS); }
    void reload() {
        try {
            if (!Files.isRegularFile(file)) return;
            var json = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            if (json.get("format").getAsInt() != 1) throw new IllegalArgumentException("Unknown mapping format");
            Map<String, Entry> replacement = new HashMap<>();
            for (var row : json.getAsJsonObject("events").entrySet()) {
                var value = row.getValue().getAsJsonObject();
                String sound = value.get("sound").getAsString();
                float offset = value.get("offsetSeconds").getAsFloat();
                if (!row.getKey().startsWith("copper_speakers:tail/") || !sound.contains(":")
                        || !Float.isFinite(offset) || offset < 0) throw new IllegalArgumentException("Invalid prepared event");
                replacement.put(row.getKey(), new Entry(sound, offset));
            }
            entries = Map.copyOf(replacement);
            lastError = null;
        } catch (Exception e) {
            String message = "Prepared music mapping reload failed: " + e;
            if (!message.equals(lastError)) warning.accept(message);
            lastError = message; // Keep the last complete, valid table.
        }
    }
    @Override public void close() { worker.shutdownNow(); }
}
