import com.sun.tools.attach.VirtualMachine;
import java.lang.instrument.Instrumentation;
import java.nio.file.*;
import java.util.*;

/** Inspect/reset only the temporary diagnostic packet buffer. */
public final class TraceControl {
    public static void agentmain(String args, Instrumentation instrumentation) throws Exception {
        String[] parts = args.split("\\|", 2);
        Class<?> helper = Arrays.stream(instrumentation.getAllLoadedClasses())
                .filter(c -> c.getName().equals("net.mineandcraft.bedrockspeakers.debug.DisplayTrace")).findFirst().orElseThrow();
        var field = helper.getDeclaredField("actors"); field.setAccessible(true);
        Map<?,?> actors = (Map<?,?>) field.get(null);
        if (parts[0].equals("clear")) actors.clear();
        var text = new StringBuilder("Tracked displays: " + actors.size() + "\n");
        for (var entry : actors.entrySet()) {
            Map<?,?> actor = (Map<?,?>) entry.getValue();
            Object model = actor.get("int:13");
            if (model instanceof Integer index && index > 0) text.append(entry).append('\n');
        }
        Files.writeString(Path.of(parts[1]), text.toString());
    }
    public static void main(String[] args) throws Exception {
        var vm = VirtualMachine.attach(args[0]);
        try { vm.loadAgent(args[1], args[2]); } finally { vm.detach(); }
    }
}
