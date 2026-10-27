package net.mineandcraft.synclab;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.util.*;

/** Descriptive counters; JVM audio-thread CPU excludes native OpenAL mixing. */
final class PerformanceProbe {
    record Snapshot(long nano, long processCpu, Map<Long, Long> cpu, Map<Long, String> names, long gcMillis) {}
    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    static Snapshot snapshot() {
        if (!THREADS.isThreadCpuTimeEnabled()) THREADS.setThreadCpuTimeEnabled(true);
        Map<Long, Long> cpu = new HashMap<>();
        Map<Long, String> names = new HashMap<>();
        for (long id : THREADS.getAllThreadIds()) {
            var info = THREADS.getThreadInfo(id);
            if (info != null) {
                cpu.put(id, THREADS.getThreadCpuTime(id));
                names.put(id, info.getThreadName());
            }
        }
        long gc = ManagementFactory.getGarbageCollectorMXBeans().stream().mapToLong(b -> Math.max(0, b.getCollectionTime())).sum();
        long process = ((com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean()).getProcessCpuTime();
        return new Snapshot(System.nanoTime(), process, cpu, names, gc);
    }
    static Map<String, Object> delta(Snapshot before, Snapshot after) {
        Map<String, Double> threads = new TreeMap<>();
        after.cpu().forEach((id, value) -> {
            long previous = before.cpu().getOrDefault(id, 0L);
            if (value >= 0 && previous >= 0) threads.merge(after.names().get(id), (value - previous) / 1e6, Double::sum);
        });
        return Map.of("wallMs", (after.nano() - before.nano()) / 1e6,
                "wholeProcessCpuMs", (after.processCpu() - before.processCpu()) / 1e6,
                "jvmThreadCpuMs", threads, "gcMillis", after.gcMillis() - before.gcMillis());
    }
}
