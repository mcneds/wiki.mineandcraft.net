package net.mineandcraft.plantools.mixin;

import com.sk89q.worldedit.WorldEdit;
import com.sk89q.worldedit.command.SchematicCommands;
import com.sk89q.worldedit.extension.platform.Actor;
import com.sk89q.worldedit.util.io.file.FilenameException;
import java.io.File;
import net.mineandcraft.plantools.schematic.WorldEditSchematics;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Keep WorldEdit's serializers, async tasks and permission checks, replace only file scope/list. */
@Mixin(value = SchematicCommands.class, remap = false)
public abstract class SchematicCommandsMixin {
    @Redirect(method = "save", at = @At(value = "INVOKE", target = "Lcom/sk89q/worldedit/WorldEdit;getSafeSaveFile(Lcom/sk89q/worldedit/extension/platform/Actor;Ljava/io/File;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)Ljava/io/File;"))
    private File plantools$save(WorldEdit worldEdit, Actor actor, File ignored, String name, String extension, String[] extensions) throws FilenameException {
        return WorldEditSchematics.file(worldEdit, actor, name, extension, extensions, true);
    }

    @Redirect(method = {"load", "delete"}, at = @At(value = "INVOKE", target = "Lcom/sk89q/worldedit/WorldEdit;getSafeOpenFile(Lcom/sk89q/worldedit/extension/platform/Actor;Ljava/io/File;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)Ljava/io/File;"), require = 2)
    private File plantools$open(WorldEdit worldEdit, Actor actor, File ignored, String name, String extension, String[] extensions) throws FilenameException {
        return WorldEditSchematics.file(worldEdit, actor, name, extension, extensions, false);
    }

    @Inject(method = "list", at = @At("HEAD"), cancellable = true)
    private void plantools$list(Actor actor, int page, boolean oldest, boolean newest, CallbackInfo callback) {
        WorldEditSchematics.list(actor, page, oldest, newest);
        callback.cancel();
    }
}
