package net.mineandcraft.mapart;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.util.UUID;
import javax.imageio.ImageIO;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.component.DataComponents;
import net.minecraft.gametest.framework.GameTestHelper;
import space.essem.image2map.Image2Map;
import space.essem.image2map.renderer.MapRenderer;

public class TransparencyTest {
    @GameTest
    public void transparencySurvivesConversionPreviewAndSavedMap(GameTestHelper test) throws Exception {
        var source = new BufferedImage(64, 128, BufferedImage.TYPE_INT_ARGB);
        for (int y = 32; y < 96; y++) for (int x = 16; x < 48; x++) source.setRGB(x, y, 0xffffffff);
        var encoded = new ByteArrayOutputStream(); ImageIO.write(source, "png", encoded);
        var store = new ArtStore(Files.createTempDirectory("mapart-alpha-test"));
        for (boolean dither : new boolean[]{false, true}) {
            var layout = new Layout(1, 1, "fit", "right", "top", dither);
            var image = layout.compose(encoded.toByteArray());
            var canvas = MapRenderer.render(image, dither ? Image2Map.DitherMode.FLOYD : Image2Map.DitherMode.NONE, 128, 128);
            byte[] pixels = new byte[128 * 128];
            for (int i = 0; i < pixels.length; i++) pixels[i] = canvas.getRawAt(i);
            test.assertValueEqual(pixels[0], (byte) 0, "Fit padding stays transparent, dither=" + dither);
            test.assertValueEqual(pixels[70 + 10 * 128], (byte) 0, "Source transparency survives, dither=" + dither);
            test.assertTrue(Byte.toUnsignedInt(pixels[96 + 64 * 128]) >= 4, "Opaque white remains visible");
            var preview = MapartBridge.previewImage(layout, pixels);
            var png = new ByteArrayOutputStream(); ImageIO.write(preview, "png", png);
            var decoded = ImageIO.read(new ByteArrayInputStream(png.toByteArray()));
            test.assertValueEqual(decoded.getRGB(70, 10) >>> 24, 0, "Uploaded PNG preserves transparency");
            test.assertValueEqual(decoded.getRGB(96, 64) >>> 24, 255, "Uploaded PNG retains opaque pixels");
            var world = test.getLevel().getServer().overworld();
            var item = store.item(world, UUID.randomUUID().toString(), "Transparent art", layout, pixels, BridgeClient.checksum(pixels));
            var saved = world.getMapData(item.get(DataComponents.MAP_ID));
            test.assertValueEqual(saved.colors[70 + 10 * 128], (byte) 0, "Issued map preserves transparent pixels");
            test.assertValueEqual(saved.colors[96 + 64 * 128], pixels[96 + 64 * 128], "Issued map retains opaque colors");
            image.flush(); preview.flush(); decoded.flush();
        }
        test.succeed();
    }
}
