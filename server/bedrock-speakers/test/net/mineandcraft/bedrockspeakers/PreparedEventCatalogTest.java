package net.mineandcraft.bedrockspeakers;

import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;

final class PreparedEventCatalogTest {
    static void run() throws Exception {
        String sound = "other_music:new_song";
        String event = "copper_speakers:tail/v1/" + HexFormat.of().formatHex(sound.getBytes(StandardCharsets.UTF_8))
                + "/0123456789abcdef01234567/48000/720000";
        var decoded = PreparedEventCatalog.decode(event);
        if (decoded == null || !decoded.sound().equals(sound) || decoded.offsetSeconds() != 15)
            throw new AssertionError("New prepared songs must resolve without the embedded table or an IO refresh");
        for (String invalid : new String[]{event.replace("/48000/", "/0/"), event + "/extra", event.replace("720000", "-1"),
                "copper_speakers:tail/legacy/720000", event.replace("0123456789abcdef01234567", "bad")})
            if (PreparedEventCatalog.decode(invalid) != null) throw new AssertionError("Invalid event accepted: " + invalid);
        Path root = Files.createTempDirectory("copperbedrock-mappings-");
        Path file = root.resolve("events.json");
        try (var catalogue = new PreparedEventCatalog(file, message -> { })) {
            catalogue.reload();
            if (catalogue.find("copper_speakers:tail/legacy/123") != null) throw new AssertionError();
            Files.writeString(file, "{\"format\":1,\"events\":{\"copper_speakers:tail/legacy/123\":{\"sound\":\"example:new\",\"offsetSeconds\":15.25}}}");
            catalogue.reload();
            var value = catalogue.find("copper_speakers:tail/legacy/123");
            if (value == null || !value.sound().equals("example:new") || value.offsetSeconds() != 15.25f)
                throw new AssertionError("Live legacy mapping did not load");
            Files.writeString(file, "{broken"); catalogue.reload();
            if (!value.equals(catalogue.find("copper_speakers:tail/legacy/123"))) throw new AssertionError("Bad JSON replaced working mappings");
            Files.writeString(file, "{\"format\":1,\"events\":{}}"); catalogue.reload();
            if (catalogue.find("copper_speakers:tail/legacy/123") != null) throw new AssertionError("Removed mapping retained");
        } finally { Files.deleteIfExists(file); Files.delete(root); }
        System.out.println("PASS: new prepared events resolve without rebuilding; runtime mapping replacement and failure recovery verified");
    }
}
