package net.mineandcraft.heads.geyser;

import org.cloudburstmc.math.vector.Vector3f;
import org.geysermc.event.subscribe.Subscribe;
import org.geysermc.geyser.api.event.lifecycle.GeyserPostInitializeEvent;
import org.geysermc.geyser.api.extension.Extension;
import org.geysermc.geyser.registry.Registries;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.translator.protocol.PacketTranslator;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.PlaySoundPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.level.ClientboundSoundPacket;

/** Adds head effects alongside the installed Copper Speakers extension. */
public final class HeadSounds implements Extension {
    private boolean installed;

    @Subscribe
    @SuppressWarnings("unchecked")
    public void initialize(GeyserPostInitializeEvent event) {
        if (installed) return;
        var delegate = (PacketTranslator<ClientboundSoundPacket>)
                Registries.JAVA_PACKET_TRANSLATORS.get(ClientboundSoundPacket.class);
        Registries.JAVA_PACKET_TRANSLATORS.register(ClientboundSoundPacket.class, wrap(delegate));
        installed = true;
        logger().info("Player-head sound translation enabled.");
    }

    static PacketTranslator<ClientboundSoundPacket> wrap(PacketTranslator<ClientboundSoundPacket> delegate) {
        return new PacketTranslator<>() {
            @Override public void translate(GeyserSession session, ClientboundSoundPacket packet) {
                var sound = translateSound(packet);
                if (sound != null) session.sendUpstreamPacket(sound);
                else if (delegate != null) delegate.translate(session, packet);
            }
        };
    }

    static PlaySoundPacket translateSound(ClientboundSoundPacket packet) {
        String name = packet.getSound().getName();
        if (name == null || !name.matches("mineandcraft_music:head_[a-f0-9]{32}")) return null;
        var sound = new PlaySoundPacket();
        sound.setSound(name);
        sound.setPosition(Vector3f.from(packet.getX(), packet.getY(), packet.getZ()));
        sound.setVolume(packet.getVolume());
        sound.setPitch(packet.getPitch());
        return sound;
    }
}
