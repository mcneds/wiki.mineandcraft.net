package net.mineandcraft.heads;

import com.google.gson.JsonParser;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HeadCatalogueTest {
    private static final UUID ID = UUID.fromString("069a79f4-44e9-4726-a5be-fca90e38aaf5");
    private static final String SOUND = "mineandcraft_music:head_11111111111141118111111111111111";
    private HeadCatalogue catalogue(boolean owned) {
        return HeadCatalogue.parse(JsonParser.parseString("{\"release\":\"" + "a".repeat(64) + "\",\"heads\":[{\"uuid\":\"" + ID + "\",\"sound\":\"" + SOUND + "\",\"owned\":" + owned + "}]}").getAsJsonObject());
    }
    @Test void whitelistImmediatelyProtectsPreviouslyPublicHeads() {
        assertEquals(SOUND, catalogue(false).sound(ID, id -> false));
        assertNull(catalogue(false).sound(ID, id -> true));
        assertEquals(SOUND, catalogue(true).sound(ID, id -> true));
    }
    @Test void unrelatedAndTextureOnlyIdentitiesDoNotMatch() {
        assertNull(catalogue(true).sound(new UUID(0, 0), id -> false));
        assertNull(catalogue(true).sound(UUID.randomUUID(), id -> false));
    }
    @Test void replacementSwitchesWholeSnapshotAndMissingMappingIsSilent() {
        assertEquals(SOUND, catalogue(true).sound(ID, id -> false));
        assertNull(HeadCatalogue.empty().sound(ID, id -> false));
    }
    @Test void invalidSoundNamespaceCannotOverrideVanilla() {
        var json = JsonParser.parseString("{\"release\":\"" + "a".repeat(64) + "\",\"heads\":[{\"uuid\":\"" + ID + "\",\"sound\":\"minecraft:test\",\"owned\":true}]}").getAsJsonObject();
        assertThrows(IllegalArgumentException.class, () -> HeadCatalogue.parse(json));
    }
}
