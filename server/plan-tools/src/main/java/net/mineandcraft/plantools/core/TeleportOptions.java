package net.mineandcraft.plantools.core;

public record TeleportOptions(boolean enabled, boolean allowGuests, boolean coordinates,
                              boolean players, boolean crossDimension) {
    public static TeleportOptions defaults() {
        return new TeleportOptions(true, true, true, true, true);
    }
}
