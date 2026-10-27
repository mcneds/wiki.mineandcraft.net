package net.mineandcraft.plantools;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.StringReader;
import com.planmod.session.SessionManager;
import com.planmod.world.PlanWorlds;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.PermissionSet;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ChunkPos;
import net.mineandcraft.plantools.plan.PlanProjectAccess;
import net.mineandcraft.plantools.command.ProjectSelectors;
import net.minecraft.commands.arguments.selector.EntitySelectorParser;

/** Runs against the real Plan JAR and Minecraft server, with connected mock players. */
public class PlanIntegrationTest {
    @GameTest(maxTicks = 20000)
    public void projectTeleportAndInventoryIsolation(GameTestHelper test) throws CommandSyntaxException {
        CommandSyntaxException.ENABLE_COMMAND_STACK_TRACES = true;
        var server = test.getLevel().getServer();
        var dispatcher = server.getCommands().getDispatcher();
        ServerPlayer player = test.makeMockServerPlayerInLevel();
        var access = new PlanProjectAccess();
        var originalWorld = player.level();
        var originalPosition = player.position();
        player.getInventory().setItem(0, new ItemStack(Items.DIAMOND, 3));

        reject(test, () -> dispatcher.execute("ptp 10 80 20", player.createCommandSourceStack()));
        reject(test, () -> dispatcher.execute("psummon cow", player.createCommandSourceStack()));
        test.assertTrue(access.member(player).isEmpty(), "Survival player has no project membership");

        dispatcher.execute("plan create superflat TeleportTest", player.createCommandSourceStack());
        var project = SessionManager.sessionProject(player);
        test.assertTrue(access.member(player).isPresent(), "Plan session matches actual project world");
        player.getInventory().setItem(0, new ItemStack(Items.GOLD_BLOCK, 5));

        for (String dimension : new String[] {"overworld", "nether", "end", "overworld"}) {
            int result = dispatcher.execute("ptp in " + dimension + " 10 80 -20",
                    player.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS));
            test.assertValueEqual(result, 1, "Non-op project teleport succeeds");
            var ref = PlanWorlds.ref(player.level().dimension());
            test.assertValueEqual(ref.projectId(), project.id, "Destination belongs to same project");
            var expectedKind = switch (dimension) {
                case "nether" -> PlanWorlds.Kind.NETHER;
                case "end" -> PlanWorlds.Kind.END;
                default -> PlanWorlds.Kind.MAIN;
            };
            test.assertValueEqual(ref.kind(), expectedKind, "Requested dimension reached");
            test.assertTrue(player.getX() == 10.5 && player.getY() == 80 && player.getZ() == -19.5, "Coordinates preserved at block centre");
            test.assertTrue(player.getInventory().getItem(0).is(Items.GOLD_BLOCK), "Project inventory retained");
        }

