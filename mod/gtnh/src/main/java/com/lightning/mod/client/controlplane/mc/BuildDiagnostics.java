package com.lightning.mod.client.controlplane.mc;

import java.lang.reflect.Field;
import java.util.Collection;
import java.util.concurrent.atomic.AtomicBoolean;

import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraft.world.chunk.IChunkProvider;
import net.minecraft.world.gen.ChunkProviderServer;

/**
 * 「会话内第二次世界重建失败」诊断器具（issue #89，出处：<b>#89 评论 1685</b> 首选假说 H1）与
 * 可选的 chunk 静默门。
 *
 * <h2>用途</h2>
 * #89 现象：ctm 新基线下会话内<b>第二次</b>世界重建时，{@code block}/{@code te} 步静默失败——
 * {@code world.setBlock} 返回 {@code false}、TE 不落，但流程不报错。首选假说 H1：构建在客户端 tick
 * 线程里直接触碰服务端世界（{@link WorldRuntime} 的既有调用约定），恰好撞上服务端线程并发 chunk
 * 加载，1.7.10 {@code ChunkProviderServer} 的「同一 chunk 正在加载」保护让 {@code provideChunk}
 * 落到空 chunk/返回空，{@code setBlock} 于是静默失败。本类只提供<b>观测与等待</b>两件器具，不做任何修复。
 *
 * <h2>默认关闭（零行为变化）</h2>
 * 两个开关都是 JVM 属性，<b>不设置即全部关闭</b>：
 * <ul>
 * <li>{@code -Dsde.cp.buildDiag=on}：打开摆放失败现场探针。取值为 {@code on} / {@code true} /
 * {@code 1} / {@code yes}（大小写不敏感、两端空白忽略）时为开，其余一切取值（含未设置）为关。
 * 关闭时全部探针调用点都是「读属性 + 直接跳过」，不产生日志、不触碰世界对象。</li>
 * <li>{@code -Dsde.cp.buildChunkQuietGateTicks=N}（N &gt; 0）：打开 chunk 静默门——场景构建开始前
 * 先等 chunk provider 安静（见 {@link #chunkQuiet}），连续安静若干 tick 才放行；累计超过 N tick
 * 仍不安静则<b>响亮报错</b>（{@code CP-EXEC-001}），绝不无限静默等待。</li>
 * </ul>
 *
 * <h2>反射与异常口径</h2>
 * 所有反射读取都逐条 try/catch 兜底，任何情况下<b>不得因诊断代码抛出新的异常</b>：读不到的字段以
 * {@code <absent>} / {@code <err:...>} 形式落进探针串，{@link #chunkQuiet} 在观测不可用时
 * 记一次 WARN 并按「放行」降级（见其 javadoc）。
 */
public final class BuildDiagnostics {

    /** 摆放失败现场探针的开关属性。 */
    public static final String PROP_DIAG = "sde.cp.buildDiag";

    /** chunk 静默门上限（tick）的属性；未设/非法/≤0 = 门关闭。 */
    public static final String PROP_QUIET_GATE_TICKS = "sde.cp.buildChunkQuietGateTicks";

    /** 原版（1.7.10 vanilla/MCP）里「同一 chunk 正在加载」的布尔保护字段名。 */
    private static final String FIELD_LOADING_CHUNK = "loadingChunk";

    /**
     * 本树运行期 jar 里实际存在的等价保护字段名（Forge 的 chunk 加载补丁把它换成了
     * {@code Set<Long>}）——探针与静默门都读它，理由见 {@link #chunkQuiet}。
     */
    private static final String FIELD_LOADING_CHUNKS = "loadingChunks";

    /** 观测不可用的 WARN 只打一次（避免每 tick 刷屏）。 */
    private static final AtomicBoolean UNOBSERVABLE_WARNED = new AtomicBoolean(false);

    /** 字段缺席的占位串。 */
    private static final String ABSENT = "<absent>";

    private BuildDiagnostics() {}

    /**
     * 探针总开关：JVM 属性 {@code sde.cp.buildDiag} 取值为 on / true / 1 / yes 之一（大小写不敏感、trim）。
     *
     * @return 仅当属性取值为上述四者之一时为 {@code true}；未设置/空/其它取值/属性不可读为 {@code false}
     */
    public static boolean diagEnabled() {
        String raw = property(PROP_DIAG);
        if (raw == null) {
            return false;
        }
        String v = raw.trim();
        return "on".equalsIgnoreCase(v) || "true".equalsIgnoreCase(v) || "1".equals(v) || "yes".equalsIgnoreCase(v);
    }

