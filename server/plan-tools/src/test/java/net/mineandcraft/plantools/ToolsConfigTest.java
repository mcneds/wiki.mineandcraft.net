package net.mineandcraft.plantools;

import java.nio.file.Files;
import java.nio.file.Path;
import net.mineandcraft.plantools.core.TeleportOptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class ToolsConfigTest {
    @TempDir Path directory;

    @Test void createsDefaultsAndReloadsWithoutRestart() throws Exception {
        Path path = directory.resolve("config/tools.json");
        var config = new ToolsConfig(path);
        assertEquals(TeleportOptions.defaults(), config.options());
        assertTrue(config.summonEnabled(), "Existing configs enable summoning by default");
        Files.writeString(path, "{\"allowGuests\":false,\"crossDimension\":false}");
        config.reload();
        assertEquals(new TeleportOptions(true, false, true, true, false), config.options());
        Files.writeString(path, "{\"summon\":false}");
        config.reload();
        assertFalse(config.summonEnabled());
    }

    @Test void invalidReloadRetainsPreviousSettings() throws Exception {
        Path path = directory.resolve("tools.json");
        Files.writeString(path, "{\"enabled\":false}");
        var config = new ToolsConfig(path);
        var previous = config.options();
        for (String invalid : new String[] {"null", "[]", "{", "{\"enabled\":\"true\"}", "{\"allowGuest\":true}", "{\"players\":null}"}) {
            Files.writeString(path, invalid);
            assertThrows(RuntimeException.class, config::reload);
            assertSame(previous, config.options());
        }
    }

    @Test void invalidStartupFailsClosed() throws Exception {
        Path path = directory.resolve("tools.json");
        Files.writeString(path, "{\"enabled\":1}");
        assertThrows(RuntimeException.class, () -> new ToolsConfig(path));
    }
}
