package net.mineandcraft.plantools.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.ResourceArgument;
import net.minecraft.commands.arguments.coordinates.Coordinates;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.mineandcraft.plantools.entity.ProjectSummoner;
import static net.minecraft.commands.Commands.argument;
import static net.minecraft.commands.Commands.literal;

public final class SummonCommands {
    private final ProjectSummoner summoner;
    public SummonCommands(ProjectSummoner summoner) { this.summoner = summoner; }

    public void register(CommandDispatcher<CommandSourceStack> dispatcher, CommandBuildContext registry) {
        dispatcher.register(literal("psummon")
                .then(argument("entity", ResourceArgument.resource(registry, Registries.ENTITY_TYPE))
                        .executes(context -> summon(context, false))
                        .then(argument("position", Vec3Argument.vec3()).executes(context -> summon(context, true)))));
    }

    private int summon(CommandContext<CommandSourceStack> context, boolean withPosition) throws CommandSyntaxException {
        var player = context.getSource().getPlayerOrException();
        var position = withPosition ? context.getArgument("position", Coordinates.class).getPosition(player.createCommandSourceStack()) : player.position();
        summoner.summon(player, ResourceArgument.getSummonableEntityType(context, "entity"), position);
        context.getSource().sendSuccess(() -> Component.literal("Entity summoned inside your Plan project."), false);
        return 1;
    }
}
