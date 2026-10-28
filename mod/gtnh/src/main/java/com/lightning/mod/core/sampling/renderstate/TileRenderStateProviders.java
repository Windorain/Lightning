package com.lightning.mod.core.sampling.renderstate;

import java.util.concurrent.CopyOnWriteArrayList;

import net.minecraft.tileentity.TileEntity;

import cpw.mods.fml.common.FMLLog;

/**
 * 渲染状态提供者注册表（模组族渲染状态的声明式扩展点）。
 *
 * <p>
 * 内置 {@link LpPipeRenderStateProvider}（LogisticsPipes 管道，首个承载族）与
 * {@link EnderStorageTankRenderStateProvider}（末影储罐的液面与阀门角）。其它模组族若要承载
 * 「渲染状态不进 NBT」的 TE，实现 {@link TileRenderStateProvider} 并在 init 期
 * {@link #register(TileRenderStateProvider)} 一次即可——扫描与捕获两侧都会自动走它，不需要在
 * 采样器/捕获器里加任何族专属分支。
 *
 * <p>
 * 两侧调用点：
 * <ul>
 * <li>扫描侧 {@code PolicyBackedBlockSampler} → {@link #sample(TileEntity, String)}（服务端线程）；</li>
 * <li>捕获侧 {@code MeshCaptureService.createCaptureTileEntityCopy} → {@link #apply(String, TileEntity, byte[])}
 * （客户端线程，作用的永远是<b>副本</b> TE）。</li>
 * </ul>
 *
 * <p>
 * 失败策略：任何提供者异常都<b>不</b>中断采样/导出——退化成「该格没有渲染状态」（= 修复前的行为），
 * 并且一定打警告；否则「某模组换了实现」会让整次导出静默变空或直接崩，比缺一条臂更糟。
 */
public final class TileRenderStateProviders {

    private static final CopyOnWriteArrayList<TileRenderStateProvider> PROVIDERS = new CopyOnWriteArrayList<>();

    static {
        register(new LpPipeRenderStateProvider());
        register(new EnderStorageTankRenderStateProvider());
    }

    private TileRenderStateProviders() {}

    /** 注册提供者（按 {@link TileRenderStateProvider#format()} 去重；重复注册是幂等的）。 */
    public static void register(TileRenderStateProvider provider) {
        if (provider == null) {
            return;
        }
        String format = provider.format();
        if (format == null || format.isEmpty()) {
            return;
        }
        for (TileRenderStateProvider existing : PROVIDERS) {
            if (format.equals(existing.format())) {
                return;
            }
        }
        PROVIDERS.add(provider);
    }

    /**
     * 扫描侧：按首个匹配的提供者采样活动 TE 的渲染状态。
     *
     * @return 非空即「本格带渲染状态」；无匹配/无状态/采样失败均为 {@code null}
     */
    public static RenderStateSample sample(TileEntity te, String registryId) {
        if (te == null) {
            return null;
        }
        for (TileRenderStateProvider provider : PROVIDERS) {
            try {
                if (!provider.matches(te, registryId)) {
                    continue;
                }
                byte[] bytes = provider.write(te);
                if (bytes == null || bytes.length == 0) {
                    return null;
                }
                return new RenderStateSample(provider.format(), bytes);
            } catch (Throwable t) {
                // 采样失败只丢这一格的渲染状态，绝不中止扫描（活动 TE 未被写入）
                FMLLog.warning("[SDE] 渲染状态采样失败（%s；该格按无渲染状态导出）: %s", provider.format(), String.valueOf(t));
                return null;
            }
        }
        return null;
    }

    /**
     * 捕获侧：按快照里的格式串把字节回填到<b>副本</b> TE。
     *
     * @return 是否回填成功
     */
    public static boolean apply(String format, TileEntity te, byte[] state) {
        if (te == null || state == null || state.length == 0) {
            return false;
        }
        if (format == null || format.isEmpty()) {
            FMLLog.warning("[SDE] 样本带渲染状态字节但缺少格式串（该格按无渲染状态渲染）");
            return false;
        }
        for (TileRenderStateProvider provider : PROVIDERS) {
            if (!format.equals(provider.format())) {
                continue;
            }
            try {
                return provider.apply(te, state);
            } catch (Throwable t) {
                FMLLog.warning("[SDE] 渲染状态回填失败（%s；该格按无渲染状态渲染）: %s", format, String.valueOf(t));
                return false;
            }
        }
        FMLLog.warning("[SDE] 未知渲染状态格式 %s（该格按无渲染状态渲染；对应模组是否不在运行期 classpath？）", format);
        return false;
    }

    /** 扫描快照里的渲染状态：格式串 + 模组自有同步格式的字节。 */
    public static final class RenderStateSample {

        public final String format;
        public final byte[] bytes;

        public RenderStateSample(String format, byte[] bytes) {
            this.format = format;
            this.bytes = bytes;
        }
    }
}
