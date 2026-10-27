package net.mineandcraft.plantools.core;

import java.util.Objects;
import java.util.UUID;

/** Identity is a project UUID AND its dimension, never a world-name prefix. */
public record ProjectWorld(UUID projectId, Dimension dimension) {
    public ProjectWorld {
        Objects.requireNonNull(projectId);
        Objects.requireNonNull(dimension);
    }

    public enum Dimension { OVERWORLD, NETHER, END }
}
