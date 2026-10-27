package net.mineandcraft.bedrockspeakers;

import java.io.IOException;
import java.util.Map;
import java.util.Properties;
import java.nio.file.Path;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.concurrent.TimeUnit;
import org.cloudburstmc.math.vector.Vector3f;
import org.cloudburstmc.math.vector.Vector3i;
import org.geysermc.event.subscribe.Subscribe;
import org.geysermc.geyser.api.event.bedrock.SessionDisconnectEvent;
import org.geysermc.geyser.api.event.bedrock.SessionInitializeEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserPostInitializeEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserShutdownEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserDefineCommandsEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserDefineEntitiesEvent;
import org.geysermc.geyser.api.entity.custom.CustomEntityDefinition;
import org.geysermc.geyser.api.util.Identifier;
import org.geysermc.geyser.entity.GeyserEntityType;
import org.geysermc.geyser.entity.VanillaEntityType;
import org.geysermc.geyser.entity.type.ItemFrameEntity;
import org.geysermc.mcprotocollib.protocol.data.game.entity.type.EntityType;
import org.geysermc.geyser.api.command.Command;
import org.geysermc.geyser.api.command.CommandSource;
import org.geysermc.geyser.api.extension.Extension;
import org.geysermc.geyser.registry.Registries;
import org.geysermc.geyser.registry.java.JavaRegistries;
import org.geysermc.geyser.session.GeyserSession;
import org.geysermc.geyser.translator.protocol.PacketTranslator;
import org.geysermc.geyser.util.SoundUtils;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.StopSoundData;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.ClientboundUpdateSoundDataPacket;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.PlaySoundPacket;
import org.geysermc.mcprotocollib.network.packet.Packet;
import org.geysermc.mcprotocollib.protocol.data.game.level.event.LevelEventType;
import org.geysermc.mcprotocollib.protocol.data.game.level.event.RecordEventData;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.entity.ClientboundAddEntityPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.entity.ClientboundEntityPositionSyncPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.entity.ClientboundRemoveEntitiesPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.ClientboundSoundEntityPacket;
import org.geysermc.mcprotocollib.protocol.packet.ingame.clientbound.level.ClientboundLevelEventPacket;

/** Compatibility for Copper Speakers 0.2.0 on Geyser 2.12.1-b1273 / Bedrock 26.60. */
public final class CopperBedrock implements Extension {
    private final Map<String, Recording> recordings = new ConcurrentHashMap<>();
    private final Map<GeyserSession, Listener> listeners = new ConcurrentHashMap<>();
    private boolean installed;
    private PreparedEventCatalog liveRecordings;
    private static final int BEDROCK_26_60 = 2225;

    record Recording(String sound, float offset) {}
    @Subscribe
    public void initializeSession(SessionInitializeEvent event) {
        if (event.connection() instanceof GeyserSession session) VoxelSupport.install(session);
    }
    @Subscribe
    public void entities(GeyserDefineEntitiesEvent event) {
        event.register(CustomEntityDefinition.of(Identifier.of("copperbedrock:wall_plate")));
    }
    static final class Voice {
        final Recording recording;
        final CoordinatedAudio.Clock clock;
        final float volume, pitch;
        boolean playing;
        Voice(Recording recording, float volume, float pitch) {
            this.recording = recording;
            this.volume = volume;
            this.pitch = pitch;
            this.clock = new CoordinatedAudio.Clock(recording.offset(), pitch, System.nanoTime());
        }
        float playbackPosition(long now) {
            return clock.position(now);
        }
    }
    static final class Listener {
        final Map<Integer, Vector3f> positions = new ConcurrentHashMap<>();
        final Map<Integer, Voice> voices = new ConcurrentHashMap<>();
        final Map<Vector3i, Recording> records = new ConcurrentHashMap<>();
        final CoordinatedAudio audio;
        Listener(GeyserSession session) {
            audio = new CoordinatedAudio(System::nanoTime,
                    (delay, action) -> session.scheduleInEventLoop(action, delay, TimeUnit.MILLISECONDS),
                    new CoordinatedAudio.Output() {
                        @Override public void prepare(CoordinatedAudio.Entry entry, float offset) {
                            play(session, entry.sound, entry.position, 0, entry.pitch, entry.handle, offset);
                        }
                        @Override public void update(long handle, org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.SoundData event) {
                            var packet = new ClientboundUpdateSoundDataPacket();
                            packet.setServerSoundHandle(handle); packet.setEvent(event); session.sendUpstreamPacket(packet);
                        }
                    });
        }
    }

