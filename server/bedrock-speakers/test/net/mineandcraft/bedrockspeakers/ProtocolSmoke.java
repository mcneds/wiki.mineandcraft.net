package net.mineandcraft.bedrockspeakers;

import io.netty.buffer.Unpooled;
import org.cloudburstmc.math.vector.Vector3f;
import org.cloudburstmc.math.vector.Vector3d;
import java.util.List;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.entity.ClientboundEntityPositionSyncPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.codec.v2225.Bedrock_v2225;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.StopSoundData;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.ClientboundUpdateSoundDataPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.PlaySoundPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.VoxelShapesPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.AddEntityPacket;
import org.geysermc.mcprotocollib.protocol.data.game.entity.object.Direction;

/** Exercises the exact installed Bedrock codec, including the observed crash. */
public final class ProtocolSmoke {
    public static void main(String[] args) {
        CoordinatedAudioTest.run();
        if (!CopperBedrock.bufferedSound("mineandcraft_music:buffered.disc_test").equals("mineandcraft_music:buffered.disc_test"))
            throw new AssertionError("Buffered custom audio was changed back to its streaming event");
        if (!CopperBedrock.bufferedSound("mineandcraft_music:disc_test").equals("mineandcraft_music:buffered.disc_test"))
            throw new AssertionError("Prepared custom audio must use the buffered event for parallel voices");
        var steps = List.of(new ClientboundEntityPositionSyncPacket.PositionStep(Vector3d.from(1, 4096, 3), 0),
                new ClientboundEntityPositionSyncPacket.PositionStep(Vector3d.from(20.5, 22.5, -17.5), 1));
        var stepped = new ClientboundEntityPositionSyncPacket(42, true, null, steps, 0, 0, false);
        if (!Vector3f.from(20.5, 22.5, -17.5).equals(CopperBedrock.finalPosition(stepped)))
            throw new AssertionError("Stepped anchor did not move to its last position");
        var direct = new ClientboundEntityPositionSyncPacket(42, false, Vector3d.from(3, 4, 5), null, 0, 0, false);
        if (!Vector3f.from(3, 4, 5).equals(CopperBedrock.finalPosition(direct)))
            throw new AssertionError("Direct sync position changed");
        var empty = new ClientboundEntityPositionSyncPacket(42, true, null, List.of(), 0, 0, false);
        if (CopperBedrock.finalPosition(empty) != null) throw new AssertionError("Empty steps should be ignored");
        var codec = Bedrock_v2225.CODEC;
        var helper = codec.createHelper();
        var buffer = Unpooled.buffer();
        try {
            for (var face : List.of(Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST)) {
                var plate = CopperFrameEntity.spawnPacket(Vector3f.from(240, 20, -23), 123, face);
                float yaw = plate.getRotation().getY();
                if (plate.getHeadRotation() != yaw || plate.getBodyRotation() != yaw)
                    throw new AssertionError("Plate orientation disagrees between yaw, head, and body for " + face);
                Vector3f normal = switch (face) {
                    case NORTH -> Vector3f.from(0, 0, -1); case SOUTH -> Vector3f.from(0, 0, 1);
                    case EAST -> Vector3f.from(1, 0, 0); default -> Vector3f.from(-1, 0, 0);
                };
                var front = Vector3f.from(Math.sin(Math.toRadians(yaw)), 0, -Math.cos(Math.toRadians(yaw)));
                if (front.distanceSquared(normal) > .000001) throw new AssertionError("Wrong plate face " + face);
                codec.tryEncode(helper, buffer, plate);
                var copy = (AddEntityPacket) codec.tryDecode(helper, buffer, codec.getPacketDefinition(AddEntityPacket.class).getId());
                if (!copy.getMetadata().getFlag(org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityFlag.SILENT))
                    throw new AssertionError("Visual wall plate can emit ambient sounds for " + face);
                for (var flag : org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityFlag.values())
                    if (plate.getMetadata().getFlag(flag) != copy.getMetadata().getFlag(flag))
                        throw new AssertionError("Plate flag lost during serialization: " + flag);
                // The decoder expands absent flag bits to false; compare their values above.
                for (var flags : List.of(
                        org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityDataTypes.FLAGS,
                        org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.entity.EntityDataTypes.FLAGS_2)) {
                    plate.getMetadata().remove(flags); copy.getMetadata().remove(flags);
                }
                if (!plate.equals(copy)) throw new AssertionError("Plate facing lost during serialization for " + face);
                buffer.clear();
            }
            var shapes = VoxelSupport.defaults();
            codec.tryEncode(helper, buffer, shapes);
            var shapeCopy = (VoxelShapesPacket) codec.tryDecode(helper, buffer,
                    codec.getPacketDefinition(VoxelShapesPacket.class).getId());
            if (!shapes.equals(shapeCopy)) throw new AssertionError("Voxel registry did not round-trip");
            if (!shapeCopy.getNameMap().keySet().containsAll(List.of("minecraft:empty", "minecraft:unit_cube")))
                throw new AssertionError("Missing vanilla voxel handles");
            if (VoxelSupport.repair(shapeCopy)) throw new AssertionError("An existing shape registry was overwritten");
            buffer.clear();
            var broken = new ClientboundUpdateSoundDataPacket();
            broken.setServerSoundHandle(0);
            boolean reproduced = false;
            try { codec.tryEncode(helper, buffer, broken); }
            catch (Exception expected) { reproduced = true; }
            if (!reproduced) throw new AssertionError("Expected the unpatched stop packet to fail");
            for (long handle : new long[]{0, 1, CopperBedrock.voiceHandle(Integer.MAX_VALUE), CopperBedrock.voiceHandle(-1)}) {
                buffer.clear();
                codec.tryEncode(helper, buffer, CopperBedrock.stopPacket(handle));
                var decoded = (ClientboundUpdateSoundDataPacket) codec.tryDecode(helper, buffer,
                        codec.getPacketDefinition(ClientboundUpdateSoundDataPacket.class).getId());
                if (decoded.getServerSoundHandle() != handle || !(decoded.getEvent() instanceof StopSoundData))
                    throw new AssertionError("Stop handle or stop event lost during serialization");
            }
            var start = new PlaySoundPacket();
            for (var event : List.of(
                    new org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.SeekToSoundData(65.25f),
                    new org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.SetVolumeSoundData(4f),
                    new org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.PauseSoundData(),
                    new org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.ResumeSoundData())) {
                var update = new ClientboundUpdateSoundDataPacket();
                update.setServerSoundHandle(CopperBedrock.voiceHandle(42)); update.setEvent(event);
                buffer.clear(); codec.tryEncode(helper, buffer, update);
                var copy = codec.tryDecode(helper, buffer, codec.getPacketDefinition(ClientboundUpdateSoundDataPacket.class).getId());
                if (!update.equals(copy)) throw new AssertionError("Warm-up sound update did not round-trip: " + event);
            }
            start.setSound("mineandcraft_music:disc_test");
            start.setPosition(Vector3f.from(190.5, 20.5, -19.5));
            start.setVolume(4);
            start.setPitch(1);
            start.setServerSoundHandle(CopperBedrock.voiceHandle(42));
            start.setBypassListenerRangeCheck(true);
            start.setPlaybackPositionSeconds(65.25f);
            buffer.clear();
            codec.tryEncode(helper, buffer, start);
            var decoded = (PlaySoundPacket) codec.tryDecode(helper, buffer,
                    codec.getPacketDefinition(PlaySoundPacket.class).getId());
            if (!start.equals(decoded)) throw new AssertionError("Playback offset/position/handle did not round-trip: " + decoded);
            var voice = new CopperBedrock.Voice(new CopperBedrock.Recording("record.cat", 15), 4, 1);
            float offset = voice.playbackPosition(voice.clock.created + 7_000_000_000L);
            if (Math.abs(offset - 22) > .001) throw new AssertionError("A moved speaker lost its current song position");
            System.out.println("PASS: reproduced old stop crash; fixed stop events, sound handles, playback offsets, and moved-voice timing verified");
        } finally { buffer.release(); }
    }
}
