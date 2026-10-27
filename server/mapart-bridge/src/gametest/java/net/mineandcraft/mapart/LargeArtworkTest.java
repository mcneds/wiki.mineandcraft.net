package net.mineandcraft.mapart;

import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.UUID;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.NbtOps;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.decoration.ItemFrame;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import space.essem.image2map.Image2Map;

public class LargeArtworkTest {
    @GameTest(maxTicks = 400)
    public void largeBundleAndWidePlacement(GameTestHelper test) throws Exception {
        var world = test.getLevel();
        var store = new ArtStore(Files.createTempDirectory("mapart-large-test"));
        var large = new Layout(32, 8, "fit", "center", "center", false);
        var pixels = new byte[large.width() * large.height()]; Arrays.fill(pixels, (byte) 34);
        var item = store.item(world, UUID.randomUUID().toString(), "Large art", large, pixels, BridgeClient.checksum(pixels));
        test.assertValueEqual(item.get(DataComponents.BUNDLE_CONTENTS).size(), 256, "All 256 tiles are delivered in one bundle");
        var ops = world.registryAccess().createSerializationContext(NbtOps.INSTANCE);
        var saved = ItemStack.CODEC.encodeStart(ops, item).getOrThrow();
        var restored = ItemStack.CODEC.parse(ops, saved).getOrThrow();
        test.assertValueEqual(restored.get(DataComponents.BUNDLE_CONTENTS).size(), 256, "Large bundle survives inventory serialization");

        var wide = new Layout(9, 1, "fit", "center", "center", false);
        pixels = new byte[wide.width() * wide.height()]; Arrays.fill(pixels, (byte) 34);
        var bundle = store.item(world, UUID.randomUUID().toString(), "Wide art", wide, pixels, BridgeClient.checksum(pixels));
        var player = test.makeMockServerPlayerInLevel();
        var origin = test.absolutePos(new BlockPos(0, 2, 0));
        player.teleportTo(origin.getX(), origin.getY(), origin.getZ() + 3);
        var frames = new ArrayList<ItemFrame>();
        for (int x = 0; x < 9; x++) {
            var position = origin.relative(Direction.EAST, x);
            world.setBlockAndUpdate(position.north(), Blocks.STONE.defaultBlockState());
            var frame = new ItemFrame(world, position, Direction.SOUTH);
            world.addFreshEntity(frame); frames.add(frame);
        }
        player.setItemInHand(InteractionHand.MAIN_HAND, bundle);
        test.startSequence().thenIdle(2).thenExecute(() -> {
            Image2Map.clickItemFrame(player, InteractionHand.MAIN_HAND, frames.getFirst());
            for (var frame : frames) test.assertTrue(frame.getItem().is(Items.FILLED_MAP), "Every tile in a nine-wide grid was placed");
            frames.forEach(ItemFrame::discard);
            world.getServer().getPlayerList().remove(player);
        }).thenSucceed();
    }
}
