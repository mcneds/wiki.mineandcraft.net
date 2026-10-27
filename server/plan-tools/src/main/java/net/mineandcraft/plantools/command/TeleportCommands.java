package net.mineandcraft.plantools.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import java.util.Locale;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.commands.arguments.coordinates.Coordinates;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.mineandcraft.plantools.core.ProjectAccess.Position;
import net.mineandcraft.plantools.core.ProjectAccess;
import net.mineandcraft.plantools.core.TeleportRule.Operation;
import net.mineandcraft.plantools.core.ProjectWorld.Dimension;
import net.mineandcraft.plantools.core.TeleportService;
import static net.minecraft.commands.Commands.argument;
import static net.minecraft.commands.Commands.literal;

public final class TeleportCommands {
    private final TeleportService<ServerPlayer, ServerLevel> service;
    private final ProjectSelectors selectors;
    private final EntityTeleports entities;

    public TeleportCommands(TeleportService<ServerPlayer, ServerLevel> service, ProjectAccess<ServerPlayer, ServerLevel> access) {
        this.service = service;
        this.selectors = new ProjectSelectors(access);
        this.entities = new EntityTeleports(access, service, selectors);
    }

    public void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        var root = literal("ptp").executes(context -> {
            context.getSource().sendSuccess(() -> Component.literal(
                    "/ptp <x> <y> <z> | /ptp in <overworld|nether|end> <x> <y> <z> | /ptp <destination> | /ptp <targets> <position|destination> | /ptp player <name|selector>"), false);
            return 1;
        }).then(argument("position", BlockPosArgument.blockPos()).executes(context -> coordinates(context, null)))
          .then(literal("player").then(argument("name", StringArgumentType.greedyString())
                .suggests((context, builder) -> {
                    var caller = context.getSource().getPlayer();
                    if (caller == null) return builder.buildFuture();
                    var names = java.util.stream.Stream.concat(java.util.stream.Stream.of("@s", "@p", "@r", "@a[limit=1]"), context.getSource().getServer().getPlayerList().getPlayers().stream()
                            .filter(target -> service.canTarget(caller, target))
                            .map(target -> StringArgumentType.escapeIfRequired(target.getGameProfile().name())));
                    return SharedSuggestionProvider.suggest(names, builder);
                }).executes(this::toPlayer)));
        var in = literal("in");
        for (Dimension dimension : Dimension.values()) {
            in.then(literal(dimension.name().toLowerCase(Locale.ROOT))
                    .then(argument("position", BlockPosArgument.blockPos()).executes(context -> coordinates(context, dimension))));
        }
        root.then(argument("selection", StringArgumentType.greedyString())
                .suggests((context, builder) -> SharedSuggestionProvider.suggest(List.of("@s", "@p", "@r", "@a", "@e"), builder))
                .executes(this::selected));
        dispatcher.register(root.then(in));
    }

    private int coordinates(CommandContext<CommandSourceStack> context, Dimension dimension) throws CommandSyntaxException {
        ServerPlayer player = context.getSource().getPlayerOrException();
        // Resolve ~ and ^ from the actual player, even when invoked via /execute.
        var pos = context.getArgument("position", Coordinates.class).getBlockPos(player.createCommandSourceStack());
        return run(context, () -> service.coordinates(player, dimension, new Position(pos.getX(), pos.getY(), pos.getZ())));
    }

    private int toPlayer(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
        ServerPlayer player = context.getSource().getPlayerOrException();
        var reader = new StringReader(StringArgumentType.getString(context, "name"));
        ServerPlayer target = (ServerPlayer) ProjectSelectors.single(selectors.resolve(player, reader, true));
        ProjectSelectors.end(reader);
        return run(context, () -> service.toPlayer(player, target));
    }

    private int selected(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
        ServerPlayer caller = context.getSource().getPlayerOrException();
        var reader = new StringReader(StringArgumentType.getString(context, "selection"));
        var targets = selectors.resolve(caller, reader, false);
        reader.skipWhitespace();
        if (!reader.canRead()) {
            var target = ProjectSelectors.single(targets);
            return run(context, () -> entities.move(caller, List.of(caller), (ServerLevel) target.level(), EntityTeleports.positionOf(target), Operation.PLAYER));
        }
        Dimension dimension = null;
        if (reader.getRemaining().startsWith("in ")) {
            reader.skip(); reader.skip(); reader.skipWhitespace();
            try { dimension = Dimension.valueOf(reader.readUnquotedString().toUpperCase(Locale.ROOT)); }
            catch (IllegalArgumentException invalid) { throw error("Choose overworld, nether, or end within your project."); }
            reader.skipWhitespace();
        }
        // A UUID or player name may start with a digit; only a coordinate triplet is a position.
        if (dimension != null || (reader.canRead() && "~^0123456789+-".indexOf(reader.peek()) >= 0
                && reader.getRemaining().trim().split("\\s+").length >= 3)) {
            var pos = BlockPosArgument.blockPos().parse(reader).getBlockPos(caller.createCommandSourceStack());
            ProjectSelectors.end(reader);
            var position = new Position(pos.getX(), pos.getY(), pos.getZ());
            Dimension requested = dimension;
            return run(context, () -> {
                var world = service.coordinateDestination(caller, requested, position);
                entities.move(caller, targets, world, position, Operation.COORDINATES);
            });
        }
        var destination = ProjectSelectors.single(selectors.resolve(caller, reader, false));
        ProjectSelectors.end(reader);
        return run(context, () -> entities.move(caller, targets, (ServerLevel) destination.level(), EntityTeleports.positionOf(destination), Operation.PLAYER));
    }

    @FunctionalInterface private interface Action { void run() throws CommandSyntaxException; }
    private static int run(CommandContext<CommandSourceStack> context, Action action) throws CommandSyntaxException {
        try { action.run(); }
        catch (TeleportService.Rejected rejected) { throw error(rejected.getMessage()); }
        context.getSource().sendSuccess(() -> Component.literal("Teleported within your Plan project."), false);
        return 1;
    }

    private static CommandSyntaxException error(String message) {
        return new SimpleCommandExceptionType(Component.literal(message)).create();
    }
}
