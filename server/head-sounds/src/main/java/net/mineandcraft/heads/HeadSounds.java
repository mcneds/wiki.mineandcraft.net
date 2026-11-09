package net.mineandcraft.heads;

import com.google.gson.JsonParser;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.players.NameAndId;
import net.minecraft.world.level.block.entity.SkullBlockEntity;
import org.slf4j.LoggerFactory;

public final class HeadSounds implements ModInitializer {
    private static final Identifier CATALOGUE = Identifier.fromNamespaceAndPath("mineandcraft_music", "head_sounds/catalog.json");
    private static final Identifier STORAGE = Identifier.fromNamespaceAndPath("mineandcraft_music", "heads");
    private static final Identifier DELIVERY = Identifier.fromNamespaceAndPath("mineandcraft_music", "delivery");
    private static HeadCatalogue catalogue = HeadCatalogue.empty();
    private static Set<String> lastAllowed;

    @Override public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(HeadSounds::reload);
        ServerLifecycleEvents.END_DATA_PACK_RELOAD.register((server, resources, success) -> { if (success) reload(server); });
        ServerLifecycleEvents.SERVER_STOPPED.register(server -> { catalogue = HeadCatalogue.empty(); lastAllowed = null; });
        ServerTickEvents.START_SERVER_TICK.register(HeadSounds::updateClaims);
    }
    private static void reload(MinecraftServer server) {
        // Fail closed; a malformed new pack must not retain an old association.
        catalogue = HeadCatalogue.empty(); lastAllowed = null;
        var delivery = server.getCommandStorage().get(DELIVERY).copy();
        delivery.remove("head_release"); server.getCommandStorage().set(DELIVERY, delivery);
        try {
            var resource = server.getResourceManager().getResource(CATALOGUE);
            if (resource.isPresent()) {
                try (var reader = resource.get().openAsReader()) {
                    catalogue = HeadCatalogue.parse(JsonParser.parseReader(reader).getAsJsonObject());
                }
                delivery.putString("head_release", catalogue.release());
                server.getCommandStorage().set(DELIVERY, delivery);
            }
        } catch (Exception error) {
            LoggerFactory.getLogger("mineandcraft-heads").error("Head sound catalogue failed to load", error);
        }
        updateClaims(server);
    }
    private static boolean whitelisted(MinecraftServer server, UUID id) {
        // Query the list itself, regardless of whether whitelist enforcement is enabled.
        return server.getPlayerList().getWhiteList().isWhiteListed(new NameAndId(id, ""));
    }
    private static void updateClaims(MinecraftServer server) {
        var allowed = new HashSet<String>();
        catalogue.heads().forEach((id, entry) -> {
            if (entry.allowed(whitelisted(server, id))) allowed.add(entry.sound().substring("mineandcraft_music:".length()));
        });
        if (allowed.equals(lastAllowed)) return;
        var root = new CompoundTag(); var flags = new CompoundTag();
        allowed.forEach(name -> flags.putBoolean(name, true));
        root.put("allowed", flags); server.getCommandStorage().set(STORAGE, root);
        lastAllowed = Set.copyOf(allowed);
    }
    /** null means no installed/authorized sound; caller only overrides managed heads. */
    public static Identifier sound(ServerLevel level, SkullBlockEntity skull) {
        var profile = skull.getOwnerProfile();
        if (profile == null) return null;
        String sound = catalogue.sound(profile.partialProfile().id(), id -> whitelisted(level.getServer(), id));
        return sound == null ? null : Identifier.parse(sound);
    }
    public static boolean managed(SkullBlockEntity skull) {
        var profile = skull.getOwnerProfile();
        return (profile != null && catalogue.heads().containsKey(profile.partialProfile().id()))
            || (skull.getNoteBlockSound() != null && skull.getNoteBlockSound().toString().startsWith("mineandcraft_music:head_"));
    }
}
