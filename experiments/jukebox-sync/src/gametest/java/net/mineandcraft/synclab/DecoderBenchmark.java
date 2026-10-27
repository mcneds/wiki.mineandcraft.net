package net.mineandcraft.synclab;

import com.google.gson.GsonBuilder;
import net.minecraft.client.sounds.JOrbisAudioStream;
import java.lang.management.ManagementFactory;
import java.nio.file.*;
import java.util.*;

/** Headless benchmark of Minecraft's actual decoder, not a replacement implementation. */
public final class DecoderBenchmark {
    public static void main(String[] args) throws Exception {
        Path asset = Path.of(args[0]);
        Path output = Path.of(args[1]);
        var threads = (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();
        threads.setThreadCpuTimeEnabled(true);
        threads.setThreadAllocatedMemoryEnabled(true);
        long thread = Thread.currentThread().threadId();
        List<Map<String, Object>> results = new ArrayList<>();
        // Warm class loading/JIT before measured, interleaved cases.
        for (int i = 0; i < 3; i++) decode(asset, 1, true);
        for (int repetition = 0; repetition < 5; repetition++) {
            for (String mode : repetition % 2 == 0 ? List.of("buffered-one", "streamed-one", "streamed-eight") : List.of("streamed-eight", "streamed-one", "buffered-one")) {
                int sources = mode.equals("streamed-eight") ? 8 : 1;
                long cpu = threads.getCurrentThreadCpuTime();
                long allocated = threads.getThreadAllocatedBytes(thread);
                long start = System.nanoTime();
                long bytes = decode(asset, sources, mode.equals("buffered-one"));
                Map<String, Object> row = Map.of("mode", mode, "repetition", repetition, "sources", sources,
                        "decodedBytes", bytes, "wallMs", (System.nanoTime() - start) / 1e6,
                        "threadCpuMs", (threads.getCurrentThreadCpuTime() - cpu) / 1e6,
                        "threadAllocatedBytes", threads.getThreadAllocatedBytes(thread) - allocated);
                results.add(row);
                System.out.println(row);
            }
        }
        Map<String, Object> report = Map.of("status", "complete", "java", System.getProperty("java.version"),
                "method", "Minecraft JOrbisAudioStream; full readAll once versus 1-second read chunks for one/eight independent streams; no playback, GPU or server; JVM thread CPU, not native mixer CPU", "trials", results);
        Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report));
    }
    private static long decode(Path path, int count, boolean full) throws Exception {
        List<JOrbisAudioStream> streams = new ArrayList<>();
        long bytes = 0;
        try {
            for (int i = 0; i < count; i++) streams.add(new JOrbisAudioStream(Files.newInputStream(path)));
            if (full) {
                for (var stream : streams) bytes += stream.readAll().remaining();
            } else {
                boolean[] done = new boolean[count];
                int finished = 0;
                while (finished < count) {
                    for (int i = 0; i < count; i++) {
                        if (done[i]) continue;
                        int size = streams.get(i).read(96000).remaining();
                        bytes += size;
                        if (size == 0) { done[i] = true; finished++; }
                    }
                }
            }
        } finally { for (var stream : streams) stream.close(); }
        return bytes;
    }
}
