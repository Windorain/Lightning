package com.lightning.mod.client.meshcapture.postrender;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 注册表：主批次 {@code draw} 之后的动态扩展补画通过本类 {@link #dispatch} 调度。
 * <p>
 * 内置策略（按 {@link MeshCaptureBlockPostRenderStrategy#priority()} 升序，<strong>所有</strong> {@code applies} 为 true 的均会执行）：
 * <ul>
 * <li>{@link ForgeMultipartDynamicPostRenderStrategy} — priority
 * {@value ForgeMultipartDynamicPostRenderStrategy#DEFAULT_PRIORITY}；</li>
 * <li>{@link EnderStorageTankFramePostRenderStrategy} — priority
 * {@value EnderStorageTankFramePostRenderStrategy#DEFAULT_PRIORITY}（只对"模型数据可只读反射取到"的储罐参与）；</li>
 * <li>{@link TileEntitySpecialRendererPostRenderStrategy} — priority
 * {@value TileEntitySpecialRendererPostRenderStrategy#DEFAULT_PRIORITY}。</li>
 * </ul>
 * 自定义策略：实现 {@link MeshCaptureBlockPostRenderStrategy}，{@code priority} 取更小值以优先检测；在
 * {@link MeshCaptureBlockPostRenderStrategy#renderPostMainBlock} 内可委托
 * {@link ForgeMultipartDynamicPostRenderStrategy#renderDynamicPartsIfMultipart(MeshCaptureBlockPostRenderContext)}。
 * 于客户端 init 调用 {@link #register(MeshCaptureBlockPostRenderStrategy)} 一次即可。
 * <p>
 * <strong>策略只产真几何</strong>：本表是把<strong>真实渲染器写出的几何</strong>接进捕获窗口的地方，不是给画不出来的
 * 方块补一个"像样的替代品"的地方。策略的成功标准只有一条——写出与真渲染器等价的顶点；取不到就<strong>整条不参与</strong>
 * （{@code applies} 返回 false，或运行时放弃写出且不留半份几何），让这一格照常落到
 * {@link com.lightning.mod.client.meshcapture.zeroproduce.ZeroProducePolicyRegistry} 的零产出裁决与兜底。
 * <p>
 * 禁止在此画简化块、示意立方体、包围盒或任何"差不多"的替代几何：那种东西会把"读不到"伪装成"读到了"——产物里两者
 * 再也分不出来，而兜底占位至少会带着 {@code captureIssue} 与 {@code placeholderCells} 把缺口摆在明面上。
 */
@SideOnly(Side.CLIENT)
public final class MeshCaptureBlockPostRenderRegistry {

    private static final CopyOnWriteArrayList<MeshCaptureBlockPostRenderStrategy> STRATEGIES = new CopyOnWriteArrayList<>();

    static {
        register(new ForgeMultipartDynamicPostRenderStrategy());
        register(new EnderStorageTankFramePostRenderStrategy());
        register(new TileEntitySpecialRendererPostRenderStrategy());
    }

    private MeshCaptureBlockPostRenderRegistry() {}

    /** 注册策略；集成模组在客户端 init 调用即可。 */
    public static void register(MeshCaptureBlockPostRenderStrategy strategy) {
        if (strategy != null) {
            STRATEGIES.add(strategy);
        }
    }

    /**
     * 按 priority 升序，对<strong>所有</strong> {@code applies} 为 true 的策略依次执行
     * {@link MeshCaptureBlockPostRenderStrategy#renderPostMainBlock}。
     */
    public static void dispatch(MeshCaptureBlockPostRenderContext ctx) {
        if (ctx == null) {
            return;
        }
        List<MeshCaptureBlockPostRenderStrategy> sorted = new ArrayList<>(STRATEGIES);
        sorted.sort(Comparator.comparingInt(MeshCaptureBlockPostRenderStrategy::priority));
        for (MeshCaptureBlockPostRenderStrategy s : sorted) {
            try {
                if (s.applies(ctx)) {
                    s.renderPostMainBlock(ctx);
                }
            } catch (Throwable t) {
                FMLLog.warning(
                    "[SDE] MeshCaptureBlockPostRenderRegistry: strategy %s failed: %s",
                    s.getClass()
                        .getName(),
                    t.getMessage());
            }
        }
    }
}
