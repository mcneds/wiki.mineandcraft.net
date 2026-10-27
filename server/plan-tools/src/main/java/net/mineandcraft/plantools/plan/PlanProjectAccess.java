package net.mineandcraft.plantools.plan;

import com.planmod.PlanConfig;
import com.planmod.session.SessionManager;
import com.planmod.world.PlanWorlds;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.mineandcraft.plantools.core.ProjectAccess;
import net.mineandcraft.plantools.core.ProjectWorld;
import net.mineandcraft.plantools.core.ProjectWorld.Dimension;

/** The only class coupled to Plan 15. Upgrade and verify this adapter when updating Plan. */
public final class PlanProjectAccess implements ProjectAccess<ServerPlayer, ServerLevel> {
    @Override public Optional<Member> member(ServerPlayer player) {
        if (player == null || player.isRemoved() || !player.isAlive() || !SessionManager.inSession(player)) return Optional.empty();
        var project = SessionManager.sessionProject(player);
        if (project == null) return Optional.empty();
        return identify(player.level()).filter(world -> world.projectId().equals(project.id))
                .map(world -> new Member(world, project.owner.equals(player.getUUID())));
    }

    @Override public Optional<ProjectWorld> identify(ServerLevel world) {
        var ref = PlanWorlds.ref(world.dimension());
        var project = PlanWorlds.projectFor(world.getServer(), world.dimension());
        if (ref == null || project == null || !ref.projectId().equals(project.id)) return Optional.empty();
        return Optional.of(new ProjectWorld(project.id, switch (ref.kind()) {
            case MAIN -> Dimension.OVERWORLD;
            case NETHER -> Dimension.NETHER;
            case END -> Dimension.END;
        }));
    }

    @Override public ServerLevel currentWorld(ServerPlayer player) { return player.level(); }
    @Override public Position position(ServerPlayer player) {
        var pos = player.blockPosition();
        return new Position(pos.getX(), pos.getY(), pos.getZ());
    }
    @Override public boolean dimensionEnabled(Dimension dimension) {
        return switch (dimension) {
            case OVERWORLD -> true;
            case NETHER -> PlanConfig.allowNether();
            case END -> PlanConfig.allowEnd();
        };
    }
    @Override public ServerLevel loadWorld(ServerPlayer player, Dimension dimension) {
        var project = SessionManager.sessionProject(player);
        if (project == null || member(player).isEmpty()) return null;
        return PlanWorlds.load(player.level().getServer(), project, switch (dimension) {
            case OVERWORLD -> PlanWorlds.Kind.MAIN;
            case NETHER -> PlanWorlds.Kind.NETHER;
            case END -> PlanWorlds.Kind.END;
        });
    }
    @Override public boolean withinBounds(ServerLevel world, Position position) {
        return world.isInsideBuildHeight(block(position))
                && world.getWorldBorder().isWithinBounds(position.x() + 0.5, position.z() + 0.5);
    }
    @Override public void teleport(ServerPlayer player, ServerLevel world, Position position) {
        // Plan's public managed transition preserves its session/portal guards.
        // It lands at the block's X/Z centre and keeps the caller's rotation.
        SessionManager.managedTeleport(player, world, block(position));
    }
    private static BlockPos block(Position position) { return new BlockPos(position.x(), position.y(), position.z()); }
}
