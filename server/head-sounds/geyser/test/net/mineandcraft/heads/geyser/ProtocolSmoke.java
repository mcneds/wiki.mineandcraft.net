package net.mineandcraft.heads.geyser;

import io.netty.buffer.Unpooled;
import org.cloudburstmc.math.vector.Vector3f;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.translator.protocol.PacketTranslator;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.codec.v2225.Bedrock_v2225;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.PlaySoundPacket;
import org.geysermc.mcprotocollib.protocol.data.game.level.sound.CustomSound;
import org.geysermc.mcprotocollib.protocol.data.game.level.sound.SoundCategory;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.level.ClientboundSoundPacket;

public final class ProtocolSmoke {
    public static void main(String[] args) {
        String name = "mineandcraft_music:head_11111111111141118111111111111111";
        var packet = new ClientboundSoundPacket(new CustomSound(name, false, 48),
                SoundCategory.RECORD, 1.5, 64.5, -12.5, 3, .75f, 0);
        var sound = HeadSounds.translateSound(packet);
        if (sound == null || !name.equals(sound.getSound())
                || !Vector3f.from(1.5, 64.5, -12.5).equals(sound.getPosition())
                || sound.getVolume() != 3 || sound.getPitch() != .75f)
            throw new AssertionError("Head effect identity, origin, volume or pitch changed");
        var codec = Bedrock_v2225.CODEC;
        var helper = codec.createHelper();
        var buffer = Unpooled.buffer();
        try {
            codec.tryEncode(helper, buffer, sound);
            var copy = (PlaySoundPacket) codec.tryDecode(helper, buffer,
                    codec.getPacketDefinition(PlaySoundPacket.class).getId());
            if (!sound.equals(copy)) throw new AssertionError("Head sound failed Bedrock codec round trip");
        } finally { buffer.release(); }
        int[] delegated = {0};
        var wrapper = HeadSounds.wrap(new PacketTranslator<ClientboundSoundPacket>() {
            @Override public void translate(GeyserSession session, ClientboundSoundPacket value) { delegated[0]++; }
        });
        for (String other : new String[] {"minecraft:block.note_block.harp", "mineandcraft_music:disc_123",
                "mineandcraft_music:head_invalid", "copper_speakers:prepared.example"}) {
            var unrelated = packet.withSound(new CustomSound(other, false, 48));
            if (HeadSounds.translateSound(unrelated) != null) throw new AssertionError("Unrelated sound intercepted");
            wrapper.translate(null, unrelated);
        }
        if (delegated[0] != 4) throw new AssertionError("Existing translator was bypassed");
        System.out.println("Head sound codec and translator delegation checks passed.");
    }
}
