package net.mineandcraft.mapart;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LayoutTest {
    @Test void fitsAllNineAnchorsAndCropsAcrossWholeGrid() {
        for (String horizontal : new String[]{"left", "center", "right"}) for (String vertical : new String[]{"top", "center", "bottom"}) {
            var fit = new Layout(2, 3, "fit", horizontal, vertical, true);
            var landscape = fit.geometry(600, 100);
            assertEquals(256, landscape.width()); assertEquals(43, landscape.height());
            assertEquals(switch (vertical) { case "top" -> 0; case "bottom" -> 341; default -> 170; }, landscape.y());
            var portrait = fit.geometry(100, 600);
            assertEquals(64, portrait.width()); assertEquals(384, portrait.height());
            assertEquals(switch (horizontal) { case "left" -> 0; case "right" -> 192; default -> 96; }, portrait.x());
            var crop = new Layout(2, 3, "crop", horizontal, vertical, false).geometry(600, 100);
            assertEquals(2304, crop.width()); assertEquals(384, crop.height());
            assertEquals(switch (horizontal) { case "left" -> 0; case "right" -> -2048; default -> -1024; }, crop.x());
        }
    }
    @Test void roundsNegativeCenteredOffsetsDownAndLeavesMatchingAxisUnchanged() {
        var layout = new Layout(1, 1, "crop", "center", "center", true);
        assertEquals(-1, layout.geometry(129, 128).x());
        assertEquals(new Layout.Geometry(128,128,0,0), layout.geometry(256,256));
    }
    @Test void composesTransparentPaddingAndKeepsTheAlignedImage() throws Exception {
        var source = new BufferedImage(10, 20, BufferedImage.TYPE_INT_RGB);
        var paint = source.createGraphics(); paint.setColor(Color.RED); paint.fillRect(0,0,10,20); paint.dispose();
        var bytes = new ByteArrayOutputStream(); ImageIO.write(source,"png",bytes);
        var image = new Layout(1,1,"fit","right","top",true).compose(bytes.toByteArray());
        assertEquals(0,image.getRGB(0,0)); assertEquals(Color.RED.getRGB(),image.getRGB(127,0));
        assertEquals(128,image.getWidth()); assertEquals(128,image.getHeight());
    }
    @Test void preservesSourceAlphaAndOpaqueWhite() throws Exception {
        var source = new BufferedImage(128, 128, BufferedImage.TYPE_INT_ARGB);
        source.setRGB(64, 64, 0x80ff0000);
        source.setRGB(65, 64, Color.WHITE.getRGB());
        var bytes = new ByteArrayOutputStream(); ImageIO.write(source, "png", bytes);
        var image = new Layout(1,1,"fit","center","center",false).compose(bytes.toByteArray());
        assertEquals(0, image.getRGB(0,0));
        assertEquals(0x80ff0000, image.getRGB(64,64));
        assertEquals(Color.WHITE.getRGB(), image.getRGB(65,64));
    }
    @Test void rejectsInvalidLayoutsAndMalformedSources() {
        assertThrows(IllegalArgumentException.class, () -> new Layout(65,1,"fit","left","top",true));
        assertThrows(IllegalArgumentException.class, () -> new Layout(17,16,"fit","left","top",true));
        for (int[] size : new int[][]{{16,16},{32,8},{64,4},{4,64},{9,9}}) {
            assertEquals(size[0]*size[1], new Layout(size[0],size[1],"fit","left","top",true).tiles());
        }
        assertThrows(IllegalArgumentException.class, () -> new Layout(1,1,"fit","near","top",true));
        assertThrows(java.io.IOException.class, () -> new Layout(1,1,"fit","left","top",true).compose(new byte[]{1,2,3}));
    }
    @Test void extremeAspectRatiosDoNotOverflowIntegerCoordinates() {
        var geometry = new Layout(8,8,"crop","right","bottom",true).geometry(16*1024*1024,1);
        assertEquals(17179869184L,geometry.width()); assertEquals(1024,geometry.height());
        assertEquals(1024-17179869184L,geometry.x());
    }
}