        dispatcher.execute("ptp ~1 ~2 ~3", player.createCommandSourceStack());
        test.assertTrue(player.getX() == 11.5 && player.getY() == 82 && player.getZ() == -16.5, "Relative coordinates resolved from player");
        reject(test, () -> dispatcher.execute("ptp in minecraft:overworld 0 80 0", player.createCommandSourceStack()));
        dispatcher.execute("ptp player @s", player.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS));
        reject(test, () -> dispatcher.execute("ptp 0 -9999 0", player.createCommandSourceStack()));

        var outsider = test.makeMockServerPlayerInLevel();
        var otherProjectPlayer = test.makeMockServerPlayerInLevel();
        dispatcher.execute("plan create superflat OtherProject", otherProjectPlayer.createCommandSourceStack());
        dispatcher.execute("ptp 11 82 -17", otherProjectPlayer.createCommandSourceStack());
        var otherProjectPosition = otherProjectPlayer.position();
        var friend = test.makeMockServerPlayerInLevel();
        player.addTag("owner_test");
        outsider.addTag("outsider_test");
        project.members.add(friend.getUUID());
        SessionManager.enter(friend, project);
        test.assertTrue(access.member(friend).isPresent(), "Invited guest has a valid session");
        dispatcher.execute("ptp 100 80 100", friend.createCommandSourceStack());
        outsider.teleportTo(11.5, 82, -16.5);
        var outsiderPosition = outsider.position();
        var selectors = new ProjectSelectors(access);
        var nearest = selectors.resolve(player, new StringReader("@p[tag=!owner_test]"), true);
        test.assertValueEqual(nearest.getFirst().getUUID(), friend.getUUID(), "Project filtering precedes nearest/limit");
        reject(test, () -> dispatcher.execute("ptp player " + outsider.getUUID(), player.createCommandSourceStack()));
        reject(test, () -> dispatcher.execute("ptp " + otherProjectPlayer.getUUID(), player.createCommandSourceStack()));
        reject(test, () -> dispatcher.execute("ptp @a[tag=outsider_test] 0 80 0", player.createCommandSourceStack()));
        reject(test, () -> dispatcher.execute("ptp player @a", player.createCommandSourceStack()));
        dispatcher.execute("ptp @a 30 80 30", player.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS));
        test.assertTrue(friend.getX() == 30.5 && player.getX() == 30.5, "Only project players selected by @a");
        test.assertValueEqual(outsider.position(), outsiderPosition, "Survival player unaffected by bulk selector");
        test.assertValueEqual(otherProjectPlayer.position(), otherProjectPosition, "Other project unaffected by bulk selector");
        test.assertFalse(EntitySelectorParser.allowSelectors(player.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS)), "Selector permission was not granted globally");
        dispatcher.execute("ptp @s in nether 20 80 20", friend.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS));
        dispatcher.execute("ptp player @a[tag=!owner_test,limit=1]", player.createCommandSourceStack());
        test.assertValueEqual(player.level(), friend.level(), "Selector target works across project dimensions");
        dispatcher.execute("ptp @s " + friend.getUUID(), player.createCommandSourceStack());
        test.assertValueEqual(player.blockPosition(), friend.blockPosition(), "UUID works as a selected destination");

        // Use the flat project world for entity tests; mock clients do not request chunks.
        dispatcher.execute("ptp @a in overworld 20 80 20", player.createCommandSourceStack());
        var summonWorld = player.level();
        summonWorld.setChunkForced(7, 7, true);
        summonWorld.setChunkForced(1, 1, true);
        test.startSequence().thenWaitUntil(() -> {
            test.assertTrue(summonWorld.areEntitiesActuallyLoadedAndTicking(new ChunkPos(7, 7))
                    && summonWorld.areEntitiesActuallyLoadedAndTicking(new ChunkPos(1, 1)), "Summon chunks are ticking");
        }).thenExecute(() -> {
            try {
                dispatcher.execute("psummon minecraft:cow 120 80 120", player.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS));
                var cows = selectors.resolve(player, new StringReader("@e[type=minecraft:cow,x=120,y=80,z=120,distance=..2]"), false);
                test.assertValueEqual(cows.size(), 1, "Summon creates one cow in current project dimension");
                var cow = cows.getFirst();
                cow.addTag("summon_test");
                dispatcher.execute("ptp @e[tag=summon_test] ~5 ~ ~", player.createCommandSourceStack().withPermission(PermissionSet.NO_PERMISSIONS));
                test.assertTrue(cow.getX() == 25.5 && cow.getY() == 80, "Entity selector moves summoned mob");
                dispatcher.execute("ptp @s @e[tag=summon_test,limit=1]", player.createCommandSourceStack());
                test.assertValueEqual(player.blockPosition(), cow.blockPosition(), "Entity selector can be a teleport destination");
                reject(test, () -> dispatcher.execute("ptp @e[tag=summon_test] in nether 0 80 0", player.createCommandSourceStack()));
                test.assertValueEqual(cow.level(), player.level(), "Rejected cross-dimension mob move leaves mob untouched");
                reject(test, () -> dispatcher.execute("psummon cow 0 -9999 0", player.createCommandSourceStack()));
                reject(test, () -> dispatcher.execute("psummon cow ~ ~ ~ {Passengers:[]}", player.createCommandSourceStack()));

                // A redirected command source must not summon into a survival dimension.
                dispatcher.execute("psummon pig ~1 ~ ~", player.createCommandSourceStack().withLevel(originalWorld));
                test.assertValueEqual(selectors.resolve(player, new StringReader("@e[type=minecraft:pig]"), false).size(), 1, "Summon uses actual project dimension");
                summonWorld.setChunkForced(7, 7, false);
                summonWorld.setChunkForced(1, 1, false);
                SessionManager.leave(friend);
                server.getPlayerList().remove(friend);
                server.getPlayerList().remove(outsider);
                SessionManager.leave(otherProjectPlayer);
                server.getPlayerList().remove(otherProjectPlayer);

                test.assertTrue(SessionManager.leave(player), "Plan session can exit normally after teleports");
                test.assertValueEqual(player.level(), originalWorld, "Survival dimension restored");
                test.assertValueEqual(player.position(), originalPosition, "Survival position restored");
                test.assertTrue(player.getInventory().getItem(0).is(Items.DIAMOND)
                        && player.getInventory().getItem(0).getCount() == 3, "Survival inventory restored without creative items");
                reject(test, () -> dispatcher.execute("ptp 10 80 20", player.createCommandSourceStack()));
                reject(test, () -> dispatcher.execute("psummon cow", player.createCommandSourceStack()));
                server.getPlayerList().remove(player);
                test.succeed();
            } catch (CommandSyntaxException failure) { failure.printStackTrace(); throw new RuntimeException(failure); }
        });
    }

    private static void reject(GameTestHelper test, Command action) {
        try {
            action.run();
        } catch (CommandSyntaxException expected) { return; }
        test.assertTrue(false, "Command should have been rejected");
    }

    @FunctionalInterface private interface Command { void run() throws CommandSyntaxException; }
}
