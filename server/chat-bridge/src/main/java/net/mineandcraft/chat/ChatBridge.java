package net.mineandcraft.chat;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundCustomChatCompletionsPacket;
import net.minecraft.network.protocol.game.ClientboundSoundPacket;
import net.minecraft.network.protocol.game.ClientboundCustomChatCompletionsPacket.Action;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class ChatBridge implements ModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("mineandcraft-chat");
    private static final Gson JSON = new Gson();
    private final ArrayBlockingQueue<JsonObject> outbound = new ArrayBlockingQueue<>(100);
    // Main-thread only: inbound IDs and player completion state.
    private final Map<String, Long> delivered = new HashMap<>();
    private List<String> suggestions = List.of();
    private volatile MinecraftServer server;
    private volatile int players;
    private ScheduledExecutorService worker;
    private Transport transport;
    private final String session = UUID.randomUUID().toString();
    private long nextDirectory, lastWarning;
    private boolean connected;

    @Override public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(this::start);
        ServerLifecycleEvents.SERVER_STOPPING.register(value -> stop());
        ServerTickEvents.END_SERVER_TICK.register(value -> players = value.getPlayerList().getPlayerCount());
        ServerPlayConnectionEvents.JOIN.register((handler, sender, value) -> {
            if (server != null && !suggestions.isEmpty()) handler.player.connection.send(new ClientboundCustomChatCompletionsPacket(Action.ADD, suggestions));
        });
        ServerMessageEvents.CHAT_MESSAGE.register((message, sender, type) -> {
            // Only actual public chat, not /say, /me, /msg or team commands.
            if (server == null || !type.chatType().is(ChatType.CHAT) || message.isFullyFiltered()) return;
            var event = new JsonObject();
            event.addProperty("id", UUID.randomUUID().toString());
            event.addProperty("playerId", sender.getUUID().toString());
            event.addProperty("sender", sender.getPlainTextName());
            event.addProperty("text", message.signedContent());
            event.addProperty("createdAt", System.currentTimeMillis());
            if (!outbound.offer(event)) sender.sendSystemMessage(Component.literal("Discord chat is busy; this message was only sent in Minecraft."));
        });
    }

    private void start(MinecraftServer value) {
        try {
            Path configPath = FabricLoader.getInstance().getConfigDir().resolve("mineandcraft-chat.json");
            if (!Files.exists(configPath)) { LOG.info("Chat bridge disabled: no configuration."); return; }
            var config = JSON.fromJson(Files.readString(configPath), JsonObject.class);
            if (!config.get("enabled").getAsBoolean()) return;
            Path keyPath = Path.of(config.get("key_file").getAsString());
            if (!keyPath.isAbsolute()) throw new IllegalArgumentException("Chat key file must be absolute");
            transport = new Transport(Files.readString(keyPath).strip());
            server = value;
            worker = Executors.newSingleThreadScheduledExecutor(r -> { var thread = new Thread(r, "mineandcraft-chat"); thread.setDaemon(true); return thread; });
            worker.scheduleWithFixedDelay(this::poll, 0, 1, TimeUnit.SECONDS);
            LOG.info("Chat companion started; connecting to the local Discord bot.");
        } catch (Exception error) { LOG.error("Chat bridge disabled ({}); check private configuration.", error.getClass().getSimpleName()); }
    }

    private void poll() {
        MinecraftServer current = server;
        if (current == null) return;
        try {
            var response = transport.request("/bridge/poll?session=" + session + "&players=" + players, null);
            if (response.status() != 200) throw new IllegalStateException("Chat bot unavailable");
            if (!connected) { LOG.info("Chat bridge connected to Discord transport."); connected = true; }
            JsonArray messages = response.body().getAsJsonArray("messages");
            if (messages.size() > 20) throw new IllegalArgumentException("Too many chat messages");
            if (!messages.isEmpty()) {
                var done = new CompletableFuture<JsonArray>();
                current.execute(() -> {
                    try { done.complete(deliver(current, messages)); }
                    catch (Exception error) { done.completeExceptionally(error); }
                });
                var ids = done.get(3, TimeUnit.SECONDS);
                if (!ids.isEmpty()) {
                    var ack = new JsonObject(); ack.addProperty("session", session); ack.add("ids", ids);
                    transport.request("/bridge/ack", ack);
                }
            }
            // Keep poll/ack latency bounded even during a busy outgoing burst.
            for (int i = 0; i < 5; i++) {
                JsonObject event = outbound.peek();
                if (event == null) break;
                if (System.currentTimeMillis() - event.get("createdAt").getAsLong() > 30000) {
                    outbound.poll(); feedback(event, "Discord delivery expired; this message was only sent in Minecraft."); continue;
                }
                var sent = transport.request("/bridge/events", event);
                if (sent.status() == 200) outbound.poll();
                else if (sent.status() == 400 || sent.status() == 429) {
                    outbound.poll(); feedback(event, "Discord could not relay this message (invalid message or five-message/ten-second limit).");
                } else break;
            }
            if (System.currentTimeMillis() >= nextDirectory) {
                nextDirectory = System.currentTimeMillis() + 30000;
                var directory = transport.request("/bridge/directory", null);
                if (directory.status() == 200) {
                    var entries = new ArrayList<String>();
                    for (var entry : directory.body().getAsJsonArray("suggestions")) {
                        String text = entry.getAsString();
                        if (text.startsWith("@") && text.length() <= 128 && entries.size() < 5000) entries.add(text);
                    }
                    current.execute(() -> updateSuggestions(current, entries));
                }
            }
        } catch (Exception error) {
            connected = false;
            long now = System.currentTimeMillis();
            if (now - lastWarning >= 30000) { LOG.warn("Chat transport unavailable ({}); reconnecting.", error.getClass().getSimpleName()); lastWarning = now; }
            // Do not hold chat indefinitely during an outage.
            while (outbound.peek() != null && now - outbound.peek().get("createdAt").getAsLong() > 30000) {
                feedback(outbound.poll(), "Discord is unavailable; this message was only sent in Minecraft.");
            }
        }
    }

    private JsonArray deliver(MinecraftServer current, JsonArray messages) {
        var ids = new JsonArray();
        long now = System.currentTimeMillis();
        delivered.values().removeIf(time -> time < now - 60000);
        if (server != current) return ids;
        for (var element : messages) {
            var value = element.getAsJsonObject();
            String id = value.get("id").getAsString();
            if (!id.matches("[0-9]{17,20}")) continue;
            if (delivered.containsKey(id)) { ids.add(id); continue; }
            long expires = value.get("expiresAt").getAsLong();
            if (expires <= now || expires > now + 30000) continue;
            for (String line : ChatText.lines(value.get("sender").getAsString(), value.get("text").getAsString()))
                current.getPlayerList().broadcastSystemMessage(Component.literal(line), false);
            if (value.has("notifyNames")) {
                var names = new ArrayList<String>();
                for (var name : value.getAsJsonArray("notifyNames")) if (names.size() < 100) names.add(name.getAsString());
                for (ServerPlayer player : current.getPlayerList().getPlayers())
                    if (ChatText.mentionedPlayer(names, player.getPlainTextName()))
                        player.connection.send(new ClientboundSoundPacket(SoundEvents.NOTE_BLOCK_PLING, SoundSource.PLAYERS,
                            player.getX(), player.getY(), player.getZ(), 0.6F, 1.4F, java.util.concurrent.ThreadLocalRandom.current().nextLong()));
            }
            delivered.put(id, now); ids.add(id);
        }
        return ids;
    }

    private void feedback(JsonObject event, String message) {
        MinecraftServer current = server;
        if (current == null || event == null) return;
        current.execute(() -> {
            ServerPlayer player = current.getPlayerList().getPlayer(UUID.fromString(event.get("playerId").getAsString()));
            if (player != null) player.sendSystemMessage(Component.literal(message));
        });
    }

    private void updateSuggestions(MinecraftServer current, List<String> values) {
        if (server != current || values.equals(suggestions)) return;
        var removed = new ArrayList<>(suggestions); removed.removeAll(values);
        var added = new ArrayList<>(values); added.removeAll(suggestions);
        for (ServerPlayer player : current.getPlayerList().getPlayers()) {
            if (!removed.isEmpty()) player.connection.send(new ClientboundCustomChatCompletionsPacket(Action.REMOVE, removed));
            if (!added.isEmpty()) player.connection.send(new ClientboundCustomChatCompletionsPacket(Action.ADD, added));
        }
        suggestions = List.copyOf(values);
    }

    private void stop() {
        server = null;
        if (worker != null) worker.shutdownNow();
        if (transport != null) transport.close();
        outbound.clear(); delivered.clear(); suggestions = List.of();
    }
}
