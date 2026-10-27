package net.mineandcraft.plantools.core;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Stream;
import net.mineandcraft.plantools.core.ProjectAccess.Member;
import net.mineandcraft.plantools.core.ProjectAccess.Position;
import net.mineandcraft.plantools.core.ProjectWorld.Dimension;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import static org.junit.jupiter.api.Assertions.*;

class TeleportServiceTest {
    private static final UUID PROJECT = UUID.randomUUID();
    private static final Position POSITION = new Position(-123, 80, 456);
    private FakeAccess access;
    private TeleportOptions options;
    private TeleportService<String, ProjectWorld> service;

    @BeforeEach void setup() {
        access = new FakeAccess();
        options = TeleportOptions.defaults();
        service = new TeleportService<>(access, () -> options, List.of());
        access.add("caller", PROJECT, Dimension.OVERWORLD, true);
    }

    static Stream<Arguments> dimensionPairs() {
        return Stream.of(Dimension.values()).flatMap(from -> Stream.of(Dimension.values()).map(to -> Arguments.of(from, to)));
    }

    @ParameterizedTest @MethodSource("dimensionPairs")
    void coordinatesRemainInsideTheProjectAcrossAllNineRoutes(Dimension from, Dimension to) {
        access.add("caller", PROJECT, from, true);
        service.coordinates("caller", to, POSITION);
        assertEquals(List.of(new Move("caller", new ProjectWorld(PROJECT, to), POSITION)), access.moves);
        assertEquals(from == to ? 0 : 1, access.loads);
    }

    @ParameterizedTest @MethodSource("dimensionPairs")
    void playerTargetsWorkAcrossAllNineRoutes(Dimension from, Dimension to) {
        access.add("caller", PROJECT, from, false); // Includes a guest's active session.
        access.add("friend", PROJECT, to, false);
        service.toPlayer("caller", "friend");
        assertEquals(List.of(new Move("caller", new ProjectWorld(PROJECT, to), POSITION)), access.moves);
        assertEquals(0, access.loads);
    }

    @Test void missingDimensionUsesCurrentProjectDimension() {
        access.add("caller", PROJECT, Dimension.END, true);
        service.coordinates("caller", null, POSITION);
        assertEquals(Dimension.END, access.moves.getFirst().world.dimension());
    }

    @Test void rejectsSurvivalAndStaleSessions() {
        access.members.remove("caller");
        denied(() -> service.coordinates("caller", Dimension.NETHER, POSITION));
        access.add("caller", PROJECT, Dimension.OVERWORLD, true);
        denied(() -> service.toPlayer("caller", "survival-player"));
        assertFalse(service.canTarget("caller", "survival-player"));
        assertEquals(0, access.loads);
    }

    @Test void otherProjectCannotBeSelectedEvenWithIdenticalDimensionAndPermissiveRule() {
        access.add("outsider", UUID.randomUUID(), Dimension.OVERWORLD, true);
        service = new TeleportService<>(access, () -> options, List.of(context -> Optional.empty()));
        denied(() -> service.toPlayer("caller", "outsider"));
        assertFalse(service.canTarget("caller", "outsider"));
    }

    @Test void planDisabledDimensionsApplyToCoordinatesAndPlayersBeforeLoading() {
        access.disabled.addAll(EnumSet.of(Dimension.NETHER, Dimension.END));
        for (Dimension dimension : access.disabled) {
            access.add("friend", PROJECT, dimension, true);
            denied(() -> service.coordinates("caller", dimension, POSITION));
            denied(() -> service.toPlayer("caller", "friend"));
        }
        assertEquals(0, access.loads);
    }

    @Test void crossDimensionToggleStillAllowsSameDimension() {
        options = new TeleportOptions(true, true, true, true, false);
        access.add("friend", PROJECT, Dimension.NETHER, false);
        denied(() -> service.coordinates("caller", Dimension.NETHER, POSITION));
        denied(() -> service.toPlayer("caller", "friend"));
        service.coordinates("caller", Dimension.OVERWORLD, POSITION);
        assertEquals(1, access.moves.size());
    }

    @Test void featureTogglesAreIndependentAndReloadedPerRequest() {
        options = new TeleportOptions(true, true, false, true, true);
        denied(() -> service.coordinates("caller", null, POSITION));
        access.add("friend", PROJECT, Dimension.OVERWORLD, false);
        service.toPlayer("caller", "friend");
        access.moves.clear();
        options = new TeleportOptions(true, true, true, false, true);
        denied(() -> service.toPlayer("caller", "friend"));
        service.coordinates("caller", null, POSITION);
        access.moves.clear();
        options = new TeleportOptions(false, true, true, true, true);
        denied(() -> service.coordinates("caller", null, POSITION));
        denied(() -> service.toPlayer("caller", "friend"));
    }

