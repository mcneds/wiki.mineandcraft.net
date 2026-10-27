package net.mineandcraft.plantools.schematic;

import com.sk89q.worldedit.WorldEdit;
import com.sk89q.worldedit.extension.platform.Actor;
import com.sk89q.worldedit.extent.clipboard.io.ClipboardFormats;
import com.sk89q.worldedit.util.formatting.text.TextComponent;
import com.sk89q.worldedit.util.formatting.text.event.ClickEvent;
import com.sk89q.worldedit.util.io.file.FilenameException;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/** All WorldEdit-facing access uses the actor's UUID, never a command-supplied owner. */
public final class WorldEditSchematics {
    private WorldEditSchematics() {}

    public static PersonalSchematics library() throws IOException {
        return new PersonalSchematics(WorldEdit.getInstance().getSchematicsManager().getRoot());
    }

    public static UUID owner(Actor actor) throws IOException {
        if (actor == null || !actor.isPlayer()) throw new IOException("Schematic libraries require a player.");
        return actor.getUniqueId();
    }

    public static File file(WorldEdit worldEdit, Actor actor, String filename, String extension,
                            String[] extensions, boolean save) throws FilenameException {
        try {
            UUID owner = owner(actor);
            var library = library();
            library.resolve(owner, filename);
            File directory = library.directory(owner).toFile();
            File file = save ? worldEdit.getSafeSaveFile(actor, directory, filename, extension, extensions)
                    : worldEdit.getSafeOpenFile(actor, directory, filename, extension, extensions);
            return library.validate(owner, file.toPath()).toFile();
        } catch (IOException | IllegalArgumentException error) {
            throw new FilenameException(filename, "Use a filename inside your own schematic library.");
        }
    }

    public static List<Path> files(Actor actor) throws IOException {
        return library().files(owner(actor)).stream().filter(path -> {
            String name = path.getFileName().toString();
            return ClipboardFormats.getAll().stream().anyMatch(format -> format.getFileExtensions().stream()
                    .anyMatch(extension -> name.endsWith("." + extension)));
        }).toList();
    }

    public static List<String> suggestions(Actor actor, String prefix) throws IOException {
        Path directory = library().directory(owner(actor));
        return files(actor).stream().map(directory::relativize).map(path -> path.toString().replace('\\', '/'))
                .filter(name -> name.startsWith(prefix)).limit(100).toList();
    }

    public static void list(Actor actor, int page, boolean oldest, boolean newest) {
        try {
            if (oldest && newest) { actor.printError(TextComponent.of("Choose either oldest or newest first.")); return; }
            var files = new ArrayList<>(files(actor));
            if (oldest || newest) {
                Comparator<Path> comparator = Comparator.comparingLong(path -> path.toFile().lastModified());
                files.sort(newest ? comparator.reversed() : comparator);
            }
            int pages = Math.max(1, (files.size() + 9) / 10);
            if (page < 1 || page > pages) { actor.printError(TextComponent.of("Page must be between 1 and " + pages + ".")); return; }
            actor.printInfo(TextComponent.of("Your schematics — page " + page + "/" + pages));
            Path directory = library().directory(owner(actor));
            if (files.isEmpty()) actor.printInfo(TextComponent.of("No schematics yet. Copy your build, then use //schem save <name>."));
            for (Path file : files.subList((page - 1) * 10, Math.min(page * 10, files.size()))) {
                String name = directory.relativize(file).toString().replace('\\', '/');
                actor.printInfo(TextComponent.of(name).clickEvent(ClickEvent.of(ClickEvent.Action.SUGGEST_COMMAND,
                        "//schem load \"" + name.replace("\"", "\\\"") + "\"")));
            }
            if (page < pages) actor.printInfo(TextComponent.of("Next page: //schem list -p " + (page + 1))
                    .clickEvent(ClickEvent.of(ClickEvent.Action.RUN_COMMAND, "//schem list -p " + (page + 1)
                            + (oldest ? " -d" : newest ? " -n" : ""))));
        } catch (IOException | IllegalArgumentException error) {
            actor.printError(TextComponent.of("Could not open your schematic library."));
        }
    }

    public static Path convert(Actor actor, String input) throws FilenameException {
        File file = file(WorldEdit.getInstance(), actor, input, "schem", ClipboardFormats.getFileExtensionArray(), false);
        if (!Files.isRegularFile(file.toPath())) throw new FilenameException(input, "No such schematic in your library.");
        try { return library().directory(owner(actor)).relativize(file.toPath()); }
        catch (IOException error) { throw new FilenameException(input); }
    }
}
