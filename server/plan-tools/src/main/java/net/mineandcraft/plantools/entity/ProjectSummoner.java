package net.mineandcraft.plantools.entity;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.commands.SummonCommand;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.phys.Vec3;
import net.mineandcraft.plantools.command.ProjectSelectors;
import net.mineandcraft.plantools.core.ProjectAccess;
import net.mineandcraft.plantools.core.TeleportOptions;

/** Entity creation is confined to a validated live project session, with no command dispatch. */
public final class ProjectSummoner {
    private final ProjectAccess<ServerPlayer, ServerLevel> access;
    private final Supplier<TeleportOptions> options;
    private final BooleanSupplier enabled;

    public ProjectSummoner(ProjectAccess<ServerPlayer, ServerLevel> access, Supplier<TeleportOptions> options, BooleanSupplier enabled) {
        this.access = access; this.options = options; this.enabled = enabled;
    }

    public void summon(ServerPlayer player, Holder.Reference<EntityType<?>> type, Vec3 position) throws CommandSyntaxException {
        var member = access.member(player).orElseThrow(() -> ProjectSelectors.error("Join a Plan project before summoning entities."));
        if (!options.get().enabled() || !enabled.getAsBoolean()) throw ProjectSelectors.error("Project summoning is disabled.");
        if (!options.get().allowGuests() && !member.owner()) throw ProjectSelectors.error("Only the project owner can summon entities here.");
        if (!access.dimensionEnabled(member.world().dimension())) throw ProjectSelectors.error("That dimension is disabled in Plan.");
        var world = player.level();
        if (!Double.isFinite(position.x) || !Double.isFinite(position.y) || !Double.isFinite(position.z)
                || position.x < -29999984 || position.x >= 29999984 || position.z < -29999984 || position.z >= 29999984
                || !world.isInsideBuildHeight(BlockPos.containing(position))
                || !world.getWorldBorder().isWithinBounds(position.x, position.z)) {
            throw ProjectSelectors.error("The summon position is outside the world border or build height.");
        }
        // Always use the player's actual world, even when the command source was redirected by /execute.
        // No arbitrary entity NBT: callers cannot inject commands, passengers or external destinations.
        SummonCommand.createEntity(player.createCommandSourceStack(), type, position, new CompoundTag(), true);
    }
}
