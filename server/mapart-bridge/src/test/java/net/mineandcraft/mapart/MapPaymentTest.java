package net.mineandcraft.mapart;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MapPaymentTest {
    @Test void largeClaimPaysAcrossFourStacksWithoutTouchingOtherItems() {
        int[] maps = new int[36];
        for (int slot = 0; slot < 4; slot++) maps[slot] = 64;
        var plan = MapPayment.plan(maps, new boolean[36], 256);
        assertEquals(3, plan.deliverySlot());
        for (int slot = 0; slot < 36; slot++) assertEquals(slot < 4 ? 64 : 0, plan.deductions()[slot]);
        maps[3] = 63;
        assertThrows(IllegalStateException.class, () -> MapPayment.plan(maps, new boolean[36], 256));
        assertEquals(63, maps[3]);
    }
    @Test void freeClaimNeedsNoMaterials() {
        boolean[] empty = new boolean[36]; empty[8] = true;
        var plan = MapPayment.plan(new int[36], empty, 0);
        assertEquals(8, plan.deliverySlot());
        assertArrayEquals(new int[36], plan.deductions());
    }
    @Test void freeClaimLeavesExistingMapsUntouched() {
        int[] maps = new int[36]; maps[0] = 64; maps[1] = 1;
        boolean[] empty = new boolean[36]; empty[20] = true;
        var plan = MapPayment.plan(maps, empty, 0);
        assertEquals(20, plan.deliverySlot());
        assertArrayEquals(new int[36], plan.deductions());
    }
    @Test void freeClaimCannotReplaceItemsInFullInventory() {
        int[] maps = new int[36]; maps[0] = 64;
        assertThrows(IllegalStateException.class, () -> MapPayment.plan(maps, new boolean[36], 0));
    }
    @Test void fullInventoryCanUseTheSlotFreedByExactlySixtyFourMaps() {
        int[] maps = new int[36]; maps[12] = 64;
        var plan = MapPayment.plan(maps,new boolean[36],64);
        assertEquals(12,plan.deliverySlot()); assertEquals(64,plan.deductions()[12]);
        assertEquals(64,maps[12]); // Planning cannot consume live items.
    }
    @Test void partiallyConsumingTheOnlyMapStackDoesNotMakeSpace() {
        int[] maps = new int[36]; maps[0] = 64;
        assertThrows(IllegalStateException.class,() -> MapPayment.plan(maps,new boolean[36],16));
        assertEquals(64,maps[0]);
    }
    @Test void insufficientMaterialsCannotProduceAPartialPayment() {
        int[] maps = new int[36]; maps[0]=10; maps[8]=12;
        boolean[] empty = new boolean[36]; empty[35]=true;
        assertThrows(IllegalStateException.class,() -> MapPayment.plan(maps,empty,64));
        assertEquals(10,maps[0]); assertEquals(12,maps[8]);
    }
    @Test void sumsStacksAndChargesEveryReplacementCopy() {
        int[] maps = new int[36]; maps[0]=5; maps[1]=20;
        boolean[] empty = new boolean[36]; empty[35]=true;
        for (int copy=0;copy<2;copy++) {
            var plan = MapPayment.plan(maps,empty,16);
            assertEquals(5,plan.deductions()[0]); assertEquals(11,plan.deductions()[1]); assertEquals(35,plan.deliverySlot());
        }
    }
}
