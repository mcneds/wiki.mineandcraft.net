package net.mineandcraft.synclab.mixin;

import com.mojang.blaze3d.audio.Channel;
import net.mineandcraft.synclab.StreamQueueTracker;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Does not change start calls, buffers, decoding, source properties, or queue operations. */
@Mixin(Channel.class)
public abstract class ChannelQueueMixin {
    @Shadow @Final private int source;
    @Inject(method = "<init>", at = @At("RETURN"))
    private void synclab$created(int source, CallbackInfo ci) { StreamQueueTracker.created(source); }
    @Inject(method = "lambda$pumpBuffers$0", at = @At("HEAD"))
    private void synclab$queued(int buffer, CallbackInfo ci) { StreamQueueTracker.queued(source, buffer); }
    @Inject(method = "removeProcessedBuffers", at = @At("RETURN"))
    private void synclab$removed(CallbackInfoReturnable<Integer> cir) { StreamQueueTracker.removed(source, cir.getReturnValue()); }
}
