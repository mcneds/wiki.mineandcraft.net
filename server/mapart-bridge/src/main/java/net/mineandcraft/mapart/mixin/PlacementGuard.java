package net.mineandcraft.mapart.mixin;

import net.mineandcraft.mapart.MapartBridge;
import net.mineandcraft.mapart.Layout;

import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.decoration.ItemFrame;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import space.essem.image2map.Image2Map;
import space.essem.image2map.ImageData;

@Mixin(value = Image2Map.class, remap = false)
public abstract class PlacementGuard {
    @Inject(method = "clickItemFrame", at = @At("HEAD"), cancellable = true)
    private static void mapart$validateGrid(Player user, InteractionHand hand, ItemFrame first, CallbackInfoReturnable<Boolean> callback) {
        if (!(user instanceof ServerPlayer player)) return;
        var stack = user.getItemInHand(hand);
        var tag = stack.getOrDefault(DataComponents.CUSTOM_DATA, CustomData.EMPTY).copyTag();
        if (!stack.is(Items.BUNDLE) || !tag.contains("mineandcraft:mapart")) return;
        var image = tag.read(ImageData.CODEC);
        if (image.isEmpty() || !image.get().quickPlace()) return;
        int width = image.get().width(), height = image.get().height();
        var facing = first.getDirection();
        Direction right = facing.getAxis() == Direction.Axis.Y ? player.getDirection().getClockWise() : facing.getCounterClockWise();
        Direction down = facing.getAxis() != Direction.Axis.Y ? Direction.DOWN : facing.getAxisDirection() == Direction.AxisDirection.POSITIVE ? right.getClockWise() : right.getCounterClockWise();
        if (!Layout.validSize(width, height)) { callback.setReturnValue(true); return; }
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            var position = first.blockPosition().relative(right, x).relative(down, y);
            var frames = player.level().getEntitiesOfClass(ItemFrame.class, AABB.unitCubeFromLowerCorner(Vec3.atLowerCornerOf(position)), frame -> frame.blockPosition().equals(position) && frame.getDirection() == facing);
            boolean valid = frames.size() == 1 && !((FrameAccess) frames.getFirst()).mapart$isFixed() && frames.getFirst().getItem().isEmpty() && player.mayInteract(player.level(), position) && player.level().mayInteract(player, position);
            if (valid) {
                var result = UseEntityCallback.EVENT.invoker().interact(player, player.level(), hand, frames.getFirst(), new EntityHitResult(frames.getFirst()));
                valid = result == InteractionResult.PASS;
            }
            if (!valid) {
                MapartBridge.message(player, "The complete " + width + " × " + height + " frame grid must be empty and available for you to use. Your bundle was kept.");
                callback.setReturnValue(true); return;
            }
        }
    }
    // Image2Map's group-removal helper clears neighboring frames without their
    // individual protection checks. Managed maps use normal per-frame item drops.
    @Inject(method = "destroyItemFrame", at = @At("HEAD"), cancellable = true)
    private static void mapart$normalTileRemoval(net.minecraft.world.entity.Entity actor, ItemFrame frame, CallbackInfoReturnable<Boolean> callback) {
        if (frame.getItem().getOrDefault(DataComponents.CUSTOM_DATA, CustomData.EMPTY).copyTag().contains("mineandcraft:mapart")) {
            frame.setInvisible(false);
            callback.setReturnValue(false);
        }
    }
}
