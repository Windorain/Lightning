package com.lightning.mod.client.controlplane.mc;

import net.minecraft.item.Item;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * LogisticsPipes 管道 TE 的<b>运行期状态描述器</b>（族名 {@code lp-pipe}，与
 * {@link LpPipeCompleter} 同名注册）。
 *
 * <h2>输出（只读；{@code te-state-equals} 的 {@code key} 指向这棵树）</h2>
 * 
 * <pre>
 * {
 *   "te": "logisticspipes.pipes.basic.LogisticsTileGenericPipe",
 *   "pipeType": "logisticspipes:pipe_basic",                    // 管物品注册名；无管时 null
 *   "pipeClass": "logisticspipes.pipes.basic.CoreRoutedPipe",    // 管实现类；无管时 null
 *   "initialized": true,                                        // LogisticsTileGenericPipe.isInitialized()
 *   "container": true,                                          // pipe.container != null（Gitea #12 渲染 NPE 判据）
 *   "connections": {"DOWN":false,"UP":true,"NORTH":...,...},     // 服务端权威连接缓存（见下）
 *   "renderStateConnections": {...} | null,                      // 渲染器用的连接矩阵（见下）
 *   "renderStateConsistent": true | null                         // 上面两份是否逐面一致
 * }
 * </pre>
 *
 * <h2>连接态取哪一份（核实结论）</h2>
 * <ul>
 * <li><b>主口径 {@code connections}</b>：{@code LogisticsTileGenericPipe.pipeConnectionsBuffer}
 * （{@code LogisticsTileGenericPipe.java:715} 的 <b>public</b> {@code boolean[6]}）——由
 * {@code computeConnections()}（{@code :867}）填充，{@code initialize()}（{@code :745}）末尾就调用它，
 * 服务端 {@code isPipeConnected(ForgeDirection)}（{@code :897}）返回的就是这个数组。这是服务端
 * 权威状态，也是本描述器（跑在 {@code WorldServer} 上）该读的东西。</li>
 * <li><b>副口径 {@code renderStateConnections}</b>：{@code public final PipeRenderState renderState}
 * （{@code :122}）里的 {@code pipeConnectionMatrix}——渲染器实际使用的那份。它在服务端
 * {@code updateEntity()} 的 {@code refreshRenderState} 分支（{@code :238-244}）被<b>从主口径同步</b>，
 * 客户端则来自 S35 description packet。两份都读、并给出 {@code renderStateConsistent}，
 * 便于审计「渲染器看到的是不是服务端算出来的」。</li>
 * </ul>
 *
 * <p>
 * <b>不读 NBT、不做推算</b>：以上全部来自 LP 自己的运行期 API/字段（{@link TeDescriber} 的实现纪律）。
 * 方位也不硬编码 ordinal：一律用 {@code ForgeDirection.VALID_DIRECTIONS} 枚举自身的
 * {@code name()}/{@code ordinal()} 映射到缓冲区下标（与 LP 写入时的 {@code side.ordinal()} 逐字对应）。
 */
public final class LpPipeDescriber implements TeDescriber {

    /** 注册名（与 {@link LpPipeCompleter#NAME} 一致）。 */
    public static final String NAME = LpPipeCompleter.NAME;

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public JsonObject describe(WorldServer world, int x, int y, int z) {
        if (world == null) {
            return null;
        }
        Class<?> tileClass = ModReflect.cls(LpPipeCompleter.LP_TILE_CLASS);
        if (tileClass == null) {
            return null; // LP 缺席：本描述器不认领任何 TE
        }
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null || !tileClass.isInstance(te)) {
            return null;
        }
        Object pipe = ModReflect.field(te, "pipe");
        JsonObject o = new JsonObject();
        o.addProperty(
            "te",
            te.getClass()
                .getName());
        o.addProperty("pipeType", pipe == null ? null : itemId(ModReflect.field(pipe, "item")));
        o.addProperty(
            "pipeClass",
            pipe == null ? null
                : pipe.getClass()
                    .getName());
        Object init = ModReflect.call(te, "isInitialized");
        o.addProperty("initialized", init instanceof Boolean ? (Boolean) init : null);
        o.addProperty("container", pipe == null ? null : Boolean.valueOf(ModReflect.field(pipe, "container") != null));

        JsonObject buffer = connectionObject(bufferOf(te));
        JsonObject matrix = connectionObject(matrixOf(te));
        o.add("connections", buffer);
        o.add("renderStateConnections", matrix);
        o.addProperty("renderStateConsistent", consistent(buffer, matrix));
        return o;
    }

    // ------------------------------------------------------------ 读取

    /** {@code pipeConnectionsBuffer}（服务端权威连接缓存，public 字段）；不可读返回 null。 */
    private static boolean[] bufferOf(TileEntity te) {
        Object v = ModReflect.field(te, "pipeConnectionsBuffer");
        return v instanceof boolean[] ? (boolean[]) v : null;
    }

    /** {@code renderState.pipeConnectionMatrix} 逐面 {@code isConnected(dir)}；不可读返回 null。 */
    private static boolean[] matrixOf(TileEntity te) {
        Object renderState = ModReflect.field(te, "renderState");
        Object matrix = ModReflect.field(renderState, "pipeConnectionMatrix");
        if (matrix == null) {
            return null;
        }
        boolean[] out = new boolean[ForgeDirection.VALID_DIRECTIONS.length];
        for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
            Object r = ModReflect.call(matrix, "isConnected", new Class<?>[] { ForgeDirection.class }, d);
            if (!(r instanceof Boolean)) {
                return null;
            }
            out[d.ordinal()] = ((Boolean) r).booleanValue();
        }
        return out;
    }

    /**
     * 缓冲区 → {@code {DOWN:..,UP:..,...}}（六面齐全，均为布尔）；输入为 null 时返回 null。
     *
     * <p>
     * 下标由 {@code ForgeDirection} 枚举自身的 ordinal 决定（{@code VALID_DIRECTIONS} = 0..5），
     * 与 LP 的 {@code pipeConnectionsBuffer[side.ordinal()]} 写入方式逐字对应。
     */
    private static JsonObject connectionObject(boolean[] buf) {
        if (buf == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
            int idx = d.ordinal();
            o.addProperty(d.name(), Boolean.valueOf(idx < buf.length && buf[idx]));
        }
        return o;
    }

    /** 两份连接态是否逐面一致；任一不可读返回 null（不制造假一致）。 */
    private static Boolean consistent(JsonObject a, JsonObject b) {
        if (a == null || b == null) {
            return null;
        }
        for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
            if (Json.optBool(a, d.name(), false) != Json.optBool(b, d.name(), false)) {
                return Boolean.FALSE;
            }
        }
        return Boolean.TRUE;
    }

    /**
     * 物品注册名（{@code modid:name}）；不可解析返回 null。
     *
     * <p>
     * 走 {@link ModReflect#itemId(Item)}（{@code Item.itemRegistry} 是 1.7.10 的权威物品注册表）——
     * LP 自己也走它取管道注册名（{@code LpTeRoundTripAutomation} 的候选清单）。
     */
    static String itemId(Object item) {
        return item instanceof Item ? ModReflect.itemId((Item) item) : null;
    }
}
