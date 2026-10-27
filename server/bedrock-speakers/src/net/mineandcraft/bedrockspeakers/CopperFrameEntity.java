package net.mineandcraft.bedrockspeakers;

import org.cloudburstmc.math.vector.Vector2f;
import org.cloudburstmc.math.vector.Vector3f;
import org.geysermc.geyser.entity.spawn.EntitySpawnContext;
import org.geysermc.geyser.entity.type.ItemFrameEntity;
import org.geysermc.geyser.translator.item.ItemTranslator;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.AddEntityPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.RemoveEntityPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.UpdateBlockPacket;
import org.geysermc.mcprotocollib.protocol.data.game.entity.metadata.EntityMetadata;
import org.geysermc.mcprotocollib.protocol.data.game.entity.object.Direction;
import org.geysermc.mcprotocollib.protocol.data.game.item.ItemStack;

/** Preserve normal frame/map behavior; render only the mod's plate as a mesh. */
public final class CopperFrameEntity extends ItemFrameEntity {
    private Direction facing = Direction.SOUTH;
    private boolean plate, spawned;

    public CopperFrameEntity(EntitySpawnContext context) { super(context); }

    @Override public void setDirection(Direction direction) {
        facing = direction;
        super.setDirection(direction);
    }

    @Override public void setItemInFrame(EntityMetadata<ItemStack, ?> metadata) {
        ItemStack stack = metadata.getValue();
        boolean next = stack != null && ItemTranslator.translateToBedrock(session, stack)
                .getDefinition().getIdentifier().equals("copperbedrock:wall_plate");
        if (plate && !next) removePlate();
        plate = next;
        super.setItemInFrame(metadata);
    }

    @Override public void updateBlock(boolean force) {
        if (!plate) { super.updateBlock(force); return; }
        if (spawned) return;
        var clear = new UpdateBlockPacket();
        clear.setDataLayer(0);
        clear.setBlockPosition(position.toInt());
        clear.setDefinition(session.getBlockMappings().getBedrockAir());
        clear.getFlags().add(UpdateBlockPacket.Flag.NETWORK);
        session.sendUpstreamPacket(clear);
        session.sendUpstreamPacket(spawnPacket(position, geyserId, facing));
        spawned = true;
    }

    static AddEntityPacket spawnPacket(Vector3f position, long runtimeId, Direction facing) {
        Vector3f normal = switch (facing) {
            case NORTH -> Vector3f.from(0, 0, -1);
            case SOUTH -> Vector3f.from(0, 0, 1);
            case WEST -> Vector3f.from(-1, 0, 0);
            case EAST -> Vector3f.from(1, 0, 0);
            default -> Vector3f.ZERO;
        };
        // Bedrock's actor renderer contributes its own Y half-turn.
        float yaw = switch (facing) { case NORTH -> 0; case EAST -> 90; case WEST -> 270; default -> 180; };
        var actor = new AddEntityPacket();
        actor.setIdentifier("copperbedrock:wall_plate");
        actor.setUniqueEntityId(runtimeId);
        actor.setRuntimeEntityId(runtimeId);
        actor.setPosition(position.toInt().toFloat().add(.5f, .5f, .5f).sub(normal.mul(.46875f)));
        actor.setMotion(Vector3f.ZERO);
        actor.setRotation(Vector2f.from(0, yaw));
        actor.setHeadRotation(yaw);
        actor.setBodyRotation(yaw);
        // This manually spawned visual actor must not emit client-side ambient sounds.
        actor.getMetadata().setFlag(org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityFlag.SILENT, true);
        actor.getMetadata().put(org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityDataTypes.SCALE, 1f);
        actor.getMetadata().put(org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityDataTypes.WIDTH, .5f);
        actor.getMetadata().put(org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityDataTypes.HEIGHT, .625f);
        return actor;
    }

    private void removePlate() {
        if (!spawned) return;
        var packet = new RemoveEntityPacket();
        packet.setUniqueEntityId(geyserId);
        session.sendUpstreamPacket(packet);
        spawned = false;
    }

    @Override public void despawnEntity() { removePlate(); super.despawnEntity(); }
}
