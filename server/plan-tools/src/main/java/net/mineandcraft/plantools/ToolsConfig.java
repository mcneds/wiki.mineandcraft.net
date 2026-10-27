package net.mineandcraft.plantools;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import net.mineandcraft.plantools.core.TeleportOptions;

public final class ToolsConfig {
    private static final Set<String> KEYS = Set.of("enabled", "allowGuests", "coordinates", "players", "crossDimension", "summon");
    private final Path path;
    private record Settings(TeleportOptions teleport, boolean summon) {}
    private Settings settings;

    public ToolsConfig(Path path) throws IOException {
        this.path = path;
        if (!Files.exists(path)) {
            Files.createDirectories(path.getParent());
            var gson = new GsonBuilder().setPrettyPrinting().create();
            var defaults = gson.toJsonTree(TeleportOptions.defaults()).getAsJsonObject();
            defaults.addProperty("summon", true);
            Files.writeString(path, gson.toJson(defaults) + "\n");
        }
        reload();
    }

    public TeleportOptions options() { return settings.teleport(); }
    public boolean summonEnabled() { return settings.summon(); }

    /** Parse and validate fully before replacing the active configuration. */
    public void reload() throws IOException {
        settings = parse(Files.readString(path));
    }

    private static Settings parse(String text) {
        var root = JsonParser.parseString(text);
        if (!root.isJsonObject()) throw new IllegalArgumentException("Expected a JSON object.");
        JsonObject json = root.getAsJsonObject();
        for (String key : json.keySet()) {
            if (!KEYS.contains(key)) throw new IllegalArgumentException("Unknown setting: " + key);
            var value = json.get(key);
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
                throw new IllegalArgumentException("Setting must be boolean: " + key);
            }
        }
        return new Settings(new TeleportOptions(value(json, "enabled"), value(json, "allowGuests"), value(json, "coordinates"),
                value(json, "players"), value(json, "crossDimension")), value(json, "summon"));
    }

    private static boolean value(JsonObject json, String key) { return !json.has(key) || json.get(key).getAsBoolean(); }
}
