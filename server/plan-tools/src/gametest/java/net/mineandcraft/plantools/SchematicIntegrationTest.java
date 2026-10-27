package net.mineandcraft.plantools;

import com.sk89q.worldedit.LocalSession;
import com.sk89q.worldedit.WorldEdit;
import com.sk89q.worldedit.command.SchematicCommands;
import com.sk89q.worldedit.command.argument.SchematicConverter;
import com.sk89q.worldedit.extension.platform.Actor;
import com.sk89q.worldedit.extent.clipboard.BlockArrayClipboard;
import com.sk89q.worldedit.extent.clipboard.io.BuiltInClipboardFormat;
import com.sk89q.worldedit.fabric.FabricAdapter;
import com.sk89q.worldedit.math.BlockVector3;
import com.sk89q.worldedit.regions.CuboidRegion;
import com.sk89q.worldedit.session.ClipboardHolder;
import com.sk89q.worldedit.world.block.BlockTypes;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.mineandcraft.plantools.schematic.WorldEditSchematics;
import org.enginehub.piston.inject.Key;
import org.enginehub.piston.inject.MapBackedValueStore;

/** Exercises the actual transformed WorldEdit methods, serializers and async save/load tasks. */
public class SchematicIntegrationTest {
    // Game tests tick faster than wall time; WorldEdit serialization runs on its own executor.
    @GameTest(maxTicks = 10000)
    public void privateLibraries(GameTestHelper test) throws Exception {
        var firstMessages = new ArrayList<String>();
        Actor first = recording(FabricAdapter.get().fromNativePlayer(test.makeMockServerPlayerInLevel()), firstMessages);
        Actor second = recording(FabricAdapter.get().fromNativePlayer(test.makeMockServerPlayerInLevel()), new ArrayList<>());
        var worldEdit = WorldEdit.getInstance();
        var commands = new SchematicCommands(worldEdit);
        var firstSession = session(BlockTypes.DIAMOND_BLOCK.getDefaultState());
        var secondSession = session(BlockTypes.GOLD_BLOCK.getDefaultState());
        var library = WorldEditSchematics.library();
        Path firstFile = library.resolve(first.getUniqueId(), "test.schem");
        Path secondFile = library.resolve(second.getUniqueId(), "test.schem");
        Path privateFile = library.resolve(second.getUniqueId(), "second-only.schem");
        var constructor = SchematicConverter.class.getDeclaredConstructor(WorldEdit.class);
        constructor.setAccessible(true);
        var converter = constructor.newInstance(worldEdit);
        var context = MapBackedValueStore.create();
        context.injectValue(Key.of(Actor.class), access -> java.util.Optional.of(first));

        commands.save(first, firstSession, "test", BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC, false);
        commands.save(second, secondSession, "test", BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC, false);
        commands.save(second, secondSession, "second-only", BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC, false);

        test.startSequence().thenWaitUntil(() -> {
            test.assertTrue(block(firstFile).equals("minecraft:diamond_block"), "First player's saved block");
            test.assertTrue(block(secondFile).equals("minecraft:gold_block"), "Same filename has separate contents");
            test.assertTrue(block(privateFile).equals("minecraft:gold_block"), "Private second file saved");
        }).thenExecute(() -> {
            test.assertValueEqual(converter.getSuggestions("", context), List.of("test.schem"), "Tab completion is private");
            test.assertTrue(converter.convert("test", context).isSuccessful(), "Own extensionless filename resolves");
            test.assertFalse(converter.convert("second-only.schem", context).isSuccessful(), "Other player's filename rejected");
            test.assertFalse(converter.convert("../" + second.getUniqueId() + "/test.schem", context).isSuccessful(), "Traversal rejected by parser");
            test.assertFalse(converter.convert(secondFile.toString(), context).isSuccessful(), "Absolute path rejected");
            commands.list(first, 1, false, false);
            test.assertTrue(firstMessages.stream().anyMatch(s -> s.contains("test.schem")), "List shows own file");
            test.assertFalse(firstMessages.stream().anyMatch(s -> s.contains("second-only")), "List hides other file");
            try {
                commands.load(first, firstSession, Path.of("../" + second.getUniqueId() + "/test.schem"), BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC);
                test.fail("Direct load traversal must fail");
            } catch (com.sk89q.worldedit.util.io.file.FilenameException expected) { }
            try {
                commands.delete(first, secondFile);
                test.fail("Direct delete of other player's file must fail");
            } catch (com.sk89q.worldedit.WorldEditException expected) { }
            try {
                commands.save(first, firstSession, "../" + second.getUniqueId() + "/test", BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC, true);
                test.fail("Overwrite traversal must fail");
            } catch (com.sk89q.worldedit.WorldEditException expected) { }
            try {
                // Load first player's diamond clipboard into a previously gold session.
                commands.load(first, secondSession, Path.of("test.schem"), BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC);
            } catch (Exception error) { throw new RuntimeException(error); }
        }).thenWaitUntil(() -> {
            try {
                test.assertValueEqual(secondSession.getClipboard().getClipboard().getBlock(BlockVector3.ZERO).getBlockType(),
                        BlockTypes.DIAMOND_BLOCK, "Load reads caller's own schematic");
            } catch (com.sk89q.worldedit.EmptyClipboardException error) { throw new RuntimeException(error); }
        }).thenExecute(() -> {
            try {
                commands.delete(first, Path.of("test.schem"));
                test.assertFalse(Files.exists(firstFile), "Own delete succeeds");
                test.assertTrue(Files.exists(secondFile), "Other player's same-name schematic survives");
                commands.delete(second, Path.of("test.schem"));
                commands.delete(second, Path.of("second-only.schem"));
            } catch (Exception error) { throw new RuntimeException(error); }
        }).thenSucceed();
    }

    private static LocalSession session(com.sk89q.worldedit.world.block.BlockState block) throws Exception {
        var clipboard = new BlockArrayClipboard(new CuboidRegion(BlockVector3.ZERO, BlockVector3.ZERO));
        clipboard.setBlock(BlockVector3.ZERO, block);
        var session = new LocalSession();
        session.setClipboard(new ClipboardHolder(clipboard));
        return session;
    }

    private static String block(Path file) {
        try (var stream = Files.newInputStream(file); var reader = BuiltInClipboardFormat.SPONGE_V3_SCHEMATIC.getReader(stream)) {
            return reader.read().getBlock(BlockVector3.ZERO).getBlockType().id();
        } catch (Exception pendingWrite) { return "pending"; }
    }

    private static Actor recording(Actor actual, List<String> messages) {
        return (Actor) Proxy.newProxyInstance(Actor.class.getClassLoader(), new Class<?>[] {Actor.class}, (proxy, method, args) -> {
            if (method.getName().startsWith("print")) {
                synchronized (messages) { messages.add(String.valueOf(args[0])); }
                return null;
            }
            if (method.getName().equals("hasPermission")) return true;
            return method.invoke(actual, args);
        });
    }
}