    @Test void ownerOnlyRejectsGuestsWithoutRejectingOwner() {
        options = new TeleportOptions(true, false, true, true, true);
        access.add("guest", PROJECT, Dimension.OVERWORLD, false);
        denied(() -> service.coordinates("guest", null, POSITION));
        denied(() -> service.toPlayer("guest", "caller"));
        service.toPlayer("caller", "guest");
        assertEquals("caller", access.moves.getFirst().player);
    }

    @Test void additionalRestrictionsApplyBeforeLoading() {
        service = new TeleportService<>(access, () -> options, List.of(context -> Optional.of("Custom restriction")));
        var error = assertThrows(TeleportService.Rejected.class, () -> service.coordinates("caller", Dimension.END, POSITION));
        assertEquals("Custom restriction", error.getMessage());
        assertTrue(access.moves.isEmpty());
        assertEquals(0, access.loads);
    }

    @Test void unavailableWorldNeverTeleports() {
        access.unavailable = true;
        denied(() -> service.coordinates("caller", Dimension.NETHER, POSITION));
    }

    @Test void returnedWorldMustMatchTheAuthorizedProjectAndDimension() {
        access.loadOverride = new ProjectWorld(UUID.randomUUID(), Dimension.NETHER);
        denied(() -> service.coordinates("caller", Dimension.NETHER, POSITION));
        access.loadOverride = new ProjectWorld(PROJECT, Dimension.END);
        denied(() -> service.coordinates("caller", Dimension.NETHER, POSITION));
        access.unidentified = true;
        denied(() -> service.coordinates("caller", null, POSITION));
    }

    @Test void sessionIsRecheckedAfterWorldLoading() {
        access.onLoad = () -> access.members.remove("caller");
        denied(() -> service.coordinates("caller", Dimension.NETHER, POSITION));
    }

    @Test void boundsAreCheckedBeforeMovingAndHugeCoordinatesBeforeLoading() {
        denied(() -> service.coordinates("caller", Dimension.NETHER, new Position(Integer.MIN_VALUE, 80, 0)));
        denied(() -> service.coordinates("caller", Dimension.NETHER, new Position(0, 80, Integer.MAX_VALUE)));
        assertEquals(0, access.loads);
        access.inBounds = false;
        denied(() -> service.coordinates("caller", null, new Position(0, -9999, 0)));
        access.add("friend", PROJECT, Dimension.OVERWORLD, false);
        denied(() -> service.toPlayer("caller", "friend"));
    }

    private void denied(Runnable action) {
        assertThrows(TeleportService.Rejected.class, action::run);
        assertTrue(access.moves.isEmpty(), "Rejected operations must never move anyone");
    }

    private record Move(String player, ProjectWorld world, Position position) {}

    private static final class FakeAccess implements ProjectAccess<String, ProjectWorld> {
        final Map<String, Member> members = new HashMap<>();
        final List<Move> moves = new ArrayList<>();
        final EnumSet<Dimension> disabled = EnumSet.noneOf(Dimension.class);
        int loads;
        boolean unavailable, unidentified;
        boolean inBounds = true;
        ProjectWorld loadOverride;
        Runnable onLoad = () -> {};
        void add(String name, UUID project, Dimension dimension, boolean owner) {
            members.put(name, new Member(new ProjectWorld(project, dimension), owner));
        }
        public Optional<Member> member(String player) { return Optional.ofNullable(members.get(player)); }
        public Optional<ProjectWorld> identify(ProjectWorld world) { return unidentified ? Optional.empty() : Optional.of(world); }
        public ProjectWorld currentWorld(String player) { return members.get(player).world(); }
        public Position position(String player) { return POSITION; }
        public boolean dimensionEnabled(Dimension dimension) { return !disabled.contains(dimension); }
        public ProjectWorld loadWorld(String player, Dimension dimension) {
            loads++;
            ProjectWorld world = new ProjectWorld(members.get(player).world().projectId(), dimension);
            onLoad.run();
            return unavailable ? null : loadOverride == null ? world : loadOverride;
        }
        public boolean withinBounds(ProjectWorld world, Position position) { return inBounds; }
        public void teleport(String player, ProjectWorld world, Position position) { moves.add(new Move(player, world, position)); }
    }
}
