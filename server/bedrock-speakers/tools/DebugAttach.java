import com.sun.tools.attach.VirtualMachine;
import java.lang.instrument.Instrumentation;
import java.net.URLClassLoader;
import java.nio.file.*;
import java.util.Arrays;

/** Invokes an explicitly named diagnostic helper and saves its bounded result. */
public final class DebugAttach {
    public static void agentmain(String args, Instrumentation instrumentation) throws Exception {
        String[] parts = args.split("\\|", -1);
        Class<?>[] loaded = instrumentation.getAllLoadedClasses();
        Class<?> helper = Arrays.stream(loaded).filter(c -> c.getName().equals(parts[1])).findFirst().orElse(null);
        if (helper == null) {
            var extension = Arrays.stream(loaded).filter(c -> c.getName().equals("net.mineandcraft.bedrockspeakers.CopperBedrock")).findFirst().orElseThrow();
            var loader = new URLClassLoader(new java.net.URL[]{Path.of(parts[0]).toUri().toURL()}, extension.getClassLoader());
            helper = Class.forName(parts[1], true, loader);
        }
        Object result = helper.getMethod(parts[2]).invoke(null);
        Files.writeString(Path.of(parts[3]), String.valueOf(result));
    }
    public static void main(String[] args) throws Exception {
        var vm = VirtualMachine.attach(args[0]);
        try { vm.loadAgent(args[1], args[2]); } finally { vm.detach(); }
    }
}
