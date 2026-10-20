package com.lightning.mod.client.meshcapture;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import net.minecraft.client.Minecraft;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;
import net.minecraftforge.common.util.ForgeDirection;

/**
 * 临时诊断（**诊断用，非修复**；Gitea #410 的根因判别实验器具）。
 *
 * <p>
 * 两件事，都只读、都只在客户端线程：
 * <ol>
 * <li>{@link #dump} 在逐格捕获的渲染前后打印该 TE 的渲染状态（{@code [LP-DIAG]}），
 * 用于定性「旧渲染器兜底」vs「渲染列表已编译」；</li>
 * <li>{@link #probeTick} 按 {@code -Dsde.lpProbe=x,y,z} 指定的坐标，每 N 个客户端 tick
 * 打一行**客户端世界**里的 TE 状态（{@code [LP-PROBE]}）——**不触碰服务端 TE**，
 * 因此不会与 LP 的 router 锁产生任何交叠（{@code read.te} 的 writeToNBT 会）。</li>
 * </ol>
 *
 * <p>
 * <b>为什么要打印 {@code initialized} 与 {@code pipeConnectionsBuffer}</b>：LP 的渲染矩阵
 * （{@code renderState.pipeConnectionMatrix}）只由 {@code PipeTileStatePacket}
 * （S35 description，{@code PipeRenderState.readData}）填；而客户端 TE 自身
 * {@code updateEntity} 里还会重算 {@code pipeConnectionsBuffer}。两者同时读出来，
 * 「客户端有自己的连接推断」与「客户端收到了服务端包」就不再混为一谈（E2 的断点判别）。
 */
public final class LpPipeCaptureDiag {

    private static final boolean ENABLED = !"0".equals(System.getProperty("sde.lpDiag", "1"));

    /**
     * 探针坐标来源：优先 {@code -Dsde.lpProbe=x,y,z}，否则读 run 目录下的 {@code lp-probe.txt}
     * （内容一行 {@code x,y,z}）。后者的用意是<b>运行期可改</b>——实验中途换目标不必重启客户端。
     */
    private static final String PROBE_PROP = System.getProperty("sde.lpProbe", null);

    /** 探针坐标文件（相对 mcDataDir）。 */
    private static final String PROBE_FILE = "lp-probe.txt";

    /** 探针节拍（tick）。 */
    private static final int PROBE_INTERVAL = Integer.getInteger("sde.lpProbeInterval", 20).intValue();

    private static int tickCounter;

    private LpPipeCaptureDiag() {}

    // ------------------------------------------------------------ 捕获期 dump

    public static void dump(String phase, TileEntity te, int wx, int wy, int wz) {
        if (!ENABLED || te == null) {
            return;
        }
        String cn = te.getClass()
            .getName();
        if (!cn.startsWith("logisticspipes")) {
            return;
        }
        StringBuilder sb = new StringBuilder("[LP-DIAG] ").append(phase)
            .append(' ')
            .append(cn)
            .append(" @")
            .append(wx)
            .append(',')
            .append(wy)
            .append(',')
            .append(wz);
        sb.append(" copy{");
        appendState(sb, te);
        sb.append(" }");
        // 同一格上**活动客户端世界**里的那个 TE（捕获渲染用的可能不是它）
        TileEntity active = null;
        try {
            net.minecraft.client.Minecraft mc = net.minecraft.client.Minecraft.getMinecraft();
            if (mc != null && mc.theWorld != null) {
                active = mc.theWorld.getTileEntity(wx, wy, wz);
            }
        } catch (Throwable t) {
            sb.append(" active=ERR ")
                .append(t);
        }
        if (active != null) {
            sb.append(" active{same=")
                .append(active == te)
                .append(' ');
            appendState(sb, active);
            sb.append(" }");
        } else {
            sb.append(" active=null");
        }
        System.out.println(sb);
    }

    // ------------------------------------------------------------ 客户端周期探针

    /**
     * 客户端每 tick 调一次（由 {@code ControlPlaneTickHandler} 在作业排空之后调用）。
     * 只在 {@code sde.lpProbe} 就位且客户端世界可用时工作，其余情形是空操作。
     */
    public static void probeTick(Minecraft mc) {
        if (!ENABLED || mc == null) {
            return;
        }
        if (++tickCounter % PROBE_INTERVAL != 0) {
            return;
        }
        int[] at = parseSpec(resolveSpec(mc));
        if (at == null) {
            return;
        }
        World w = mc.theWorld;
        if (w == null) {
            return;
        }
        TileEntity te = null;
        try {
            te = w.getTileEntity(at[0], at[1], at[2]);
        } catch (Throwable t) {
            System.out.println("[LP-PROBE] getTileEntity 失败: " + t);
            return;
        }
        StringBuilder sb = new StringBuilder("[LP-PROBE] t=")
            .append(tickCounter)
            .append(" @")
            .append(at[0])
            .append(',')
            .append(at[1])
            .append(',')
            .append(at[2]);
        if (te == null) {
            sb.append(" te=null");
        } else {
            sb.append(' ')
                .append(te.getClass().getName());
            appendState(sb, te);
        }
        System.out.println(sb);
    }