    /**
     * chunk 静默门上限：JVM 属性 {@code sde.cp.buildChunkQuietGateTicks} 解析为正 int。
     *
     * @return 未设置 / 非法 / ≤0 一律返回 {@code 0}（门关闭）
     */
    public static int quietGateMaxTicks() {
        String raw = property(PROP_QUIET_GATE_TICKS);
        if (raw == null) {
            return 0;
        }
        try {
            int v = Integer.parseInt(raw.trim());
            return v > 0 ? v : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    /**
     * 一行紧凑的现场探针串：当前线程名、世界实例 hash、集成服实例 hash 与运行态、chunk provider 类简名、
     * 已加载 chunk 数，以及「同一 chunk 正在加载」保护的读数。
     *
     * <p>
     * 保护字段的读取顺序：先读原版布尔字段 {@code loadingChunk}；读不到时把 provider 类（含父类）所有
     * {@code boolean} 型声明字段的「名=值」对 dump 进探针（兜底可观测）。此外只要
     * {@code loadingChunks} 读得到就追加 {@code loadingChunks=<集合大小>}——本树运行期 jar
     * （{@code recompiled_minecraft-1.7.10.jar}，javap 实查）里 Forge 补丁用的就是这个
     * {@code Set<Long> loadingChunks}，原版布尔字段并不存在，只 dump boolean 会看不到任何加载态信号。
     *
     * <p>
     * 全程 try/catch：任何一段读不出来都只把 {@code <err:...>} 写进串里，绝不抛异常、绝不返回 null。
     *
     * @param w 服务端权威世界；可为 null
     * @return 单行探针串（永不为 null）
     */
    public static String probe(WorldServer w) {
        StringBuilder sb = new StringBuilder(192);
        try {
            sb.append("thread=")
                .append(
                    Thread.currentThread()
                        .getName());
        } catch (Throwable t) {
            sb.append("thread=")
                .append(errName(t));
        }
        try {
            sb.append(" world=")
                .append(w == null ? "null" : String.valueOf(System.identityHashCode(w)))
                .append(" dim=")
                .append(w == null ? "?" : Integer.toString(w.provider.dimensionId));
        } catch (Throwable t) {
            sb.append(" world=")
                .append(errName(t));
        }
        try {
            MinecraftServer server = MinecraftServer.getServer();
            sb.append(" server=")
                .append(server == null ? "null" : String.valueOf(System.identityHashCode(server)))
                .append(" serverRunning=")
                .append(server == null ? "<server=null>" : String.valueOf(server.isServerRunning()));
        } catch (Throwable t) {
            sb.append(" server=")
                .append(errName(t));
        }
        IChunkProvider provider = providerOf(w);
        sb.append(" provider=")
            .append(provider == null ? "null" : simpleName(provider.getClass()));
        if (provider == null) {
            return sb.toString();
        }
        if (provider instanceof ChunkProviderServer) {
            try {
                sb.append(" loadedChunks=")
                    .append(
                        ((ChunkProviderServer) provider).loadedChunks == null ? "null"
                            : Integer.toString(((ChunkProviderServer) provider).loadedChunks.size()));
            } catch (Throwable t) {
                sb.append(" loadedChunks=")
                    .append(errName(t));
            }
        }
        Object loadingChunk = readField(provider, FIELD_LOADING_CHUNK);
        if (loadingChunk instanceof Boolean) {
            sb.append(" loadingChunk=")
                .append(loadingChunk);
        } else {
            sb.append(" loadingChunk=")
                .append(ABSENT)
                .append(" booleans={")
                .append(dumpBooleanFields(provider))
                .append('}');
        }
        Object loadingChunks = readField(provider, FIELD_LOADING_CHUNKS);
        if (loadingChunks instanceof Collection) {
            try {
                sb.append(" loadingChunks=")
                    .append(Integer.toString(((Collection<?>) loadingChunks).size()));
            } catch (Throwable t) {
                sb.append(" loadingChunks=")
                    .append(errName(t));
            }
        }
        return sb.toString();
    }

    /**
     * 摆放失败现场的 WARN（探针串一并落日志）。
     *
     * <p>
     * 调用点必须自行用 {@link #diagEnabled()} 门控——本方法不做门控判断（便于将来在别的诊断口复用）。
     *
     * @param what   失败类别，如 {@code block-mismatch} / {@code te-absent}
     * @param w      现场世界（可为 null）
     * @param detail 现场细节（步骤号、坐标、期望值/实际值等）
     */
    public static void logFailure(String what, WorldServer w, String detail) {
        CpLog.warn("%s：%s | %s", what, detail, probe(w));
    }

    /**
     * chunk provider 是否「安静」（没有 chunk 加载在途）——chunk 静默门的判据。
     *
     * <p>
     * 读取顺序：
     * <ol>
     * <li>原版布尔字段 {@code loadingChunk}（反射，setAccessible）：{@code false} 即安静；</li>
     * <li>读不到时读 {@code loadingChunks}（{@code Collection}）：空 = 无加载在途 = 安静。
     * 这不是随手加的名字：本树运行期 jar 的 {@code ChunkProviderServer} 经 Forge chunk 加载补丁后
     * <b>只有</b> {@code Set<Long> loadingChunks}（javap 实查），原版布尔字段不存在；只按第 1 步判会
     * 永久落到第 3 步「降级放行」，门就永远等于关闭——那不是本器具的意图；</li>
     * <li>两个字段都读不到 = <b>观测不可用</b>：记一次 WARN，然后返回 {@code true}（放行）。
     * 这是刻意的降级决策——诊断器具不能把「看不见」变成「卡死」：宁可让构建照旧跑（回到今天的行为），
     * 也不让一个读数失败把整条管线拖进超时。WARN 的存在保证这次放行在日志里可见、不会被误读成「安静」。</li>
     * </ol>
     *
     * <p>
     * 全程 try/catch：本方法绝不抛异常。跨线程读一个正在被服务端线程改动的集合只做 {@code isEmpty()}
     * 这种无迭代的读，是「尽力观测」而非同步读——只用于诊断与有限等待。
     *
     * @param w 服务端权威世界；可为 null（视为观测不可用 → WARN + 放行）
     * @return 安静为 {@code true}；观测不可用时也返回 {@code true}（降级放行，且已 WARN 过一次）
     */
    public static boolean chunkQuiet(WorldServer w) {
        IChunkProvider provider = providerOf(w);
        if (provider != null) {
            try {
                Object loadingChunk = readField(provider, FIELD_LOADING_CHUNK);
                if (loadingChunk instanceof Boolean) {
                    return !((Boolean) loadingChunk).booleanValue();
                }
                Object loadingChunks = readField(provider, FIELD_LOADING_CHUNKS);
                if (loadingChunks instanceof Collection) {
                    return ((Collection<?>) loadingChunks).isEmpty();
                }
            } catch (Throwable t) {
                // 落到下面「观测不可用 → WARN + 放行」
            }
        }
        warnUnobservableOnce(w);
        return true;
    }

    // ------------------------------------------------------------ 内部

    /** 读 JVM 属性；属性不可读（SecurityManager 等）时返回 null。 */
    private static String property(String name) {
        try {
            return System.getProperty(name);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 世界 → chunk provider；判空与异常都收敛成 null。 */
    private static IChunkProvider providerOf(WorldServer w) {
        if (w == null) {
            return null;
        }
        try {
            return w.getChunkProvider();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 类简名；匿名类/局部类简名为空时退回全限定名。 */
    private static String simpleName(Class<?> c) {
        try {
            String s = c.getSimpleName();
            return s == null || s.isEmpty() ? c.getName() : s;
        } catch (Throwable t) {
            return errName(t);
        }
    }

    /**
     * 反射读一个字段（含父类链）。取不到（无此字段 / 不可访问 / 读取本身出错）一律返回 null——
     * 调用方用 {@code instanceof} 区分「缺席」与「值恰好为 null」。
     */
    private static Object readField(Object target, String name) {
        if (target == null) {
            return null;
        }
        try {
            Field f = findField(target.getClass(), name);
            if (f == null) {
                return null;
            }
            f.setAccessible(true);
            return f.get(target);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 沿类层次（含父类）找声明字段；找不到返回 null。 */
    private static Field findField(Class<?> c, String name) {
        for (Class<?> k = c; k != null && k != Object.class; k = k.getSuperclass()) {
            try {
                return k.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
                // 继续往父类找
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    /** 把 provider 类（含父类）所有 boolean 型声明字段 dump 成 {@code 名=值,名=值}；空则为 {@code <none>}。 */
    private static String dumpBooleanFields(Object target) {
        StringBuilder sb = new StringBuilder(64);
        try {
            boolean first = true;
            for (Class<?> c = target.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
                for (Field f : c.getDeclaredFields()) {
                    if (f.getType() != boolean.class) {
                        continue;
                    }
                    String v;
                    try {
                        f.setAccessible(true);
                        v = String.valueOf(f.getBoolean(target));
                    } catch (Throwable t) {
                        v = errName(t);
                    }
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    sb.append(f.getName())
                        .append('=')
                        .append(v);
                }
            }
        } catch (Throwable t) {
            return errName(t);
        }
        return sb.length() == 0 ? "<none>" : sb.toString();
    }

    /** 观测不可用的 WARN，每个 JVM 只打一次。 */
    private static void warnUnobservableOnce(WorldServer w) {
        if (!UNOBSERVABLE_WARNED.compareAndSet(false, true)) {
            return;
        }
        CpLog.warn("chunk 静默门：读不到 chunk provider 的 loadingChunk/loadingChunks（观测不可用）——按「放行」降级处理 | %s", probe(w));
    }

    /** 探针里的错误占位：{@code <err:SimpleName>}。 */
    private static String errName(Throwable t) {
        String n;
        try {
            n = t == null ? "null"
                : t.getClass()
                    .getSimpleName();
        } catch (Throwable ignored) {
            n = "Throwable";
        }
        return "<err:" + (n == null || n.isEmpty() ? "Throwable" : n) + ">";
    }
}
