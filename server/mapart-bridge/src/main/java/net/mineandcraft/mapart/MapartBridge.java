package net.mineandcraft.mapart;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import eu.pb4.mapcanvas.api.core.CanvasImage;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.storage.LevelResource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import space.essem.image2map.Image2Map;
import space.essem.image2map.renderer.MapRenderer;
import static net.minecraft.commands.Commands.argument;
import static net.minecraft.commands.Commands.literal;

public final class MapartBridge implements ModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("mineandcraft-mapart");
    private static final Gson JSON = new Gson();
    private final Set<UUID> claiming = ConcurrentHashMap.newKeySet();
    private final java.util.Map<UUID, Long> lastClaim = new ConcurrentHashMap<>();
    private ScheduledExecutorService worker;
    private BridgeClient client;
    private ArtStore store;
    private volatile MinecraftServer server;
    @Override public void onInitialize() {
        // Set before command registration: Image2Map captures this permission level.
        Image2Map.CONFIG.minPermLevel = 4; Image2Map.CONFIG.allowLocalFiles = false;
        CommandRegistrationCallback.EVENT.register((dispatcher, registry, environment) -> dispatcher.register(literal("mapart").then(literal("claim").then(argument("code", StringArgumentType.word()).executes(context -> {
            var player = context.getSource().getPlayerOrException(); claim(player, StringArgumentType.getString(context, "code")); return 1;
        })))));
        ServerLifecycleEvents.SERVER_STARTED.register(this::start);
        ServerLifecycleEvents.SERVER_STOPPING.register(value -> { server = null; if (worker != null) worker.shutdownNow(); claiming.clear(); lastClaim.clear(); });
    }
    private void start(MinecraftServer server) {
        try {
            var configPath = FabricLoader.getInstance().getConfigDir().resolve("mineandcraft-mapart.json");
            if (!Files.exists(configPath)) { LOG.info("Mapart is disabled. Install config/mineandcraft-mapart.json to connect the wiki."); return; }
            var config = JSON.fromJson(Files.readString(configPath), JsonObject.class);
            if (!config.get("enabled").getAsBoolean()) return;
            client = new BridgeClient(config.get("site_origin").getAsString(), System.getenv("MAPART_BRIDGE_KEY"));
            store = new ArtStore(server.getWorldPath(LevelResource.ROOT).resolve("mineandcraft-mapart"));
            // Ordinary members use the companion's claims, not unrestricted image URLs.
            Image2Map.CONFIG.minPermLevel = 4; Image2Map.CONFIG.allowLocalFiles = false;
            this.server = server;
            worker = Executors.newSingleThreadScheduledExecutor(runnable -> { var thread = new Thread(runnable, "mapart-worker"); thread.setDaemon(true); return thread; });
            worker.scheduleWithFixedDelay(this::poll, 1, 15, TimeUnit.SECONDS);
            LOG.info("Mapart bridge connected; polling every 15 seconds.");
        } catch (Exception error) { LOG.error("Mapart bridge could not start ({}). Check configuration and restore a damaged registry before retrying.", error.getClass().getSimpleName()); }
    }
    private void poll() {
        if (server == null) return;
        JsonObject job = null;
        try {
            // Remove retired conversion caches, retaining issued-map registry entries.
            var active = client.json("/api/mapart/bridge/active/", null).getAsJsonArray("ids");
            var ids = new java.util.HashSet<String>(); active.forEach(value -> ids.add(value.getAsString()));
            try (var paths = Files.list(store.pixelsPath("00000000-0000-0000-0000-000000000000").getParent())) {
                for (var path : paths.filter(value -> value.getFileName().toString().endsWith(".pixels")).toList()) {
                    if (!ids.contains(path.getFileName().toString().replace(".pixels", ""))) Files.deleteIfExists(path);
                }
            }
            var response = client.json("/api/mapart/bridge/lease/", new JsonObject());
            if (response.get("job").isJsonNull()) return;
            job = response.getAsJsonObject("job");
            String id = job.get("id").getAsString(), lease = job.get("lease").getAsString();
            var layout = JSON.fromJson(job.get("settings"), Layout.class);
            byte[] pixels;
            var path = store.pixelsPath(id);
            if (Files.exists(path)) pixels = Files.readAllBytes(path);
            else {
                var source = client.source(id, lease);
                if (!BridgeClient.checksum(source.bytes()).equals(source.checksum())) throw new IllegalStateException("Source checksum mismatch");
                var image = layout.compose(source.bytes());
                try {
                    CanvasImage canvas = MapRenderer.render(image, layout.dither() ? Image2Map.DitherMode.FLOYD : Image2Map.DitherMode.NONE, layout.width(), layout.height());
                    pixels = new byte[layout.width() * layout.height()];
                    for (int i = 0; i < pixels.length; i++) pixels[i] = canvas.getRawAt(i);
                } finally { image.flush(); }
                ArtStore.atomicWrite(path, pixels);
            }
            if (pixels.length != layout.width() * layout.height()) throw new IllegalStateException("Invalid cached artwork");
            var preview = previewImage(layout, pixels);
            var png = new ByteArrayOutputStream(); ImageIO.write(preview, "png", png); preview.flush();
            client.result(id, lease, pixels, png.toByteArray());
        } catch (Exception error) {
            if (Thread.currentThread().isInterrupted()) return;
            LOG.warn("Mapart processing will retry or requires a new image ({}).", error.getClass().getSimpleName());
            if (job != null) try { client.failed(job.get("id").getAsString(), job.get("lease").getAsString()); } catch (Exception ignored) { /* Lease recovery handles unavailable network. */ }
        }
    }
    static BufferedImage previewImage(Layout layout, byte[] pixels) {
        var preview = new BufferedImage(layout.width(), layout.height(), BufferedImage.TYPE_INT_ARGB);
        for (int i = 0; i < pixels.length; i++) preview.setRGB(i % layout.width(), i / layout.width(), MapColor.getColorFromPackedId(Byte.toUnsignedInt(pixels[i])));
        return preview;
    }
    private static String identity(ServerPlayer player) throws Exception {
        if (FabricLoader.getInstance().isModLoaded("floodgate")) {
            Class<?> type = Class.forName("org.geysermc.floodgate.api.FloodgateApi");
            Object api = type.getMethod("getInstance").invoke(null);
            if ((boolean) type.getMethod("isFloodgatePlayer", UUID.class).invoke(api, player.getUUID())) {
                Object account = type.getMethod("getPlayer", UUID.class).invoke(api, player.getUUID());
                String xuid = String.valueOf(Class.forName("org.geysermc.floodgate.api.player.FloodgatePlayer").getMethod("getXuid").invoke(account));
                if (!xuid.matches("[0-9]{1,20}")) throw new IllegalStateException("Invalid Floodgate identity");
                return "bedrock:" + xuid;
            }
        }
        return "java:" + player.getUUID().toString().replace("-", "");
    }
    private void claim(ServerPlayer player, String code) {
        if (server == null || worker == null) { message(player, "Mapart is not connected yet."); return; }
        if (!code.matches("[a-f0-9]{12}")) { message(player, "Copy the claim command from the mapart website."); return; }
        UUID uuid = player.getUUID();
        if (System.currentTimeMillis() - lastClaim.getOrDefault(uuid, 0L) < 3000 || !claiming.add(uuid)) { message(player, "Wait for your current mapart claim."); return; }
        lastClaim.put(uuid, System.currentTimeMillis());
        final String target;
        try { target = identity(player); } catch (Exception error) { claiming.remove(uuid); message(player, "Your Minecraft identity could not be verified."); return; }
        message(player, "Checking mapart and your Discord permissions…");
        final MinecraftServer current = server;
        worker.execute(() -> {
            try {
                var request = new JsonObject(); request.addProperty("code", code); request.addProperty("identity", target);
                var art = client.json("/api/mapart/bridge/claim/", request);
                String id = art.get("id").getAsString(), sha256 = art.get("sha256").getAsString();
                byte[] pixels = client.pixels(art.get("pixels").getAsString());
                if (!BridgeClient.checksum(pixels).equals(sha256)) throw new IllegalStateException("Artwork checksum mismatch");
                long authorized = System.currentTimeMillis();
                current.execute(() -> {
                    try {
                        if (server != current || current.getPlayerList().getPlayer(uuid) != player || System.currentTimeMillis() - authorized > 10000) return;
                        deliver(player, art, pixels, sha256);
                    } catch (Exception error) { message(player, "Mapart could not be delivered. No automatic retry will take more maps."); LOG.warn("Mapart claim failed ({}).", error.getClass().getSimpleName()); }
                    finally { claiming.remove(uuid); }
                });
            } catch (Exception error) {
                claiming.remove(uuid); current.execute(() -> { if (current.getPlayerList().getPlayer(uuid) == player) message(player, "The claim could not be authorized. Check the artwork, account, and Discord role, then retry."); });
            }
        });
    }
    private void deliver(ServerPlayer player, JsonObject art, byte[] pixels, String sha256) throws Exception {
        if (!player.isAlive() || player.isSpectator() || player.containerMenu != player.inventoryMenu) { message(player, "Close any open container and claim while alive outside spectator mode."); return; }
        var layout = JSON.fromJson(art.get("settings"), Layout.class);
        var inventory = player.getInventory();
        var after = new ItemStack[36];
        var maps = new int[36]; var empty = new boolean[36];
        for (int slot = 0; slot < 36; slot++) {
            after[slot] = inventory.getItem(slot).copy(); empty[slot] = after[slot].isEmpty();
            if (after[slot].is(Items.MAP)) maps[slot] = after[slot].getCount();
        }
        // Check the current game mode after asynchronous claim authorization.
        int cost = player.isCreative() ? 0 : layout.tiles();
        final MapPayment.Plan payment;
        try { payment = MapPayment.plan(maps, empty, cost); }
        catch (IllegalStateException error) { message(player, error.getMessage()); return; }
        // Prepare and durably register every map before charging the player.
        var item = store.item(server.overworld(), art.get("id").getAsString(), art.get("title").getAsString(), layout, pixels, sha256);
        for (int slot = 0; slot < 36; slot++) after[slot].shrink(payment.deductions()[slot]);
        after[payment.deliverySlot()] = item;
        for (int slot = 0; slot < 36; slot++) inventory.setItem(slot, after[slot]);
        inventory.setChanged(); player.inventoryMenu.broadcastChanges();
        server.getPlayerList().saveAll();
        message(player, (cost == 0 ? "Mapart delivered free in creative mode." : "Mapart delivered for " + cost + " blank maps.") + " Place the bundle at the top-left of a complete, empty frame grid.");
    }
    public static void message(ServerPlayer player, String text) { player.sendSystemMessage(Component.literal(text)); }
}
