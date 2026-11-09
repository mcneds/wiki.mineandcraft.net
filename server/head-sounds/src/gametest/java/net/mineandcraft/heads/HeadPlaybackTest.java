package net.mineandcraft.heads;

import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.StringReader;
import java.util.UUID;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.commands.arguments.item.ItemParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.resources.Identifier;
import net.minecraft.server.players.NameAndId;
import net.minecraft.server.players.UserWhiteListEntry;
import net.minecraft.world.item.component.ResolvableProfile;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.NoteBlock;
import net.minecraft.world.level.block.entity.SkullBlockEntity;
import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.item.Items;
import java.util.zip.CRC32;

public class HeadPlaybackTest {
    @GameTest
    public void installedMappingAppliesToExistingHeadAndLiveWhitelist(GameTestHelper test) throws Exception {
        var level = test.getLevel();
        var pos = test.absolutePos(new BlockPos(1, 1, 1));
        level.setBlockAndUpdate(pos, Blocks.NOTE_BLOCK.defaultBlockState());
        level.setBlockAndUpdate(pos.above(), Blocks.PLAYER_HEAD.defaultBlockState());
        var skull = (SkullBlockEntity) level.getBlockEntity(pos.above());
        var id = UUID.fromString("069a79f4-44e9-4726-a5be-fca90e38aaf5");
        var field = SkullBlockEntity.class.getDeclaredField("owner"); field.setAccessible(true);
        field.set(skull, ResolvableProfile.createResolved(new GameProfile(id, "Notch")));
        var method = NoteBlock.class.getDeclaredMethod("getCustomSoundId", net.minecraft.world.level.Level.class, BlockPos.class);
        method.setAccessible(true);
        var expected = Identifier.parse("mineandcraft_music:head_11111111111141118111111111111111");
        test.assertValueEqual(method.invoke(Blocks.NOTE_BLOCK, level, pos), expected, "Already placed head resolves through the actual note-block mixin");
        var whitelist = level.getServer().getPlayerList().getWhiteList();
        var account = new NameAndId(id, "RenamedAccount");
        whitelist.add(new UserWhiteListEntry(account));
        try { test.assertTrue(method.invoke(Blocks.NOTE_BLOCK, level, pos) == null, "Whitelist immediately protects an outsider's existing head"); }
        finally { whitelist.remove(account); }
        test.assertValueEqual(method.invoke(Blocks.NOTE_BLOCK, level, pos), expected, "Canonical UUID remains stable across name changes");
        test.succeed();
    }
    @GameTest
    public void generatedProfileComponentAndSoundParse(GameTestHelper test) throws Exception {
        var parsed = new ItemParser(test.getLevel().registryAccess()).parse(new StringReader("minecraft:player_head[minecraft:profile={\"id\":[I;110787060,1156138790,-1514210135,238594805],\"name\":\"Notch\"},minecraft:note_block_sound=\"mineandcraft_music:head_11111111111141118111111111111111\"]"));
        test.assertTrue(parsed != null, "Generated head claim item parses on Minecraft 26.3");
        test.succeed();
    }
    @GameTest(maxTicks = 200)
    public void generatedClaimGivesHeadAndEnforcesFiveSecondCooldown(GameTestHelper test) {
        var server = test.getLevel().getServer();
        var cookie = CommonListenerCookie.createInitial(new GameProfile(UUID.randomUUID(), "HeadClaimTest"), false);
        var player = new ServerPlayer(server, test.getLevel(), cookie.gameProfile(), cookie.clientInformation());
        var connection = new Connection(PacketFlow.SERVERBOUND);
        var channel = new EmbeddedChannel(connection);
        server.getPlayerList().placeNewPlayer(connection, player, cookie);
        var crc = new CRC32(); crc.update("22222222-2222-4222-8222-222222222222".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String claim = "trigger mac_heads set " + (crc.getValue() & 0x7fffffff);
        test.runAfterDelay(5, () -> {
            server.getCommands().performPrefixedCommand(player.createCommandSourceStack(), claim);
            test.runAfterDelay(3, () -> {
                test.assertValueEqual(player.getInventory().countItem(Items.PLAYER_HEAD), 1, "Public trigger gives exactly one generated head");
                for (int slot = 0; slot < 36; slot++) {
                    var item = player.getInventory().getItem(slot);
                    if (item.is(Items.PLAYER_HEAD)) test.assertTrue(item.get(DataComponents.PROFILE) instanceof ResolvableProfile.Dynamic, "Claim resolves the account skin instead of freezing a default skin");
                }
                server.getCommands().performPrefixedCommand(player.createCommandSourceStack(), claim);
                test.runAfterDelay(3, () -> {
                    test.assertValueEqual(player.getInventory().countItem(Items.PLAYER_HEAD), 1, "Immediate repeat does not give a second head");
                    test.runAfterDelay(100, () -> {
                        server.getCommands().performPrefixedCommand(player.createCommandSourceStack(), claim);
                        test.runAfterDelay(3, () -> {
                            test.assertValueEqual(player.getInventory().countItem(Items.PLAYER_HEAD), 2, "Claims unlock after five seconds");
                            server.getPlayerList().remove(player); channel.finishAndReleaseAll(); test.succeed();
                        });
                    });
                });
            });
        });
    }
}
