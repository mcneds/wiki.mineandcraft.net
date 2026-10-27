package net.mineandcraft.mapart;

import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** Same integer geometry as shared/mapart.mjs. Alignment is applied before tiling. */
public record Layout(int columns, int rows, String fit, String horizontalAlignment, String verticalAlignment, boolean dither) {
    public static final int MAX_TILES = 256;
    public static final int MAX_SIDE = 64;
    public static final int MAX_PIXEL_BYTES = MAX_TILES * 128 * 128;
    public static boolean validSize(int columns, int rows) {
        return columns >= 1 && columns <= MAX_SIDE && rows >= 1 && rows <= MAX_SIDE && (long) columns * rows <= MAX_TILES;
    }
    public Layout {
        if (!validSize(columns, rows) || !java.util.Set.of("fit", "crop").contains(fit)
                || !java.util.Set.of("left", "center", "right").contains(horizontalAlignment)
                || !java.util.Set.of("top", "center", "bottom").contains(verticalAlignment)) throw new IllegalArgumentException("Invalid mapart layout");
    }
    public int width() { return columns * 128; }
    public int height() { return rows * 128; }
    public int tiles() { return columns * rows; }
    public record Geometry(long width, long height, long x, long y) {}
    public Geometry geometry(int width, int height) {
        double scale = fit.equals("fit") ? Math.min(width() / (double) width, height() / (double) height) : Math.max(width() / (double) width, height() / (double) height);
        long resizedWidth = Math.max(1, Math.round(width * scale)), resizedHeight = Math.max(1, Math.round(height * scale));
        return new Geometry(resizedWidth, resizedHeight, (long) Math.floor((width() - resizedWidth) * factor(horizontalAlignment)), (long) Math.floor((height() - resizedHeight) * factor(verticalAlignment)));
    }
    private static double factor(String value) { return switch (value) { case "left", "top" -> 0; case "right", "bottom" -> 1; default -> .5; }; }
    public BufferedImage compose(byte[] bytes) throws IOException {
        if (bytes.length == 0 || bytes.length > 5 * 1024 * 1024) throw new IOException("Image file exceeds the limit");
        try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) throw new IOException("Unsupported image");
            var reader = readers.next();
            try {
                reader.setInput(stream, true, true);
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (width < 1 || height < 1 || (long) width * height > 16L * 1024 * 1024) throw new IOException("Image exceeds 16 megapixels");
                var image = reader.read(0); // Animated sources intentionally use frame zero.
                var result = new BufferedImage(width(), height(), BufferedImage.TYPE_INT_ARGB);
                var graphics = result.createGraphics();
                try {
                    graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                    var geometry = geometry(width, height);
                    var transform = java.awt.geom.AffineTransform.getTranslateInstance(geometry.x, geometry.y);
                    transform.scale(geometry.width / (double) width, geometry.height / (double) height);
                    graphics.drawImage(image, transform, null);
                } finally { graphics.dispose(); image.flush(); }
                return result;
            } finally { reader.dispose(); }
        }
    }
}
