package net.mineandcraft.plantools.schematic;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

/** UUID ownership is independent of player names, project guests and operator permissions. */
public final class PersonalSchematics {
    private final Path root;

    public PersonalSchematics(Path schematicRoot) throws IOException {
        Files.createDirectories(schematicRoot);
        root = schematicRoot.toRealPath().resolve(".players");
        rejectLinks(root);
    }

    public Path directory(UUID player) throws IOException {
        Path directory = root.resolve(player.toString());
        rejectLinks(directory);
        Files.createDirectories(directory);
        return directory;
    }

    public Path resolve(UUID player, String name) throws IOException {
        // Reject rather than normalize traversal; this also blocks Windows paths on Linux.
        if (name == null || name.isBlank() || name.equals("#") || name.contains("\\") || name.contains(":") || name.startsWith("/")) {
            throw new IOException("Use a filename inside your schematic library.");
        }
        for (String part : name.split("/", -1)) {
            if (part.isBlank() || part.equals(".") || part.equals("..") || part.startsWith(".")) {
                throw new IOException("Use a filename inside your schematic library.");
            }
        }
        Path directory = directory(player);
        Path file = directory.resolve(name).normalize();
        if (!file.startsWith(directory)) throw new IOException("Invalid schematic path.");
        rejectLinks(file);
        return file;
    }

    /** Validate WorldEdit's final extension-expanded path as well as the original input. */
    public Path validate(UUID player, Path file) throws IOException {
        Path directory = directory(player);
        Path absolute = file.toAbsolutePath().normalize();
        if (!absolute.startsWith(directory) || absolute.equals(directory)) throw new IOException("Invalid schematic path.");
        rejectLinks(absolute);
        return absolute;
    }

    public List<Path> files(UUID player) throws IOException {
        Path directory = directory(player);
        // walk does not follow directory symlinks. Reject linked files too.
        try (var paths = Files.walk(directory)) {
            return paths.filter(p -> Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS))
                    .filter(p -> !directory.relativize(p).toString().startsWith("."))
                    .sorted().toList();
        }
    }

    private void rejectLinks(Path path) throws IOException {
        for (Path current = path; current != null && current.startsWith(root); current = current.getParent()) {
            if (Files.isSymbolicLink(current)) throw new IOException("Schematic libraries cannot contain symbolic links.");
        }
    }
}
