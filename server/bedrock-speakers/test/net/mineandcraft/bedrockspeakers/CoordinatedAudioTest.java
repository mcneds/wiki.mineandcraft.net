package net.mineandcraft.bedrockspeakers;

import java.util.*;
import org.cloudburstmc.math.vector.Vector3f;
import org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.data.sound.*;

/** Deterministic lifecycle tests; no sleeps, Minecraft process, or audio engine. */
final class CoordinatedAudioTest {
    private record Task(long due, long order, Runnable action) {}
    private record Update(long handle, SoundData event, long at) {}
    private static final class Fixture {
        long now, order;
        final PriorityQueue<Task> tasks = new PriorityQueue<>(Comparator.comparingLong(Task::due).thenComparingLong(Task::order));
        final List<Update> updates = new ArrayList<>();
        final List<CoordinatedAudio.Entry> prepared = new ArrayList<>();
        final CoordinatedAudio audio = new CoordinatedAudio(() -> now,
                (delay, action) -> tasks.add(new Task(now + delay * 1_000_000L, order++, action)),
                new CoordinatedAudio.Output() {
                    public void prepare(CoordinatedAudio.Entry entry, float offset) { prepared.add(entry); }
                    public void update(long handle, SoundData event) { updates.add(new Update(handle, event, now)); }
                });
        CoordinatedAudio.Clock start(long handle, float offset, boolean audible) {
            var clock = new CoordinatedAudio.Clock(offset, 1, now);
            audio.start(handle, "record.cat", Vector3f.ZERO, 4, 1, clock, audible);
            return clock;
        }
        void until(long millis) {
            long target = millis * 1_000_000L;
            while (!tasks.isEmpty() && tasks.peek().due <= target) { var task = tasks.remove(); now = task.due; task.action.run(); }
            now = target;
        }
        List<Update> type(Class<?> type) { return updates.stream().filter(u -> type.isInstance(u.event)).toList(); }
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static void run() {
        long release = CoordinatedAudio.BATCH_MS + CoordinatedAudio.PREPARATION_MS + CoordinatedAudio.SETTLE_MS;
        var f = new Fixture();
        check(!f.audio.stop(999), "Unmanaged Geyser records must use the caller's native stop fallback");
        var a = f.start(1, 15, true); var b = f.start(2, 15, true); var spare = f.start(3, 15, false);
        f.until(CoordinatedAudio.BATCH_MS);
        check(f.prepared.size() == 2 && f.type(PauseSoundData.class).size() == 2, "All audible sources prepare and pause");
        check(f.type(ResumeSoundData.class).isEmpty(), "Nothing resumes before preparation ends");
        f.until(release);
        check(a.epoch == b.epoch && a.epoch == spare.epoch, "Audible and parked sources share one epoch");
        check(f.type(SeekToSoundData.class).stream().allMatch(u -> ((SeekToSoundData)u.event).getSeconds() == 15),
                "Initial release preserves the requested opening position");
        check(f.type(ResumeSoundData.class).size() == 2 && f.type(ResumeSoundData.class).stream().allMatch(u -> u.at == f.now),
                "All prepared sources resume on one scheduler turn");
        check(f.updates.get(f.updates.size() - 1).event instanceof ResumeSoundData,
                "Seek and volume updates precede every resume");
        f.until(release + 5000);
        f.audio.start(3, "record.cat", Vector3f.ZERO, 4, 1, spare, true);
        f.until(release + 5000 + release);
        var late = f.type(SeekToSoundData.class).stream().filter(u -> u.handle == 3).findFirst().orElseThrow();
        check(Math.abs(((SeekToSoundData)late.event).getSeconds() - (20 + release / 1000f)) < .001,
                "A newly attached speaker joins the existing clock after its own preparation");
        check(f.type(ResumeSoundData.class).stream().filter(u -> u.handle == 1 || u.handle == 2).count() == 2,
                "Attaching a speaker must never pause or resume existing sources");
        check(f.updates.stream().noneMatch(u -> u.handle != 3 && u.at > release * 1_000_000L),
                "Attaching a speaker must not send any updates to existing handles");
        check(Math.abs(a.position(f.now) - ((SeekToSoundData)late.event).getSeconds()) < .001,
                "Existing song clocks continue uninterrupted during attachment");

        var stopped = new Fixture(); stopped.start(1, 0, true); stopped.until(100); stopped.audio.stop(1); stopped.until(release + 10);
        check(stopped.type(StopSoundData.class).size() == 1 && stopped.type(ResumeSoundData.class).isEmpty(),
                "Ejection during preparation cancels release");
        var seeking = new Fixture(); seeking.start(1, 0, true);
        seeking.until(CoordinatedAudio.BATCH_MS + CoordinatedAudio.PREPARATION_MS);
        check(seeking.type(SeekToSoundData.class).size() == 1 && seeking.type(ResumeSoundData.class).isEmpty(),
                "Seeking happens while the source is still paused");
        seeking.audio.stop(1); seeking.until(release + 10);
        check(seeking.type(ResumeSoundData.class).isEmpty(), "Ejection while seeking must not revive the source");
        var replaced = new Fixture(); replaced.start(1, 0, true); replaced.until(100); replaced.start(1, 10, true);
        replaced.until(release); check(replaced.type(ResumeSoundData.class).isEmpty(), "Stale callback cannot release a replacement");
        replaced.until(release + 100);
        check(replaced.type(ResumeSoundData.class).size() == 1 && replaced.type(SeekToSoundData.class).stream()
                .allMatch(u -> ((SeekToSoundData)u.event).getSeconds() == 10), "Only the replacement begins");
        var disconnected = new Fixture(); disconnected.start(1, 0, true); disconnected.until(100);
        int before = disconnected.updates.size(); disconnected.audio.close(); disconnected.until(release + 10);
        check(disconnected.updates.size() == before, "Disconnect cancels delayed audio actions");
        var rejoined = new Fixture(); rejoined.start(1, 0, true); rejoined.until(release);
        check(rejoined.type(ResumeSoundData.class).size() == 1, "A new connection receives preparation normally");
        var overlap = new Fixture(); var shared = overlap.start(1, 0, true); overlap.until(release + 1000);
        overlap.audio.start(2, "record.cat", Vector3f.ZERO, 4, 1, shared, true);
        overlap.until(release + 1100);
        overlap.audio.start(3, "record.cat", Vector3f.ZERO, 4, 1, shared, true);
        overlap.until(2 * release + 1100);
        check(overlap.type(ResumeSoundData.class).size() == 3,
                "Overlapping late preparations release only their new sources");
        check(overlap.type(PauseSoundData.class).stream().filter(u -> u.handle == 1).count() == 1,
                "Overlapping attachments cannot pause an existing speaker");
        check(overlap.audio.phase(1).equals("playing") && overlap.audio.phase(2).equals("playing")
                && overlap.audio.phase(3).equals("playing"), "All overlapping attachments become audible");
        var different = new Fixture(); var cat = different.start(1, 0, true);
        var other = new CoordinatedAudio.Clock(0, 1, 0);
        different.audio.start(2, "record.13", Vector3f.ZERO, 4, 1, other, true); different.until(release);
        check(cat.epoch != other.epoch, "Simultaneous unrelated songs must not share a resynchronization clock");
        var independent = new Fixture(); var first = independent.start(1, 0, true); independent.until(release + 1000);
        var second = independent.start(2, 0, true); independent.until(2 * release + 1000);
        check(first.epoch != second.epoch && first.position(independent.now) > 3 && second.position(independent.now) == 0,
                "Independent starts retain separate timelines");
        System.out.println("PASS: coordinated starts, intro preservation, late attachment, ejection, replacement, disconnect/rejoin, and independent clocks");
    }
}