    @Subscribe
    public void initialize(GeyserPostInitializeEvent event) throws IOException {
        if (installed) return;
        Properties properties = new Properties();
        try (var input = getClass().getResourceAsStream("/audio-events.properties")) {
            if (input == null) throw new IOException("Missing prepared-audio event catalogue");
            properties.load(input);
        }
        for (String key : properties.stringPropertyNames()) {
            String[] value = properties.getProperty(key).split("\\|", -1);
            float offset = Float.parseFloat(value[1]);
            if (!Float.isFinite(offset) || offset < 0) throw new IOException("Invalid playback offset");
            recordings.put(key, new Recording(bufferedSound(value[0]), offset));
        }
        liveRecordings = new PreparedEventCatalog(Path.of(System.getProperty("copperbedrock.preparedEvents",
                "config/copper-speakers/joining/events.json")), message -> logger().warning(message));
        liveRecordings.start();
        replace(ClientboundAddEntityPacket.class, this::addEntity);
        wrap(ClientboundEntityPositionSyncPacket.class, this::moveEntity, false);
        wrap(ClientboundRemoveEntitiesPacket.class, this::removeEntities, true);
        replace(ClientboundSoundEntityPacket.class, this::soundEntity);
        replace(ClientboundLevelEventPacket.class, this::levelEvent);
        var key = GeyserEntityType.ofVanilla(EntityType.ITEM_FRAME);
        @SuppressWarnings("unchecked")
        var frame = (VanillaEntityType<ItemFrameEntity>) Registries.JAVA_ENTITY_TYPES.get(key);
        Registries.JAVA_ENTITY_TYPES.register(key, new VanillaEntityType<ItemFrameEntity>(
                CopperFrameEntity::new, key, frame.height(), frame.width(), frame.offset(),
                frame.defaultBedrockDefinition(), frame.translators()));
        installed = true;
        logger().info("Copper Speakers Bedrock audio enabled with " + recordings.size() + " prepared events");
    }

    @Subscribe
    public void disconnected(SessionDisconnectEvent event) {
        if (event.connection() instanceof GeyserSession session) {
            Listener listener = listeners.remove(session);
            if (listener != null) listener.audio.close();
        }
    }

    @Subscribe public void shutdown(GeyserShutdownEvent event) {
        if (liveRecordings != null) liveRecordings.close();
    }

    @Subscribe
    public void commands(GeyserDefineCommandsEvent event) {
        event.register(Command.builder(this).name("voices").source(CommandSource.class)
                .playerOnly(false).permission("copperbedrock.voices")
                .description("Show translated Copper Speakers audio anchors")
                .executor((source, command, args) -> {
                    source.sendMessage("Bedrock audio listeners: " + listeners.size());
                    listeners.forEach((session, listener) -> {
                        source.sendMessage(session.bedrockUsername() + ": " + listener.voices.size() + " entity voices");
                        listener.records.forEach((position, recording) -> source.sendMessage("  record " + position + " " + recording.sound()));
                        listener.voices.forEach((id, voice) -> source.sendMessage("  " + id + " " +
                                listener.audio.phase(voiceHandle(id)) + " " + listener.positions.get(id) +
                                " " + voice.recording.sound() + " handle=" + voiceHandle(id)));
                    });
                }).build());
    }

    private boolean supported(GeyserSession session) {
        return session.protocolVersion() == BEDROCK_26_60;
    }

