package net.mineandcraft.mapart;

/** Computes payment and a delivery slot before any live inventory mutation. */
final class MapPayment {
    record Plan(int[] deductions, int deliverySlot) {}
    static Plan plan(int[] blankMaps, boolean[] empty, int cost) {
        if (blankMaps.length != 36 || empty.length != 36 || cost < 0 || cost > Layout.MAX_TILES) throw new IllegalArgumentException("Invalid inventory or map count");
        int remaining = cost, free = -1;
        int[] deductions = new int[36];
        for (int slot = 0; slot < 36; slot++) {
            deductions[slot] = Math.min(blankMaps[slot], remaining); remaining -= deductions[slot];
            if (empty[slot] || (blankMaps[slot] > 0 && blankMaps[slot] == deductions[slot])) free = slot;
        }
        if (remaining > 0) throw new IllegalStateException("You need " + cost + " blank maps in your main inventory for this copy.");
        if (free < 0) throw new IllegalStateException(cost == 0 ? "Make one inventory slot available for the artwork." : "Make one inventory slot available for the artwork after paying its blank maps.");
        return new Plan(deductions, free);
    }
}
