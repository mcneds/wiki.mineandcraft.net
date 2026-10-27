package net.mineandcraft.mapart.mixin;

import net.minecraft.world.entity.decoration.ItemFrame;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(ItemFrame.class)
public interface FrameAccess {
    @Accessor("fixed") boolean mapart$isFixed();
}
