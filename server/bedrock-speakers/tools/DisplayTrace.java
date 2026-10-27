package net.mineandcraft.bedrockspeakers.debug;

import io.netty.channel.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.geysermc.event.subscribe.Subscribe;
import org.geysermc.geyser.GeyserImpl;
import org.geysermc.geyser.api.event.bedrock.SessionInitializeEvent;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.netty.BedrockPacketWrapper;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.netty.codec.packet.BedrockPacketCodec;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.*;

/** Bounded, read-only packet observations; no logging in the network hot path. */
public final class DisplayTrace {
    private static final Map<String, Map<String, Object>> actors = new ConcurrentHashMap<>();
    public static void activate() {
        var geyser = GeyserImpl.getInstance();
        geyser.eventBus().register(geyser.extensionManager().extension("copperbedrock"), new DisplayTrace());
        for (var session : geyser.getSessionManager().getAllSessions()) install(session);
    }
    @Subscribe public void initialize(SessionInitializeEvent event) {
        if (event.connection() instanceof GeyserSession session) install(session);
    }
    static void properties(Map<String,Object> actor, org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityProperties values) {
        for (var value : values.getIntProperties()) actor.put("int:" + value.getIndex(), value.getValue());
        for (var value : values.getFloatProperties()) actor.put("float:" + value.getIndex(), value.getValue());
    }
    static void install(GeyserSession session) {
        var channel = session.getUpstream().getSession().getPeer().getChannel();
        Runnable task = () -> {
            var pipeline = channel.pipeline();
            if (pipeline.get("copper-display-trace") != null) return;
            for (var entry : pipeline) {
                if (!(entry.getValue() instanceof BedrockPacketCodec)) continue;
                pipeline.addAfter(entry.getKey(), "copper-display-trace", new ChannelOutboundHandlerAdapter() {
                    @Override public void write(ChannelHandlerContext context, Object message, ChannelPromise promise) throws Exception {
                        if (message instanceof BedrockPacketWrapper wrapper) {
                            String prefix = session.bedrockUsername() + ":";
                            if (wrapper.getPacket() instanceof AddEntityPacket packet && packet.getIdentifier().equals("geyser:item_display") && actors.size() < 128) {
                                var actor = new ConcurrentHashMap<String,Object>();
                                actor.put("position", packet.getPosition()); actor.put("metadata", Map.copyOf(packet.getMetadata()));
                                properties(actor, packet.getProperties()); actors.put(prefix + packet.getRuntimeEntityId(), actor);
                            } else if (wrapper.getPacket() instanceof SetEntityDataPacket packet) {
                                var actor = actors.get(prefix + packet.getRuntimeEntityId());
                                if (actor != null) { properties(actor, packet.getProperties()); if (!packet.getMetadata().isEmpty()) actor.put("metadataUpdate", Map.copyOf(packet.getMetadata())); }
                            }
                        }
                        super.write(context, message, promise);
                    }
                });
                return;
            }
        };
        if (channel.eventLoop().inEventLoop()) task.run(); else channel.eventLoop().execute(task);
    }
    public static String snapshot() { return new TreeMap<>(actors).toString(); }
}
