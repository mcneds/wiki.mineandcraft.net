package net.mineandcraft.plantools.mixin;

import com.sk89q.worldedit.command.argument.SchematicConverter;
import com.sk89q.worldedit.extension.platform.Actor;
import java.nio.file.Path;
import java.util.List;
import net.mineandcraft.plantools.schematic.WorldEditSchematics;
import org.enginehub.piston.converter.ConversionResult;
import org.enginehub.piston.converter.FailedConversion;
import org.enginehub.piston.converter.SuccessfulConversion;
import org.enginehub.piston.inject.InjectedValueAccess;
import org.enginehub.piston.inject.Key;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(value = SchematicConverter.class, remap = false)
public abstract class SchematicConverterMixin {
    @Inject(method = "getSuggestions", at = @At("HEAD"), cancellable = true)
    private void plantools$suggest(String input, InjectedValueAccess context, CallbackInfoReturnable<List<String>> callback) {
        try {
            callback.setReturnValue(WorldEditSchematics.suggestions(context.injectedValue(Key.of(Actor.class)).orElse(null), input));
        } catch (Exception error) { callback.setReturnValue(List.of()); }
    }

    @Inject(method = "convert", at = @At("HEAD"), cancellable = true)
    private void plantools$convert(String input, InjectedValueAccess context, CallbackInfoReturnable<ConversionResult<Path>> callback) {
        try {
            callback.setReturnValue(SuccessfulConversion.fromSingle(WorldEditSchematics.convert(
                    context.injectedValue(Key.of(Actor.class)).orElse(null), input)));
        } catch (Exception error) { callback.setReturnValue(FailedConversion.from(error)); }
    }
}
