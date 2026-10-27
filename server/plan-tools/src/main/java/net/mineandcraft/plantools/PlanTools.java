package net.mineandcraft.plantools;

import java.io.IOException;
import java.util.List;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.network.chat.Component;
import net.minecraft.server.permissions.Permissions;
import net.mineandcraft.plantools.command.TeleportCommands;
import net.mineandcraft.plantools.command.SummonCommands;
import net.mineandcraft.plantools.entity.ProjectSummoner;
import net.mineandcraft.plantools.core.TeleportService;
import net.mineandcraft.plantools.plan.PlanProjectAccess;
import org.slf4j.LoggerFactory;
import static net.minecraft.commands.Commands.literal;

public final class PlanTools implements ModInitializer {
    @Override public void onInitialize() {
        final ToolsConfig config;
        try {
            config = new ToolsConfig(FabricLoader.getInstance().getConfigDir().resolve("mineandcraft-plan-tools.json"));
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("Cannot load config/mineandcraft-plan-tools.json; fix the configuration before starting.", error);
        }
        // Add pure TeleportRule implementations here. The service always enforces project isolation first.
        var access = new PlanProjectAccess();
        var service = new TeleportService<>(access, config::options, List.of());
        var commands = new TeleportCommands(service, access);
        var summon = new SummonCommands(new ProjectSummoner(access, config::options, config::summonEnabled));
        CommandRegistrationCallback.EVENT.register((dispatcher, registry, environment) -> {
            commands.register(dispatcher);
            summon.register(dispatcher, registry);
            dispatcher.register(literal("plantools").requires(source -> source.permissions().hasPermission(Permissions.COMMANDS_ADMIN))
                    .then(literal("reload").executes(context -> {
                        try {
                            config.reload();
                            context.getSource().sendSuccess(() -> Component.literal("Plan Tools configuration reloaded."), false);
                            return 1;
                        } catch (IOException | RuntimeException error) {
                            LoggerFactory.getLogger("mineandcraft-plan-tools").warn("Plan Tools reload rejected; previous settings retained", error);
                            context.getSource().sendFailure(Component.literal("Invalid Plan Tools configuration; previous settings retained. Check the server log."));
                            return 0;
                        }
                    })));
        });
    }
}
