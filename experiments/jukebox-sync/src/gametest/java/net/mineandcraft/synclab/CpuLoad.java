package net.mineandcraft.synclab;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** Reproducible additional CPU pressure, independent of the server and audio threads. */
final class CpuLoad implements AutoCloseable {
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final List<Thread> workers = new ArrayList<>();
    private static volatile long sink;

    CpuLoad(int count) {
        if (count < 0 || count > Runtime.getRuntime().availableProcessors())
            throw new IllegalArgumentException("Stress thread count exceeds available processors");
        for (int i = 0; i < count; i++) {
            Thread worker = new Thread(() -> {
                long value = 0x12345678;
                while (running.get()) {
                    for (int j = 0; j < 100000; j++) value = (value ^ (value << 13)) * 6364136223846793005L + 1;
                    sink = value;
                }
            }, "synclab-cpu-load-" + i);
            worker.setDaemon(true);
            worker.start();
            workers.add(worker);
        }
    }

    @Override public void close() throws InterruptedException {
        running.set(false);
        for (Thread worker : workers) worker.join(2000);
    }
}
