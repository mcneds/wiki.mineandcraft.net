package net.mineandcraft.heads.mixin;

import net.mineandcraft.heads.HeadSounds;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.NoteBlock;
import net.minecraft.world.level.block.entity.SkullBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(NoteBlock.class)
public abstract class NoteBlockMixin {
    @Inject(method = "getCustomSoundId", at = @At("HEAD"), cancellable = true)
    private void headSound(Level level, BlockPos pos, CallbackInfoReturnable<Identifier> result) {
        if (level instanceof ServerLevel server && level.getBlockEntity(pos.above()) instanceof SkullBlockEntity skull && HeadSounds.managed(skull))
            result.setReturnValue(HeadSounds.sound(server, skull));
    }
}
