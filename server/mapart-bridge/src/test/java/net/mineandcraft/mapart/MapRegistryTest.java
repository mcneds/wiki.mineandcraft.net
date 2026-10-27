package net.mineandcraft.mapart;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class MapRegistryTest {
    @Test void largerArtworksSurviveRegistryReopening() throws Exception {
        int[] maps = java.util.stream.IntStream.range(100, 356).toArray();
        new MapRegistry(directory).obtain(ID, SHA, 256, () -> maps);
        assertArrayEquals(maps, new MapRegistry(directory).obtain(ID, SHA, 256, () -> { throw new AssertionError("Reallocated"); }).maps());
    }
    @TempDir Path directory;
    private static final String ID = "11111111-1111-4111-8111-111111111111", SHA = "a".repeat(64);
    @Test void replacementClaimsReuseIDsAcrossRegistryReopening() throws Exception {
        var registry = new MapRegistry(directory); var allocations = new AtomicInteger();
        var first = registry.obtain(ID,SHA,2,() -> { allocations.incrementAndGet(); return new int[]{101,102}; });
        var second = registry.obtain(ID,SHA,2,() -> { throw new AssertionError("Allocated another copy"); });
        assertArrayEquals(first.maps(),second.maps()); assertEquals(1,allocations.get());
        var recovered = new MapRegistry(directory).obtain(ID,SHA,2,() -> { throw new AssertionError("Allocated after restart"); });
        assertArrayEquals(new int[]{101,102},recovered.maps());
    }
    @Test void changedArtworkCannotSilentlyReuseIssuedMapIDs() throws Exception {
        var registry = new MapRegistry(directory); registry.obtain(ID,SHA,1,() -> new int[]{3});
        assertThrows(IllegalStateException.class,() -> registry.obtain(ID,"b".repeat(64),1,() -> new int[]{4}));
        assertThrows(IllegalStateException.class,() -> registry.obtain(ID,SHA,2,() -> new int[]{4,5}));
    }
    @Test void invalidOrDamagedRegistryFailsClosed() throws Exception {
        Files.writeString(directory.resolve("registry.json"),"null");
        assertThrows(IllegalStateException.class,() -> new MapRegistry(directory));
        Files.writeString(directory.resolve("registry.json"),"{\""+ID+"\":{\"sha256\":\""+SHA+"\",\"maps\":[-1]}}");
        assertThrows(IllegalStateException.class,() -> new MapRegistry(directory));
    }
}
