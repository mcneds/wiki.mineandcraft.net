package net.mineandcraft.plantools.core;

import java.util.List;
import java.util.function.Supplier;
import net.mineandcraft.plantools.core.ProjectAccess.Member;
import net.mineandcraft.plantools.core.ProjectAccess.Position;
import net.mineandcraft.plantools.core.ProjectWorld.Dimension;
import net.mineandcraft.plantools.core.TeleportRule.Operation;

/** Shared authorization and execution for every command entry point. */
public final class TeleportService<Player, World> {
    public static final class Rejected extends RuntimeException {
        public Rejected(String message) { super(message); }
    }

    private final ProjectAccess<Player, World> access;
    private final Supplier<TeleportOptions> options;
    private final List<TeleportRule> rules;

    public TeleportService(ProjectAccess<Player, World> access, Supplier<TeleportOptions> options,
                           List<TeleportRule> rules) {
        this.access = access;
        this.options = options;
        this.rules = List.copyOf(rules);
    }

    public void coordinates(Player player, Dimension dimension, Position position) {
        World world = coordinateDestination(player, dimension, position);
        access.teleport(player, world, position);
    }

    public World coordinateDestination(Player player, Dimension dimension, Position position) {
        Member caller = member(player);
        Dimension destination = dimension == null ? caller.world().dimension() : dimension;
        ProjectWorld expected = new ProjectWorld(caller.world().projectId(), destination);
        authorize(caller, expected, Operation.COORDINATES);
        // Reject absurd coordinates before loading or generating any destination world.
        checkHorizontalBounds(position);
        World world = destination == caller.world().dimension()
                ? access.currentWorld(player) : access.loadWorld(player, destination);
        validateDestination(player, world, expected, position, Operation.COORDINATES);
        return world;
    }

    public void toPlayer(Player player, Player target) {
        Member caller = member(player);
        Member recipient = member(target);
        authorize(caller, recipient.world(), Operation.PLAYER);
        execute(player, access.currentWorld(target), recipient.world(), access.position(target), Operation.PLAYER);
    }

    public boolean canTarget(Player player, Player target) {
        try {
            authorize(member(player), member(target).world(), Operation.PLAYER);
            return true;
        } catch (Rejected ignored) { return false; }
    }

    private Member member(Player player) {
        return access.member(player).orElseThrow(() -> new Rejected("You and any target must be inside an active Plan project."));
    }

    private void authorize(Member caller, ProjectWorld destination, Operation operation) {
        // This invariant is deliberately independent of configurable/custom rules.
        if (!caller.world().projectId().equals(destination.projectId())) {
            throw new Rejected("Teleporting outside your current Plan project is not allowed.");
        }
        TeleportOptions settings = options.get();
        if (!settings.enabled()) throw new Rejected("Project teleporting is disabled.");
        if (!settings.allowGuests() && !caller.owner()) throw new Rejected("Only the project owner can teleport here.");
        if (operation == Operation.COORDINATES && !settings.coordinates()) throw new Rejected("Coordinate teleporting is disabled.");
        if (operation == Operation.PLAYER && !settings.players()) throw new Rejected("Player teleporting is disabled.");
        if (!settings.crossDimension() && caller.world().dimension() != destination.dimension()) {
            throw new Rejected("Teleporting between project dimensions is disabled.");
        }
        if (!access.dimensionEnabled(destination.dimension())) throw new Rejected("That dimension is disabled in Plan.");
        var context = new TeleportRule.Context(caller, destination, operation);
        for (TeleportRule rule : rules) rule.rejection(context).ifPresent(message -> { throw new Rejected(message); });
    }

    private void execute(Player player, World world, ProjectWorld expected, Position position, Operation operation) {
        validateDestination(player, world, expected, position, operation);
        access.teleport(player, world, position);
    }

    public void validateDestination(Player player, World world, Position position, Operation operation) {
        ProjectWorld expected = access.identify(world).orElseThrow(() -> new Rejected("The destination is not a Plan project world."));
        validateDestination(player, world, expected, position, operation);
    }

    private void validateDestination(Player player, World world, ProjectWorld expected, Position position, Operation operation) {
        if (world == null) throw new Rejected("Plan could not load that dimension. Its loaded-world limit may have been reached.");
        ProjectWorld actual = access.identify(world).orElseThrow(() -> new Rejected("The destination is not a Plan project world."));
        if (!actual.equals(expected)) throw new Rejected("The destination project changed. Try again.");
        // Re-read session and destination after loading, immediately before the side effect.
        authorize(member(player), actual, operation);
        checkHorizontalBounds(position);
        if (!access.withinBounds(world, position)) throw new Rejected("The destination is outside the world border or build height.");
    }

    private static void checkHorizontalBounds(Position position) {
        if (position.x() < -29999984 || position.x() > 29999983
                || position.z() < -29999984 || position.z() > 29999983) {
            throw new Rejected("The destination is outside Minecraft's coordinate limits.");
        }
    }
}
