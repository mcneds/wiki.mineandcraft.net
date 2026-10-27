import com.sun.tools.attach.VirtualMachine;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Read-only, on-demand runtime snapshot. No transformers or world changes. */
public final class LiveSnapshot {
    private static Class<?>[] loaded;
    private static final StringBuffer output = new StringBuffer();
    static Class<?> type(String name) {
        return Arrays.stream(loaded).filter(c -> c.getName().equals(name)).findFirst().orElseThrow();
    }
    static Object call(Object instance, String name, Object... args) throws Exception {
        Class<?> cls = instance instanceof Class<?> c ? c : instance.getClass();
        for (Method method : cls.getMethods()) {
            if (!method.getName().equals(name) || method.getParameterCount() != args.length) continue;
            boolean match = true;
            for (int i = 0; i < args.length; i++)
                if (args[i] != null && !method.getParameterTypes()[i].isInstance(args[i])) match = false;
            if (!match) continue;
            method.setAccessible(true);
            return method.invoke(instance instanceof Class<?> ? null : instance, args);
        }
        throw new NoSuchMethodException(cls.getName() + "." + name);
    }
    static Object field(Object instance, String name) throws Exception {
        Class<?> cls = instance instanceof Class<?> c ? c : instance.getClass();
        for (Class<?> c = cls; c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name); f.setAccessible(true);
                return f.get(instance instanceof Class<?> ? null : instance);
            } catch (NoSuchFieldException ignored) {}
        }
        throw new NoSuchFieldException(name);
    }
    static void line(Object value) { output.append(value).append('\n'); }
    static void fields(Object object, String indent, int depth) throws Exception {
        if (object == null) return;
        for (Field f : object.getClass().getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers())) continue;
            f.setAccessible(true); Object v = f.get(object);
            String text = String.valueOf(v);
            line(indent + f.getName() + "=" + text.substring(0, Math.min(1800, text.length())));
            if (depth > 0 && v != null && v.getClass().getName().startsWith("dev.mcneds.copperspeakers")) fields(v, indent + "  ", depth - 1);
        }
    }
    public static void agentmain(String path, Instrumentation instrumentation) throws Exception {
        loaded = instrumentation.getAllLoadedClasses();
        Object geyser = call(type("org.geysermc.geyser.GeyserImpl"), "getInstance");
        for (Object session : (Collection<?>) call(call(geyser, "getSessionManager"), "getAllSessions")) {
            CountDownLatch done = new CountDownLatch(1);
            Runnable snapshot = () -> {
                try {
                    line("GEYSER " + call(session, "bedrockUsername"));
                    Object player = call(session, "getPlayerEntity"); line("player=" + call(player, "position"));
                    Object extension = call(call(geyser, "extensionManager"), "extension", "copperbedrock");
                    Object listener = ((Map<?, ?>) field(extension, "listeners")).get(session);
                    if (listener != null) {
                        line("voices=" + field(listener, "voices"));
                        for (Object entry : ((Map<?, ?>) field(listener, "voices")).entrySet()) {
                            Map.Entry<?, ?> e = (Map.Entry<?, ?>) entry; line("voice " + e.getKey()); fields(e.getValue(), "  ", 1);
                        }
                    }
                    Map<?, ?> entities = (Map<?, ?>) call(call(session, "getEntityCache"), "getEntitiesUnsafe");
                    int count = 0;
                    for (Object entity : entities.values()) {
                        if (!entity.getClass().getName().matches(".*(DisplayEntity|FrameEntity)")) continue;
                        if (count++ > 160) break;
                        line("entity " + call(entity, "getEntityId") + " " + entity.getClass().getSimpleName() + " pos=" + call(entity, "position") +
                            " bedrock=" + call(entity, "bedrockPosition") + " rotation=" + call(entity, "bedrockRotation"));
                        for (String key : List.of("item", "translation", "scale", "nativeCopper", "facing", "plate", "spawned", "bedrockPosition")) {
                            try { line("  " + key + "=" + field(entity, key)); } catch (NoSuchFieldException ignored) {}
                        }
                    }
                } catch (Throwable error) { line("GEYSER ERROR " + error); }
                finally { done.countDown(); }
            };
            call(session, "executeInEventLoop", snapshot);
            done.await(5, TimeUnit.SECONDS);
        }
        Object loader = call(type("net.fabricmc.loader.api.FabricLoader"), "getInstance");
        Object server = call(loader, "getGameInstance");
        CountDownLatch done = new CountDownLatch(1);
        ((Executor) server).execute(() -> {
            try {
                line("JAVA NETWORKS");
                Map<?, ?> levels = (Map<?, ?>) field(type("dev.mcneds.copperspeakers.network.AudioNetworks"), "LEVELS");
                for (Object network : levels.values()) {
                    Object sessions = field(network, "sessions");
                    if (((Map<?, ?>) sessions).isEmpty()) continue;
                    line("level=" + field(network, "level"));
                    for (Map.Entry<?, ?> entry : ((Map<?, ?>) sessions).entrySet()) { line("root=" + entry.getKey()); fields(entry.getValue(), "  ", 2); }
                }
                for (Object player : (Collection<?>) call(call(server, "getPlayerList"), "getPlayers")) {
                    Object pos = call(player, "blockPosition"); line("PLAYER " + call(player, "getScoreboardName") + " " + pos);
                    Object level = call(player, "level");
                    int x = (int) call(pos, "getX"), y = (int) call(pos, "getY"), z = (int) call(pos, "getZ");
                    Constructor<?> ctor = type("net.minecraft.core.BlockPos").getConstructor(int.class, int.class, int.class);
                    for (int X = x-7; X <= x+7; X++) for (int Y = y-2; Y <= y+2; Y++) for (int Z = z-7; Z <= z+7; Z++) {
                        Object blockPos = ctor.newInstance(X,Y,Z); Object state = call(level, "getBlockState", blockPos);
                        String name = state.toString();
                        if (name.contains("copper_speakers:") || name.contains("minecraft:jukebox")) {
                            line("  block " + blockPos + " " + state);
                            Object blockEntity = call(level, "getBlockEntity", blockPos);
                            if (blockEntity != null) fields(blockEntity, "    ", 0);
                        }
                    }
                }
            } catch (Throwable error) { line("JAVA ERROR " + error); }
            finally { done.countDown(); }
        });
        done.await(10, TimeUnit.SECONDS);
        Files.writeString(Path.of(path), output.toString());
    }
    public static void main(String[] args) throws Exception {
        VirtualMachine vm = VirtualMachine.attach(args[0]);
        try { vm.loadAgent(args[1], args[2]); } finally { vm.detach(); }
    }
}