    /** 坐标来源：系统属性优先，其次 run 目录的 {@code lp-probe.txt}。 */
    private static String resolveSpec(Minecraft mc) {
        if (PROBE_PROP != null && !PROBE_PROP.trim().isEmpty()) {
            return PROBE_PROP;
        }
        try {
            java.io.File f = new java.io.File(mc.mcDataDir, PROBE_FILE);
            if (!f.isFile()) {
                return null;
            }
            String s = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8").trim();
            return s.isEmpty() ? null : s;
        } catch (Throwable t) {
            return null;
        }
    }

    private static int[] parseSpec(String spec) {
        if (spec == null) {
            return null;
        }
        String[] parts = spec.split(",");
        if (parts.length != 3) {
            return null;
        }
        try {
            return new int[] { Integer.parseInt(parts[0].trim()), Integer.parseInt(parts[1].trim()),
                Integer.parseInt(parts[2].trim()) };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // ------------------------------------------------------------ 状态拼装

    private static void appendState(StringBuilder sb, TileEntity te) {
        try {
            Object pipe = field(te, "pipe");
            sb.append(" pipeClass=")
                .append(pipe == null ? "null" : pipe.getClass().getSimpleName());
            sb.append(" init=")
                .append(pipe == null ? "?" : String.valueOf(declaredField(pipe, "initialized")));
            sb.append(" buf=")
                .append(dirString(field(te, "pipeConnectionsBuffer")));
            Object rs = field(te, "renderState");
            if (rs == null) {
                sb.append(" renderState=null");
            } else {
                Object list = field(rs, "renderList");
                if (list == null) {
                    sb.append(" list=null");
                } else {
                    sb.append(" list(filled=")
                        .append(inv(list, "isFilled"))
                        .append(",invalid=")
                        .append(inv(list, "isInvalid"))
                        .append(')');
                }
                sb.append(" cached=")
                    .append(field(rs, "cachedRenderer") != null);
                sb.append(" old=")
                    .append(field(rs, "forceRenderOldPipe"));
                Object cm = field(rs, "pipeConnectionMatrix");
                if (cm != null) {
                    sb.append(" conn=")
                        .append(matrixString(cm));
                }
                Object tm = field(rs, "textureMatrix");
                if (tm != null) {
                    sb.append(" routed=")
                        .append(inv(tm, "isRouted"));
                }
            }
        } catch (Throwable t) {
            sb.append(" ERR ")
                .append(t);
        }
    }

    /** {@code boolean[6]}（ForgeDirection 序 DOWN,UP,NORTH,SOUTH,WEST,EAST）→ 字母串，全 false 记 "-"。 */
    private static String dirString(Object arr) {
        if (!(arr instanceof boolean[])) {
            return "?";
        }
        boolean[] a = (boolean[]) arr;
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < a.length && i < ForgeDirection.VALID_DIRECTIONS.length; ++i) {
            if (a[i]) {
                s.append(
                    ForgeDirection.VALID_DIRECTIONS[i].name()
                        .charAt(0));
            }
        }
        return s.length() == 0 ? "-" : s.toString();
    }

    private static String matrixString(Object cm) throws Exception {
        StringBuilder dirs = new StringBuilder();
        Method m = cm.getClass()
            .getMethod("isConnected", ForgeDirection.class);
        for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
            Object r = m.invoke(cm, d);
            if (Boolean.TRUE.equals(r)) {
                dirs.append(d.name().charAt(0));
            }
        }
        return dirs.length() == 0 ? "-" : dirs.toString();
    }

    private static Object field(Object owner, String name) throws Exception {
        Field f = owner.getClass()
            .getField(name);
        return f.get(owner);
    }

    /** 读**私有**字段（{@code CoreUnroutedPipe.initialized} 就是私有的）。 */
    private static Object declaredField(Object owner, String name) throws Exception {
        Class<?> c = owner.getClass();
        while (c != null) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(owner);
            } catch (NoSuchFieldException e) {
                c = c.getSuperclass();
            }
        }
        return "no-such-field:" + name;
    }

    private static Object inv(Object owner, String method) throws Exception {
        Method m = owner.getClass()
            .getMethod(method);
        return m.invoke(owner);
    }
}
