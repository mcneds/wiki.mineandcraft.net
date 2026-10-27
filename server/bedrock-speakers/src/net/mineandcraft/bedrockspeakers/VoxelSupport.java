package net.mineandcraft.bedrockspeakers;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelOutboundHandlerAdapter;
import io.netty.channel.ChannelPromise;
import java.util.List;
import java.util.Map;
import org.geysermc.event.subscribe.Subscribe;
import org.geysermc.geyser.GeyserImpl;
import org.geysermc.geyser.api.event.bedrock.SessionInitializeEvent;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.SerializableVoxelShape;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.netty.BedrockPacketWrapper;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.netty.codec.packet.BedrockPacketCodec;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.VoxelShapesPacket;

/** Supply vanilla culling handles omitted by Geyser b1273's empty registry. */
public final class VoxelSupport {
    private static final String HANDLER = "copperbedrock-voxel-shapes";

    @Subscribe public void initialize(SessionInitializeEvent event) {
        if (event.connection() instanceof GeyserSession session) install(session);
    }

    /** Apply for the next client connection without restarting the Java server. */
    public static void activateLive() {
        var geyser = GeyserImpl.getInstance();
        geyser.eventBus().register(geyser.extensionManager().extension("copperbedrock"), new VoxelSupport());
        for (var session : geyser.getSessionManager().getAllSessions()) install(session);
        geyser.getLogger().info("Copper Bedrock voxel registry repair installed for client connections");
    }

    public static void install(GeyserSession session) {
        var channel = session.getUpstream().getSession().getPeer().getChannel();
        Runnable task = () -> {
            var pipeline = channel.pipeline();
            if (pipeline.get(HANDLER) != null) return;
            for (var entry : pipeline) {
                if (!(entry.getValue() instanceof BedrockPacketCodec)) continue;
                pipeline.addAfter(entry.getKey(), HANDLER, new ChannelOutboundHandlerAdapter() {
                    @Override public void write(ChannelHandlerContext context, Object message, ChannelPromise promise) throws Exception {
                        if (session.protocolVersion() == 2225 && message instanceof BedrockPacketWrapper wrapper
                                && wrapper.getPacket() instanceof VoxelShapesPacket packet) repair(packet);
                        super.write(context, message, promise);
                    }
                });
                return;
            }
            GeyserImpl.getInstance().getLogger().warning("Copper Bedrock: packet codec unavailable for voxel registry repair");
        };
        if (channel.eventLoop().inEventLoop()) task.run(); else channel.eventLoop().execute(task);
    }

    static SerializableVoxelShape cell(short occupied) {
        var cells = new SerializableVoxelShape.SerializableCells((short) 1, (short) 1, (short) 1, List.of(occupied));
        var boundaries = List.of(0f, 1f);
        return new SerializableVoxelShape(cells, boundaries, boundaries, boundaries);
    }

    public static boolean repair(VoxelShapesPacket packet) {
        // Preserve registries supplied by a later Geyser or another extension.
        if (!packet.getShapes().isEmpty() || !packet.getNameMap().isEmpty()) return false;
        packet.setShapes(List.of(cell((short) 0), cell((short) 1)));
        packet.setNameMap(Map.of("minecraft:empty", 0, "minecraft:unit_cube", 1));
        packet.setCustomShapeCount(0);
        return true;
    }

    public static VoxelShapesPacket defaults() {
        var packet = new VoxelShapesPacket();
        packet.setShapes(List.of()); packet.setNameMap(Map.of()); repair(packet);
        return packet;
    }
}
