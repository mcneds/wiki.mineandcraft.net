package net.mineandcraft.plantools.command;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.util.List;
import java.util.Set;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.mineandcraft.plantools.core.ProjectAccess;
import net.mineandcraft.plantools.core.ProjectAccess.Position;
import net.mineandcraft.plantools.core.TeleportRule.Operation;
import net.mineandcraft.plantools.core.TeleportService;

/** Validate the entire selected batch before moving anyone. Always authorize as the caller. */
public final class EntityTeleports {
    private final ProjectAccess<ServerPlayer, ServerLevel> access;
    private final TeleportService<ServerPlayer, ServerLevel> service;
    private final ProjectSelectors selectors;
    public EntityTeleports(ProjectAccess<ServerPlayer, ServerLevel> access, TeleportService<ServerPlayer, ServerLevel> service, ProjectSelectors selectors) {
        this.access = access; this.service = service; this.selectors = selectors;
    }

    public void move(ServerPlayer caller, List<? extends Entity> targets, ServerLevel destination, Position position, Operation operation) throws CommandSyntaxException {
        service.validateDestination(caller, destination, position, operation);
        for (Entity target : targets) {
            if (!selectors.inProject(caller, target)) throw ProjectSelectors.error("Every target must be in your current Plan project.");
            var level = (ServerLevel) target.level();
            // This also applies the caller's guest and cross-dimension settings to selected targets.
            service.validateDestination(caller, level, positionOf(target), operation);
            if (!(target instanceof ServerPlayer) && level != destination) {
                throw ProjectSelectors.error("Plan permits non-player entities to teleport only within their current dimension.");
            }
        }
        for (Entity target : targets) {
            if (target instanceof ServerPlayer player) access.teleport(player, destination, position);
            else {
                if (!target.teleportTo(destination, position.x() + 0.5, position.y(), position.z() + 0.5, Set.of(), target.getYRot(), target.getXRot(), false)) {
                    throw ProjectSelectors.error("An entity could not teleport; earlier targets may already have moved.");
                }
                target.setDeltaMovement(Vec3.ZERO);
            }
        }
    }

    public static Position positionOf(Entity entity) {
        var pos = entity.blockPosition();
        return new Position(pos.getX(), pos.getY(), pos.getZ());
    }
}