    @SuppressWarnings("unchecked")
    private <P extends Packet> void wrap(Class<P> type, BiConsumer<GeyserSession, P> handler, boolean before) {
        PacketTranslator<P> delegate = (PacketTranslator<P>) Registries.JAVA_PACKET_TRANSLATORS.get(type);
        Registries.JAVA_PACKET_TRANSLATORS.register(type, new PacketTranslator<P>() {
            @Override public void translate(GeyserSession session, P packet) {
                if (supported(session) && before) handler.accept(session, packet);
                if (delegate != null) delegate.translate(session, packet);
                if (supported(session) && !before) handler.accept(session, packet);
            }
        });
    }

    @FunctionalInterface
    interface Interceptor<P> { boolean handle(GeyserSession session, P packet); }

    @SuppressWarnings("unchecked")
    private <P extends Packet> void replace(Class<P> type, Interceptor<P> handler) {
        PacketTranslator<P> delegate = (PacketTranslator<P>) Registries.JAVA_PACKET_TRANSLATORS.get(type);
        Registries.JAVA_PACKET_TRANSLATORS.register(type, new PacketTranslator<P>() {
            @Override public void translate(GeyserSession session, P packet) {
                if ((!supported(session) || !handler.handle(session, packet)) && delegate != null)
                    delegate.translate(session, packet);
            }
        });
    }

    private Listener listener(GeyserSession session) {
        return listeners.computeIfAbsent(session, Listener::new);
    }

    private boolean addEntity(GeyserSession session, ClientboundAddEntityPacket packet) {
        listener(session).positions.put(packet.getEntityId(), Vector3f.from(packet.getX(), packet.getY(), packet.getZ()));
        // Polymer's audio anchors use Java MARKER entities. Geyser b1273 has
        // no factory for them; retain their positions without trying to spawn
        // a Bedrock entity. Other entities still use Geyser's translator.
        return packet.getType().name().equals("MARKER");
    }

    private void moveEntity(GeyserSession session, ClientboundEntityPositionSyncPacket packet) {
        Listener listener = listener(session);
        Vector3f position = finalPosition(packet);
        if (position == null) return;
        Vector3f previous = listener.positions.put(packet.getId(), position);
        if (position.equals(previous)) return;
        Voice voice = listener.voices.get(packet.getId());
        if (voice == null) return;
        voice.playing = audibleAnchor(session, position);
        listener.audio.start(voiceHandle(packet.getId()), voice.recording.sound(), position, voice.volume, voice.pitch,
                voice.clock, voice.playing);
    }

    // In 26.3 a stepped sync omits endPosition entirely. The final step is the
    // new anchor position, including a spare voice moving down to a speaker.
    static Vector3f finalPosition(ClientboundEntityPositionSyncPacket packet) {
        if (packet.isStepped()) {
            var steps = packet.getSteps();
            return steps == null || steps.isEmpty() ? null : steps.getLast().position().toFloat();
        }
        return packet.getEndPosition() == null ? null : packet.getEndPosition().toFloat();
    }

    private void removeEntities(GeyserSession session, ClientboundRemoveEntitiesPacket packet) {
        Listener listener = listeners.get(session);
        if (listener == null) return;
        for (int id : packet.getEntityIds()) {
            listener.positions.remove(id);
            Voice voice = listener.voices.remove(id);
            if (voice != null) listener.audio.stop(voiceHandle(id));
        }
    }

    static String bufferedSound(String name) {
        if (name.startsWith("mineandcraft_music:"))
            return name.startsWith("mineandcraft_music:buffered.") ? name : name.replace(":", ":buffered.");
        String mapped = SoundUtils.translatePlaySound(name);
        return mapped.startsWith("record.") ? "copperbedrock:buffered." + mapped : mapped;
    }

