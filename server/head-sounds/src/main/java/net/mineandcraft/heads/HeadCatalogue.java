package net.mineandcraft.heads;

import com.google.gson.JsonObject;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;

/** Immutable datapack snapshot, independent of Minecraft for policy tests. */
public record HeadCatalogue(String release, Map<UUID, Entry> heads) {
    public record Entry(String sound, boolean owned) {
        public boolean allowed(boolean whitelisted) { return owned || !whitelisted; }
    }
    public static HeadCatalogue empty() { return new HeadCatalogue("", Map.of()); }
    public static HeadCatalogue parse(JsonObject json) {
        String release = json.get("release").getAsString();
        if (!release.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid head release");
        var entries = new HashMap<UUID, Entry>();
        if (json.getAsJsonArray("heads").size() > 2000) throw new IllegalArgumentException("Too many heads");
        for (var value : json.getAsJsonArray("heads")) {
            var item = value.getAsJsonObject();
            UUID id = UUID.fromString(item.get("uuid").getAsString());
            String sound = item.get("sound").getAsString();
            if (!sound.matches("mineandcraft_music:head_[a-f0-9]{32}") || !item.get("owned").getAsJsonPrimitive().isBoolean())
                throw new IllegalArgumentException("Invalid head mapping");
            if (entries.put(id, new Entry(sound, item.get("owned").getAsBoolean())) != null)
                throw new IllegalArgumentException("Duplicate head identity");
        }
        return new HeadCatalogue(release, Map.copyOf(entries));
    }
    public String sound(UUID id, Predicate<UUID> whitelist) {
        Entry entry = heads.get(id);
        return entry != null && entry.allowed(whitelist.test(id)) ? entry.sound() : null;
    }
}
