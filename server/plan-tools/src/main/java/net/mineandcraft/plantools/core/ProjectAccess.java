package net.mineandcraft.plantools.core;

import java.util.Optional;
import net.mineandcraft.plantools.core.ProjectWorld.Dimension;

/** All platform/Plan calls live behind this boundary. Calls run on the server thread. */
public interface ProjectAccess<Player, World> {
    record Member(ProjectWorld world, boolean owner) {}
    record Position(int x, int y, int z) {}

    /** Empty unless the live Plan session matches the player's actual project world. */
    Optional<Member> member(Player player);
    Optional<ProjectWorld> identify(World world);
    World currentWorld(Player player);
    Position position(Player player);
    boolean dimensionEnabled(Dimension dimension);
    /** Called only after authorization. May return null when Plan cannot load a world. */
    World loadWorld(Player player, Dimension dimension);
    boolean withinBounds(World world, Position position);
    void teleport(Player player, World world, Position position);
}
