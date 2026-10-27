package net.mineandcraft.mapart;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import eu.pb4.mapcanvas.api.core.CanvasImage;
import net.minecraft.core.component.DataComponents;
import net.minecraft.nbt.NbtOps;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ItemStackTemplate;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.item.component.ItemLore;
import net.minecraft.world.level.saveddata.maps.MapId;
import space.essem.image2map.Image2Map;
import space.essem.image2map.ImageData;
import space.essem.image2map.renderer.MapRenderer;

/** Owned by the Minecraft thread. Back up this directory together with the world. */
final class ArtStore {
    private final Path directory;
    private final MapRegistry registry;
    ArtStore(Path directory) throws Exception {
        this.directory = directory; Files.createDirectories(directory);
        registry = new MapRegistry(directory);
    }
    Path pixelsPath(String id) {
        if (!id.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("Invalid artwork ID");
        return directory.resolve(id + ".pixels");
    }
    static void atomicWrite(Path target, byte[] bytes) throws Exception {
        Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
        try (var channel = FileChannel.open(temporary, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
            var buffer = ByteBuffer.wrap(bytes); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
        }
        Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
    ItemStack item(ServerLevel world, String id, String title, Layout layout, byte[] pixels, String sha256) throws Exception {
        if (pixels.length != layout.width() * layout.height() || !BridgeClient.checksum(pixels).equals(sha256)) throw new IllegalStateException("Artwork checksum mismatch");
        var entry = registry.obtain(id, sha256, layout.tiles(), () -> {
            var canvas = new CanvasImage(layout.width(), layout.height());
            for (int i = 0; i < pixels.length; i++) canvas.setRawAt(i, pixels[i]);
            var templates = MapRenderer.toVanillaItems(canvas, world, title);
            int[] ids = new int[templates.size()];
            for (int i = 0; i < ids.length; i++) {
                var map = templates.get(i).get(DataComponents.MAP_ID); ids[i] = map.id();
                var state = world.getMapData(map).locked(); state.setDirty(); world.setMapData(map, state);
            }
            // Save the maps and ID allocator before publishing their durable registry.
            world.getServer().getDataStorage().saveAndJoin();
            return ids;
        });
        var templates = new ArrayList<ItemStackTemplate>();
        for (int i = 0; i < entry.maps().length; i++) {
            var mapId = new MapId(entry.maps()[i]);
            var state = world.getMapData(mapId);
            if (state == null || state.colors.length != 16384) throw new IllegalStateException("Map data is missing; restore the world backup");
            for (int y = 0; y < 128; y++) for (int x = 0; x < 128; x++) {
                if (state.colors[y * 128 + x] != pixels[(i / layout.columns() * 128 + y) * layout.width() + i % layout.columns() * 128 + x]) throw new IllegalStateException("Map data and registry backup do not match");
            }
            var stack = new ItemStack(Items.FILLED_MAP);
            stack.set(DataComponents.MAP_ID, mapId);
            stack.set(DataComponents.ITEM_NAME, Component.literal(title));
            stack.set(DataComponents.LORE, new ItemLore(List.of(Component.literal("Tile " + (i % layout.columns() + 1) + ", " + (i / layout.columns() + 1)))));
            var data = ImageData.CODEC.codec().encodeStart(NbtOps.INSTANCE, ImageData.ofSimple(i % layout.columns(), i / layout.columns(), layout.columns(), layout.rows())).getOrThrow().asCompound().orElseThrow();
            data.putString("mineandcraft:mapart", id);
            stack.set(DataComponents.CUSTOM_DATA, CustomData.of(data));
            templates.add(ItemStackTemplate.fromNonEmptyStack(stack));
        }
        var item = Image2Map.toSingleStack(templates, title, layout.width(), layout.height()).create();
        var tag = item.getOrDefault(DataComponents.CUSTOM_DATA, CustomData.EMPTY).copyTag(); tag.putString("mineandcraft:mapart", id);
        item.set(DataComponents.CUSTOM_DATA, CustomData.of(tag));
        item.set(DataComponents.ITEM_NAME, Component.literal(title));
        return item;
    }
}