    private Recording recording(String name) {
        var decoded = PreparedEventCatalog.decode(name);
        if (decoded != null) return new Recording(bufferedSound(decoded.sound()), decoded.offsetSeconds());
        var live = liveRecordings == null ? null : liveRecordings.find(name);
        if (live != null) return new Recording(bufferedSound(live.sound()), live.offsetSeconds());
        Recording recording = recordings.get(name);
        if (recording != null) return recording;
        if (name.startsWith("mineandcraft_music:"))
            return new Recording(bufferedSound(name), 0);
        if (name.startsWith("copper_speakers:buffered."))
            return new Recording(bufferedSound("minecraft:music_disc." +
                    name.substring("copper_speakers:buffered.".length())), 0);
        return null;
    }

    private boolean soundEntity(GeyserSession session, ClientboundSoundEntityPacket packet) {
        Recording recording = recording(packet.getSound().getName());
        if (recording == null) return false;
        Listener listener = listener(session);
        Vector3f position = listener.positions.get(packet.getEntityId());
        if (position == null) return false;
        Voice old = listener.voices.remove(packet.getEntityId());
        if (old != null) listener.audio.stop(voiceHandle(packet.getEntityId()));
        Voice voice = new Voice(recording, packet.getVolume(), packet.getPitch());
        listener.voices.put(packet.getEntityId(), voice);
        voice.playing = audibleAnchor(session, position);
        listener.audio.start(voiceHandle(packet.getEntityId()), recording.sound(), position,
                packet.getVolume(), packet.getPitch(), voice.clock, voice.playing);
        return true;
    }

    private boolean levelEvent(GeyserSession session, ClientboundLevelEventPacket packet) {
        if (packet.getEvent() == LevelEventType.SOUND_STOP_JUKEBOX_SONG) {
            listener(session).records.remove(packet.getPosition());
            Long handle = session.getWorldCache().removePlayingRecord(packet.getPosition());
            if (handle != null && !listener(session).audio.stop(handle)) stop(session, handle);
            return true;
        }
        if (packet.getEvent() != LevelEventType.SOUND_PLAY_JUKEBOX_SONG) return false;
        var song = JavaRegistries.JUKEBOX_SONG.get(session.javaRegistries(), ((RecordEventData) packet.getData()).getRecordId());
        if (song.isEmpty()) return false;
        Recording recording = recording(song.get().soundEvent());
        if (recording == null) return false;
        Listener listener = listener(session);
        Long previous = session.getWorldCache().removePlayingRecord(packet.getPosition());
        if (previous != null && !listener.audio.stop(previous)) stop(session, previous);
        long handle = session.getWorldCache().addPlayingRecord(packet.getPosition());
        listener.records.put(packet.getPosition(), recording);
        var origin = packet.getPosition();
        listener.audio.start(handle, recording.sound(), Vector3f.from(origin.getX() + .5, origin.getY() + .5, origin.getZ() + .5),
                4, 1, new CoordinatedAudio.Clock(recording.offset(), 1, System.nanoTime()), true);
        return true;
    }

    // Parked anchors retain the audible cohort's clock without occupying a decoder.
    static boolean audibleAnchor(GeyserSession session, Vector3f position) {
        return Math.abs(position.getY() - session.getPlayerEntity().position().getY()) < 2048;
    }

    static long voiceHandle(int entityId) { return 0x4000000000000000L | Integer.toUnsignedLong(entityId); }

    static ClientboundUpdateSoundDataPacket stopPacket(long handle) {
        var packet = new ClientboundUpdateSoundDataPacket();
        packet.setServerSoundHandle(handle);
        packet.setEvent(new StopSoundData());
        return packet;
    }

    private static void stop(GeyserSession session, long handle) {
        session.sendUpstreamPacket(stopPacket(handle));
    }

    private static void play(GeyserSession session, String sound, Vector3f position, float volume,
                             float pitch, long handle, float offset) {
        var packet = new PlaySoundPacket();
        packet.setSound(sound);
        packet.setPosition(position);
        packet.setVolume(volume);
        packet.setPitch(pitch);
        packet.setServerSoundHandle(handle);
        packet.setBypassListenerRangeCheck(true);
        packet.setPlaybackPositionSeconds(offset);
        session.sendUpstreamPacket(packet);
    }
}
