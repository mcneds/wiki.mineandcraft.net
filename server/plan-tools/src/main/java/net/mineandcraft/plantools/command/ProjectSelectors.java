package net.mineandcraft.plantools.command;

import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import java.util.List;
import net.minecraft.commands.arguments.selector.EntitySelectorParser;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.Permissions;
import net.minecraft.world.entity.Entity;
import net.mineandcraft.plantools.core.ProjectAccess;

/** Filters candidates BEFORE vanilla selector ordering/limits; validates direct names/UUIDs too. */
public final class ProjectSelectors {
    private final ProjectAccess<ServerPlayer, ServerLevel> access;
    public ProjectSelectors(ProjectAccess<ServerPlayer, ServerLevel> access) { this.access = access; }

    public boolean inProject(ServerPlayer caller, Entity entity) {
        var member = access.member(caller);
        if (member.isEmpty() || entity.isRemoved() || !(entity.level() instanceof ServerLevel level)) return false;
        if (entity instanceof ServerPlayer player && access.member(player).isEmpty()) return false;
        return access.identify(level).filter(world -> world.projectId().equals(member.get().world().projectId())).isPresent();
    }

    public List<? extends Entity> resolve(ServerPlayer caller, StringReader reader, boolean playersOnly) throws CommandSyntaxException {
        if (access.member(caller).isEmpty()) throw error("Join a Plan project first.");
        var parser = new EntitySelectorParser(reader, true);
        parser.parse();
        parser.addPredicate(entity -> inProject(caller, entity) && (!playersOnly || entity instanceof ServerPlayer));
        var selector = parser.getSelector();
        // Only this local resolver receives selector permission; no command execution or op elevation.
        var source = caller.createCommandSourceStack().withPermission(permission -> permission.equals(Permissions.COMMANDS_ENTITY_SELECTORS));
        var result = selector.findEntities(source);
        if (result.isEmpty() || result.stream().anyMatch(entity -> !inProject(caller, entity)
                || (playersOnly && !(entity instanceof ServerPlayer)))) throw error("No matching targets in your Plan project.");
        return List.copyOf(result);
    }

    public static Entity single(List<? extends Entity> entities) throws CommandSyntaxException {
        if (entities.size() != 1) throw error("Choose exactly one destination (for example, add limit=1).");
        return entities.getFirst();
    }

    public static void end(StringReader reader) throws CommandSyntaxException {
        reader.skipWhitespace();
        if (reader.canRead()) throw error("Unexpected extra arguments.");
    }

    public static CommandSyntaxException error(String message) { return new SimpleCommandExceptionType(Component.literal(message)).create(); }
}
