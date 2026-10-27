package net.mineandcraft.plantools.core;

import java.util.Optional;

/** Additional restrictions may reject a teleport but cannot override project isolation. */
@FunctionalInterface
public interface TeleportRule {
    enum Operation { COORDINATES, PLAYER }
    record Context(ProjectAccess.Member caller, ProjectWorld destination, Operation operation) {}
    Optional<String> rejection(Context context);
}
