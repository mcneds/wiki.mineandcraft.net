package net.mineandcraft.mapart;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import io.netty.channel.embedded.EmbeddedChannel;
import java.nio.file.Files;
import java.util.UUID;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.GameType;

/** Exercises real delivery and inventory changes without calling the live wiki. */
public class CreativeClaimsTest {
    @GameTest
    public void chargesCurrentGameModeAtDelivery(GameTestHelper test) throws Exception {
        var server = test.getLevel().getServer();
        // Vanilla's mock player hardcodes creative mode, so use a normal player.
        var cookie = CommonListenerCookie.createInitial(new GameProfile(UUID.randomUUID(), "mapart-test"), false);
        var player = new ServerPlayer(server, test.getLevel(), cookie.gameProfile(), cookie.clientInformation());
        var connection = new Connection(PacketFlow.SERVERBOUND);
        var channel = new EmbeddedChannel(connection);
        server.getPlayerList().placeNewPlayer(connection, player, cookie);
        var bridge = new MapartBridge();
        var serverField = MapartBridge.class.getDeclaredField("server");
        serverField.setAccessible(true); serverField.set(bridge, server);
        var storeField = MapartBridge.class.getDeclaredField("store");
        storeField.setAccessible(true); storeField.set(bridge, new ArtStore(Files.createTempDirectory("mapart-claim-test")));
        var deliver = MapartBridge.class.getDeclaredMethod("deliver", ServerPlayer.class, JsonObject.class, byte[].class, String.class);
        deliver.setAccessible(true);
        var art = new JsonObject();
        art.addProperty("id", UUID.randomUUID().toString());
        art.addProperty("title", "Claim test");
        art.add("settings", new Gson().toJsonTree(new Layout(1, 1, "fit", "center", "center", false)));
        byte[] pixels = new byte[128 * 128];
        String checksum = BridgeClient.checksum(pixels);
        player.getInventory().clearContent();
        player.setGameMode(GameType.CREATIVE);
        deliver.invoke(bridge, player, art, pixels, checksum);
        test.assertTrue(player.getInventory().getItem(35).is(Items.FILLED_MAP), "Creative receives artwork with no materials in an ordinary world");
        player.getInventory().clearContent();
        player.getInventory().setItem(0, new ItemStack(Items.MAP, 5));
        deliver.invoke(bridge, player, art, pixels, checksum);
        test.assertValueEqual(player.getInventory().getItem(0).getCount(), 5, "Creative maps are not consumed");
        for (int slot = 0; slot < 36; slot++) player.getInventory().setItem(slot, new ItemStack(Items.DIAMOND));
        deliver.invoke(bridge, player, art, pixels, checksum);
        for (int slot = 0; slot < 36; slot++) test.assertTrue(player.getInventory().getItem(slot).is(Items.DIAMOND), "Full creative inventory is preserved");
        player.getInventory().clearContent();
        player.setGameMode(GameType.SURVIVAL);
        deliver.invoke(bridge, player, art, pixels, checksum);
        test.assertTrue(player.getInventory().getItem(35).isEmpty(), "Switching to survival requires materials");
        player.getInventory().setItem(0, new ItemStack(Items.MAP, 5));
        deliver.invoke(bridge, player, art, pixels, checksum);
        test.assertValueEqual(player.getInventory().getItem(0).getCount(), 4, "Survival pays one map per tile");
        test.assertTrue(player.getInventory().getItem(35).is(Items.FILLED_MAP), "Survival receives paid artwork");
        server.getPlayerList().remove(player);
        channel.finishAndReleaseAll();
        test.succeed();
    }
}
