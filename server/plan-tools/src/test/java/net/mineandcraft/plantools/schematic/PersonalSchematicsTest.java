package net.mineandcraft.plantools.schematic;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.Assumptions;
import static org.junit.jupiter.api.Assertions.*;

class PersonalSchematicsTest {
    @TempDir Path directory;
    private final UUID alice = UUID.randomUUID(), bob = UUID.randomUUID();

    @Test void sameNameIsPrivateAndPersistsAcrossRestart() throws Exception {
        var libraries = new PersonalSchematics(directory);
        Path a = libraries.resolve(alice, "test.schem"), b = libraries.resolve(bob, "test.schem");
        Files.writeString(a, "Alice");
        Files.writeString(b, "Bob");
        Files.writeString(directory.resolve("old-shared.schem"), "Unattributed");
        assertNotEquals(a, b);
        var restarted = new PersonalSchematics(directory);
        assertEquals(java.util.List.of(a), restarted.files(alice));
        assertEquals(java.util.List.of(b), restarted.files(bob));
        Files.delete(a);
        assertEquals("Bob", Files.readString(b));
    }

    @Test void traversalAndAbsolutePathsCannotReachOtherLibraries() throws Exception {
        var libraries = new PersonalSchematics(directory);
        for (String name : new String[] {"../" + bob + "/test.schem", "/test.schem", "C:/test.schem", "..\\test.schem",
                "foo/../../test.schem", "foo/../test.schem", "./test.schem", ".players/test.schem", "", "foo//test.schem"}) {
            assertThrows(IOException.class, () -> libraries.resolve(alice, name), name);
        }
        assertThrows(IOException.class, () -> libraries.validate(alice, libraries.resolve(bob, "test.schem")));
        assertThrows(IOException.class, () -> libraries.validate(alice, directory.resolve("shared.schem")));
    }

    @Test void subdirectoriesStayInsideOwnersLibrary() throws Exception {
        var libraries = new PersonalSchematics(directory);
        Path file = libraries.resolve(alice, "houses/test.schem");
        Files.createDirectories(file.getParent());
        Files.writeString(file, "House");
        assertEquals(java.util.List.of(file), libraries.files(alice));
        assertEquals(java.util.List.of(), libraries.files(bob));
    }

    @Test void symbolicLinksCannotExposeOtherLibraries() throws Exception {
        var libraries = new PersonalSchematics(directory);
        Path other = libraries.resolve(bob, "private.schem");
        Files.writeString(other, "Private");
        Path link = libraries.resolve(alice, "linked.schem");
        try { Files.createSymbolicLink(link, other); }
        catch (IOException | UnsupportedOperationException error) {
            Assumptions.abort("Symbolic links unavailable on this host: " + error.getClass().getSimpleName());
        }
        assertThrows(IOException.class, () -> libraries.resolve(alice, "linked.schem"));
        assertThrows(IOException.class, () -> libraries.validate(alice, link));
        assertTrue(libraries.files(alice).isEmpty());
        Path linkedDirectory = libraries.directory(alice).resolve("linked-directory");
        Files.createSymbolicLink(linkedDirectory, libraries.directory(bob));
        assertThrows(IOException.class, () -> libraries.resolve(alice, "linked-directory/private.schem"));
        assertTrue(libraries.files(alice).isEmpty());
    }
}
