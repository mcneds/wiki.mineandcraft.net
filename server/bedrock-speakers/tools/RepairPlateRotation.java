package net.mineandcraft.bedrockspeakers.debug;

import io.netty.channel.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.cloudburstmc.math.vector.Vector3f;
import org.geysermc.event.subscribe.Subscribe;
import org.geysermc.geyser.GeyserImpl;
import org.geysermc.geyser.api.event.bedrock.SessionInitializeEvent;
import org.geysermc.geyser.entity.type.ItemFrameEntity;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.translator.item.ItemTranslator;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.netty.BedrockPacketWrapper;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.netty.codec.packet.BedrockPacketCodec;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.AddEntityPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.MoveEntityAbsolutePacket;

/** Apply the sender correction to existing actors and spawns during live testing. */
public final class RepairPlateRotation {
    @Subscribe public void initialize(SessionInitializeEvent event) {
        if (event.connection() instanceof GeyserSession session) install(session);
    }
    static void install(GeyserSession session) {
        var channel = session.getUpstream().getSession().getPeer().getChannel();
        Runnable task = () -> {
            var pipeline = channel.pipeline();
            if (pipeline.get("copper-plate-rotation") != null) return;
            for (var entry : pipeline) {
                if (!(entry.getValue() instanceof BedrockPacketCodec)) continue;
                pipeline.addAfter(entry.getKey(), "copper-plate-rotation", new ChannelOutboundHandlerAdapter() {
                    @Override public void write(ChannelHandlerContext context, Object message, ChannelPromise promise) throws Exception {
                        if (message instanceof BedrockPacketWrapper wrapper && wrapper.getPacket() instanceof AddEntityPacket packet
                                && packet.getIdentifier().equals("copperbedrock:wall_plate")) {
                            float yaw = packet.getRotation().getY();
                            packet.setHeadRotation(yaw); packet.setBodyRotation(yaw);
                        }
                        super.write(context, message, promise);
                    }
                }); return;
            }
        };
        if (channel.eventLoop().inEventLoop()) task.run(); else channel.eventLoop().execute(task);
    }
    public static String activate() throws InterruptedException {
        var geyser = GeyserImpl.getInstance();
        geyser.eventBus().register(geyser.extensionManager().extension("copperbedrock"), new RepairPlateRotation());
        var count = new AtomicInteger();
        for (var session : geyser.getSessionManager().getAllSessions()) {
            install(session); var done = new CountDownLatch(1);
            session.executeInEventLoop(() -> {
                try {
                    for (var entity : session.getEntityCache().getEntitiesUnsafe().values()) {
                        if (!(entity instanceof ItemFrameEntity frame) || frame.getHeldItem() == null) continue;
                        if (!ItemTranslator.translateToBedrock(session, frame.getHeldItem()).getDefinition().getIdentifier().equals("copperbedrock:wall_plate")) continue;
                        float yaw = (frame.getYaw() + 360 + 180) % 360;
                        var normal = Vector3f.from(Math.round(Math.sin(Math.toRadians(yaw))), 0, Math.round(-Math.cos(Math.toRadians(yaw))));
                        var packet = new MoveEntityAbsolutePacket();
                        packet.setRuntimeEntityId(frame.geyserId());
                        packet.setPosition(frame.position().toInt().toFloat().add(.5f, .5f, .5f).sub(normal.mul(.46875f)));
                        packet.setRotation(Vector3f.from(0, yaw, yaw)); packet.setTeleported(true);
                        session.sendUpstreamPacket(packet); count.incrementAndGet();
                    }
                } finally { done.countDown(); }
            }); done.await(5, TimeUnit.SECONDS);
        }
        return "Realigned " + count + " Bedrock wall-plate actors; future plate spawns use matching head/body yaw.";
    }
}
