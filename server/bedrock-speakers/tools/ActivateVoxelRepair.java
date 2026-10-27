import com.sun.tools.attach.VirtualMachine;
import java.lang.instrument.Instrumentation;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.Arrays;

/** Load the tested voxel packet repair for new client joins without a restart. */
public final class ActivateVoxelRepair {
    public static void agentmain(String jar, Instrumentation instrumentation) throws Exception {
        Class<?> extension = Arrays.stream(instrumentation.getAllLoadedClasses())
                .filter(c -> c.getName().equals("net.mineandcraft.bedrockspeakers.CopperBedrock"))
                .findFirst().orElseThrow();
        var loader = new URLClassLoader(new java.net.URL[]{Path.of(jar).toUri().toURL()}, extension.getClassLoader());
        Class<?> repair = Class.forName("net.mineandcraft.bedrockspeakers.VoxelSupport", true, loader);
        repair.getMethod("activateLive").invoke(null);
    }
    public static void main(String[] args) throws Exception {
        var vm = VirtualMachine.attach(args[0]);
        try { vm.loadAgent(args[1], args[2]); } finally { vm.detach(); }
    }
}
