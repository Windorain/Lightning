package com.lightning.mod.client.meshcapture;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import net.minecraft.client.renderer.RenderBlocks;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 离屏网格捕获与「正常世界方块渲染管线」的差异整理（<strong>与具体模组无关的共性</strong>）：
 * <ol>
 * <li><strong>坐标语义</strong>：捕获循环使用结构索引格，{@link net.minecraft.world.IBlockAccess} 包装器必须同时支持「结构格 → 世界」与「已是世界格」的查询（见
 * {@link WorldDelegatingBlockAccess}）。任意在 ISBRH 里用 TE
 * 世界坐标查块的实现都会踩同一类问题。</li>
 * <li><strong>渲染状态生命周期</strong>：世界里渲染一块方块前，往往已经过渲染 pass、区块构建器、方块自身的 {@code canRenderInPass} 等对客户端状态的写入。捕获路径若只调用
 * {@link RenderBlocks#renderBlockByRenderType}，则<strong>不会自动</strong>执行这些前置步骤。凡把几何委托到<strong>另一份</strong>{@link RenderBlocks}（例如
 * {@code ThreadLocal} 单例）并在其上维护「是否允许画」之类状态的 ISBRH，在离屏调用时可能出现主线程 {@link net.minecraft.client.renderer.Tessellator}
 * 始终收不到顶点——这是<strong>管线缺口</strong>，不是某一方块 ID 的特例逻辑。</li>
 * </ol>
 * 本类在每次捕获绘制前运行已注册的 {@link Hook}，用于补上与「当前主 {@link RenderBlocks}」相关的、可安全重复的初始化；具体模组若仍不满足，可再注册自定义 Hook（或向本仓库贡献通用探测逻辑）。
 */
@SideOnly(Side.CLIENT)
public final class MeshCaptureRenderPreparation {

    /**
     * 在 {@link RenderBlocks#renderBlockByRenderType} 之前调用，入参即捕获使用的「主」{@link RenderBlocks}（已设好 {@code blockAccess} 等）。
     */
    public interface Hook {

        void prepare(RenderBlocks primary);
    }

    private static final List<Hook> HOOKS = new CopyOnWriteArrayList<>();

    static {
        HOOKS.add(new ReflectiveThreadLocalRenderBlocksStateHook());
    }

    private MeshCaptureRenderPreparation() {}

    /** 供模组或集成在运行时追加（应幂等、轻量）。 */
    public static void registerHook(Hook hook) {
        if (hook != null) {
            HOOKS.add(hook);
        }
    }

    public static void beforeBlockRender(RenderBlocks primary) {
        for (Hook h : HOOKS) {
            try {
                h.prepare(primary);
            } catch (Throwable ignored) {
                // Hook 自身应健壮；失败不影响其它 Hook
            }
        }
    }

    /**
     * 内置 Hook：反射探测「委托到 ThreadLocal {@link RenderBlocks} 且依赖渲染 pass 状态」的常见实现；若相关类存在则同步 pass、全侧面与
     * blockAccess。未安装对应模组时为空操作。
     */
    private static final class ReflectiveThreadLocalRenderBlocksStateHook implements Hook {

        private final Object resolveLock = new Object();
        private volatile boolean resolved;
        private Field busHelperInstancesField;
        private Method busHelperSetPassMethod;
        private Field busRendererInstanceField;
        private Method busRendererGetRendererMethod;
        private Field renderBlocksRenderAllFacesField;
        private Field renderBlocksBlockAccessField;

        @Override
        public void prepare(RenderBlocks primary) {
            synchronized (resolveLock) {
                if (!resolved) {
                    resolve();
                    resolved = true;
                }
            }
            if (busHelperSetPassMethod != null && busHelperInstancesField != null) {
                try {
                    @SuppressWarnings("unchecked")
                    ThreadLocal<Object> tl = (ThreadLocal<Object>) busHelperInstancesField.get(null);
                    Object helper = tl != null ? tl.get() : null;
                    if (helper != null) {
                        busHelperSetPassMethod.invoke(helper, 0);
                    }
                } catch (Throwable ignored) {
                    // 类未加载或 API 变更
                }
            }
            if (busRendererInstanceField != null && busRendererGetRendererMethod != null
                && renderBlocksRenderAllFacesField != null) {
                try {
                    Object delegateRendererOwner = busRendererInstanceField.get(null);
                    if (delegateRendererOwner != null) {
                        Object delegateRb = busRendererGetRendererMethod.invoke(delegateRendererOwner);
                        if (delegateRb != null) {
                            renderBlocksRenderAllFacesField.setBoolean(delegateRb, true);
                            if (primary != null && primary.blockAccess != null
                                && renderBlocksBlockAccessField != null) {
                                try {
                                    renderBlocksBlockAccessField.set(delegateRb, primary.blockAccess);
                                } catch (Throwable ignored) {
                                    // 保持与主 RB 一致失败则仅依赖 ISBRH 内既有赋值
                                }
                            }
                        }
                    }
                } catch (Throwable ignored) {
                    // ignore
                }
            }
        }

        private void resolve() {
            Field blockAccessField = null;
            try {
                blockAccessField = RenderBlocks.class.getField("blockAccess");
            } catch (Throwable ignored) {
                // ignore
            }
            renderBlocksBlockAccessField = blockAccessField;
            try {
                Class<?> busHelper = Class.forName("appeng.client.render.BusRenderHelper");
                busHelperInstancesField = busHelper.getField("instances");
                busHelperSetPassMethod = busHelper.getMethod("setPass", int.class);
            } catch (Throwable t) {
                busHelperInstancesField = null;
                busHelperSetPassMethod = null;
            }
            try {
                Class<?> busRenderer = Class.forName("appeng.client.render.BusRenderer");
                busRendererInstanceField = busRenderer.getField("INSTANCE");
                busRendererGetRendererMethod = busRenderer.getMethod("getRenderer");
                Class<?> rbClass = Class.forName("net.minecraft.client.renderer.RenderBlocks");
                renderBlocksRenderAllFacesField = rbClass.getField("renderAllFaces");
            } catch (Throwable t) {
                busRendererInstanceField = null;
                busRendererGetRendererMethod = null;
                renderBlocksRenderAllFacesField = null;
            }
        }
    }
}
