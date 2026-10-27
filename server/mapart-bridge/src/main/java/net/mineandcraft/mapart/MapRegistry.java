package net.mineandcraft.mapart;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Supplier;

/** Durable association of immutable artwork with already-saved Minecraft map IDs. */
final class MapRegistry {
    record Entry(String sha256, int[] maps) {}
    private static final Gson JSON = new Gson();
    private final Path file;
    private final Map<String, Entry> entries;
    MapRegistry(Path directory) throws Exception {
        Files.createDirectories(directory); file = directory.resolve("registry.json");
        entries = Files.exists(file) ? JSON.fromJson(Files.readString(file), new TypeToken<Map<String, Entry>>() {}.getType()) : new HashMap<>();
        if (entries == null) throw new IllegalStateException("Mapart registry is unreadable");
        for (var entry : entries.entrySet()) {
            var value = entry.getValue();
            if (!entry.getKey().matches("[a-f0-9-]{36}") || value == null || value.sha256 == null || !value.sha256.matches("[a-f0-9]{64}") || value.maps == null || value.maps.length < 1 || value.maps.length > Layout.MAX_TILES || java.util.Arrays.stream(value.maps).anyMatch(id -> id < 0)) throw new IllegalStateException("Mapart registry is damaged");
        }
    }
    Entry obtain(String id, String checksum, int count, Supplier<int[]> allocateAndSave) throws Exception {
        if (count < 1 || count > Layout.MAX_TILES) throw new IllegalArgumentException("Invalid map count");
        Entry existing = entries.get(id);
        if (existing != null) {
            if (!existing.sha256.equals(checksum) || existing.maps.length != count) throw new IllegalStateException("Artwork registry mismatch");
            return existing;
        }
        int[] ids = allocateAndSave.get();
        if (ids.length != count) throw new IllegalStateException("Map allocation count mismatch");
        var created = new Entry(checksum, ids); entries.put(id, created);
        try { ArtStore.atomicWrite(file, JSON.toJson(entries).getBytes(StandardCharsets.UTF_8)); }
        catch (Exception error) { entries.remove(id); throw error; }
        return created;
    }
}
