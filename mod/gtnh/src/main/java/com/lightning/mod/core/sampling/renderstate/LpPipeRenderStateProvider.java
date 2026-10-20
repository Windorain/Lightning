package com.lightning.mod.core.sampling.renderstate;

import java.lang.reflect.Field;

import net.minecraft.tileentity.TileEntity;

/**
 * LogisticsPipes 管道族的渲染状态承载（{@link TileRenderStateProvider} 的首个实现，Gitea #410 方向 A）。
 *
 * <h2>为什么需要</h2>
 * {@code LogisticsTileGenericPipe.writeToNBT} <b>不</b>持久化 {@code PipeRenderState}（运行期
 * 1.5.28-GTNH 的 dev jar 逐个方法核对：只写 {@code pipeId} + {@code pipe.writeToNBT}（在途物品列表）+
 * tilePart + turtleConnect + logicController），连接矩阵/贴图矩阵只走 LP 自己的
 * {@code PipeTileStatePacket}（S35 description）下发。捕获层按扫描 NBT 造副本 TE（issue #12 的
 * 「活动 TE 零写入」），副本因此矩阵全 false ⇒ 导出无连接臂、无 {@code -status}/{@code -inactive} 层。
 *
 * <h2>为什么用 LP 自己的同步格式</h2>
 * 序列化的就是「客户端本该收到的那个包」的 payload：{@code PipeRenderState.writeData(LPDataOutputStream)}
 * 写出的字节。回填侧用同一个类的 {@code readData(LPDataInputStream)} 原样读回，语义上与 LP 客户端
 * 收到 {@code PipeTileStatePacket} 后做的事逐字相同——不是「从静态数据推算外观」（#55 禁令），也不是
 * 第二套外观权威。
 *
 * <h2>纯序列化证据（运行期 dev jar 1.5.28-GTNH，LineNumberTable 核对）</h2>
 * <ul>
 * <li>{@code PipeRenderState.writeData}（源码行 66-69）：只有三条委托——
 * {@code ConnectionMatrix.writeData}、{@code TextureMatrix.writeData}、{@code IBCRenderState.writeData_LP}；
 * 方法体内<b>没有</b>任何 {@code putfield}（未置 {@code dirty}/{@code forceRenderOldPipe} 等标志）；</li>
 * <li>{@code ConnectionMatrix.writeData}（源码行 78-81）：只 {@code writeByte} 三个掩码字段；</li>
 * <li>{@code TextureMatrix.writeData}（源码行 123-134）：只写 iconIndexes/textureIndex/isRouted/
 * isRoutedInDir/isSubPowerInDir/hasPowerUpgrade/hasPower/isFluid/pointedOrientation；</li>
 * <li>{@code LPBCPipeRenderState.writeData_LP}（源码行 15-19）：写一个 boolean + BC {@code writeData(ByteBuf)}，
 * 同样只读自身字段。</li>
 * </ul>
 * 因此扫描期调用它对活动 TE 是<b>只读</b>的；本类<b>不</b>调用 {@code getLPDescriptionPacket} /
 * {@code sendUpdateToClient} / {@code scheduleNeighborChange}（它们会触碰标志位或发包）。
 *
 * <h2>为什么全反射</h2>
 * LP 在本树只是 {@code runtimeOnlyNonPublishable} 依赖（{@code dependencies.gradle:82}），编译期没有
 * LP 类型可 import；与 {@code LpPipeCompleter}/{@code LpPipeCaptureDiag} 的既有做法一致，类名以字符串
 * 持有，只在真正遇到该族 TE 时才触达 LP 类。
 */
public final class LpPipeRenderStateProvider implements TileRenderStateProvider {

    /** 状态格式标识（含格式版本：LP 若改了 writeData 布局，这里应升版而不是静默误读）。 */
    public static final String FORMAT = "logisticspipes.pipe-render-state/v1";

    /** LP 管道 TE 类（唯一承载 {@code PipeRenderState} 的方块实体）。 */
    private static final String TILE_CLASS = "logisticspipes.pipes.basic.LogisticsTileGenericPipe";

    /** TE 上的渲染状态字段（{@code public final PipeRenderState renderState}）。 */
    private static final String RENDER_STATE_FIELD = "renderState";

    /** LP 自有同步格式的输入/输出流类（{@code PipeTileStatePacket} 用的就是这两个）。 */
    private static final String DATA_OUTPUT_CLASS = "logisticspipes.network.LPDataOutputStream";
    private static final String DATA_INPUT_CLASS = "logisticspipes.network.LPDataInputStream";

    /** {@code null} = 尚未解析；{@code ABSENT} = 已确认不在运行期 classpath（不再重复解析）。 */
    private static final Object ABSENT = new Object();

    private static volatile Object tileClassCache;

    @Override
    public String format() {
        return FORMAT;
    }

    @Override
    public boolean matches(TileEntity te, String registryId) {
        if (te == null) {
            return false;
        }
        Class<?> tileClass = tileClass();
        return tileClass != null && tileClass.isInstance(te);
    }

    @Override
    public byte[] write(TileEntity te) {
        Object renderState = renderStateOf(te);
        if (renderState == null) {
            return null;
        }
        Class<?> outClass = load(DATA_OUTPUT_CLASS);
        if (outClass == null) {
            return null;
        }
        try {
            Object out = outClass.getConstructor()
                .newInstance();
            renderState.getClass()
                .getMethod("writeData", outClass)
                .invoke(renderState, out);
            return (byte[]) outClass.getMethod("toByteArray")
                .invoke(out);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("LP PipeRenderState.writeData 不可用（类布局变了？）", e);
        }
    }

    @Override
    public boolean apply(TileEntity te, byte[] state) {
        Object renderState = renderStateOf(te);
        if (renderState == null) {
            return false;
        }
        Class<?> inClass = load(DATA_INPUT_CLASS);
        if (inClass == null) {
            return false;
        }
        try {
            Object in = inClass.getConstructor(byte[].class)
                .newInstance((Object) state);
            renderState.getClass()
                .getMethod("readData", inClass)
                .invoke(renderState, in);
            // LP 客户端摄取语义的等价收尾：PipeTileStatePacket.processPacket 在 readData 之后走
            // afterStateUpdated()，其中 needsRenderUpdate() 为真时 clean()（清 dirty 并重编译渲染列表）。
            // 这里只补 clean()：它不碰世界；afterStateUpdated 里的 world.markBlockRangeForRenderUpdate
            // 是给活客户端的刷新通知，对副本既无意义又会写活动世界，故不调用。
            renderState.getClass()
                .getMethod("clean")
                .invoke(renderState);
            return true;
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("LP PipeRenderState.readData 不可用（类布局变了？）", e);
        }
    }

    /** 副本/活动 TE 的 {@code renderState} 字段（只读；{@code null} 表示该 TE 还没建状态）。 */
    private static Object renderStateOf(TileEntity te) {
        if (te == null) {
            return null;
        }
        try {
            Field f = te.getClass()
                .getField(RENDER_STATE_FIELD);
            return f.get(te);
        } catch (NoSuchFieldException e) {
            return null;
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("LP renderState 字段不可读", e);
        }
    }

    private static Class<?> tileClass() {
        Object cached = tileClassCache;
        if (cached == ABSENT) {
            return null;
        }
        if (cached != null) {
            return (Class<?>) cached;
        }
        Class<?> loaded = load(TILE_CLASS);
        tileClassCache = loaded == null ? ABSENT : loaded;
        return loaded;
    }

    private static Class<?> load(String className) {
        try {
            return Class.forName(className);
        } catch (Throwable t) {
            return null;
        }
    }
}
