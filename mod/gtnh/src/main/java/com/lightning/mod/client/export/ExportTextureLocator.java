package com.lightning.mod.client.export;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import net.minecraft.block.Block;
import net.minecraft.util.IIcon;
import net.minecraft.util.ResourceLocation;
import net.minecraftforge.common.util.ForgeDirection;

import com.lightning.mod.core.registry.gt.GtRenderProfiles;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 将方块 + meta 解析为可在资源包中定位 PNG 的 <b>locator 字符串</b>（{@code 命名空间:path}，不含 {@code .png}）。
 * {@link GtRenderProfiles#usesMetaTileEntityResolver(String)} 为真时参数为 mID；否则为世界 meta 0–15。
 * <p>
 * <b>数据流（端到端）</b>
 * <ol>
 * <li>场景导出仅写结构 JSON；全量注册表由 {@code /sde dump} 触发服务端写出 {@code pending_dump.json}，客户端
 * {@link ExportBundleClient#tickConsumePendingDumpIfAny} 调用 {@link ExportBundleClient#writeFullRegistryDump}。</li>
 * <li>{@link ExportBundleClient#writeFullRegistryDump}：{@code block_registry} 由 Block 注册表调用
 * {@link #resolve(Block, int, String)}；
 * 一般方块 {@code meta} 为世界变体 0–15；{@code gregtech:gt.blockmachines} 为 MetaTile ID（mID），见
 * {@link com.lightning.mod.core.registry.GregTechMetaTileRegistry}。
 * {@code material_registry} 仅由方块 {@link net.minecraft.client.renderer.texture.TextureMap} 的
 * {@code mapRegisteredSprites} 键经
 * {@link #iconNameToLocator}、{@link #normalizeLocatorForBundle} 枚举（见
 * {@link com.lightning.mod.mixin.interfaces.accessors.TextureMapAccessor}）。</li>
 * <li>{@link #resolve}：若 {@code renderProfile} 走 MTE 路径，则 {@link GtTextureResolver#tryMetaTileEntityLocator}，
 * 从 MTE/ITexture 解出与 {@link IIcon} 等价的原始 {@code ns:path}；否则走 {@link Block#getIcon} → {@link IIcon#getIconName()}。
 * GregTech 复制方块纹理见 {@code gregtech.api.render.TextureFactory} / {@code gregtech.common.render.GTBlockTextureBuilder}，
 * 解析细节见
 * {@link GtTextureResolver#locatorFromGtITexture}（{@code GTCopiedBlockTextureRender}、{@code GTCopiedCTMBlockTexture}）。</li>
 * <li>两条分支均在 {@link #resolve} 出口唯一调用 {@link #normalizeLocatorForBundle}（与磁盘 {@code assets/.../textures/...}
 * 对齐）；{@link GtTextureResolver} 内部不再重复规范化。</li>
 * <li>材质条目用 {@link net.minecraft.util.ResourceLocation} 探测 PNG/mcmeta（不复制资源文件）；{@code block_registry} 中
 * {@code materialId} 与
 * {@code material_registry} 键使用<b>同一</b>规范化 locator 字符串。</li>
 * </ol>
 * <p>
 * <b>假设（locator 语义）</b>
 * <ul>
 * <li>本导出流程中的纹理均按<b>方块侧</b>处理：{@link Block#getIcon}、MTE 纹理等对应 Minecraft <b>方块纹理图集</b>（{@code TextureMap} block 侧），
 * 而非物品图集。详见 {@link #normalizeLocatorForBundle}。</li>
 * <li>locator 的 {@code path} 段表示 {@code assets/&lt;ns&gt;/textures/&lt;path&gt;.png} 中 {@code textures/} <b>之后</b>的路径，
 * 且规范化后应含 {@code blocks/} 或 {@code items/} 之一；无此前缀时默认补 {@code blocks/}；若注册名已显式为 {@code items/...} 则保留（见
 * {@link #normalizeLocatorForBundle}）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class ExportTextureLocator {

    /**
     * 与 {@link Block#getIcon(int, int)} 的 side 参数一致（ForgeDirection 序数）；用于采样一面贴图。
     * <p>
     * <b>假设</b>：与 {@link ExportBundleClient} 中写入 registry 时使用的采样侧一致，便于与游戏内方块外观对齐。
     */
    public static final int DEFAULT_SAMPLE_SIDE = 3;

    private ExportTextureLocator() {}

    /**
     * 入口：方块 + meta + {@code renderProfile} → 规范化后的 locator，供 {@link ExportBundleClient#writeFullRegistryDump} 与材质登记使用。
     * <p>
     * <b>假设</b>：见类注释；此处两条分支（MTE / 普通方块图标）最终都经 {@link #normalizeLocatorForBundle}。
     *
     * @param meta          MTE 路径时为 GT5U mID；否则为世界 block metadata（0–15）。
     * @param renderProfile 与 {@link com.lightning.mod.core.registry.gt.GtRenderProfiles}
     *                      常量一致；{@code null} 按非 MTE 处理。
     */
    public static String resolve(Block block, int meta, String renderProfile) {
        if (block == null) {
            return null;
        }
        if (GtRenderProfiles.usesMetaTileEntityResolver(renderProfile)) {
            String fromMte = GtTextureResolver
                .tryMetaTileEntityLocator(meta, DEFAULT_SAMPLE_SIDE, ForgeDirection.NORTH);
            if (fromMte != null && !isLikelyGtRenderingErrorLocator(fromMte)) {
                return normalizeLocatorForBundle(fromMte);
            }
            return null;
        }
        String fromIcon = locatorFromBlockIcon(block, meta, DEFAULT_SAMPLE_SIDE);
        return fromIcon != null ? normalizeLocatorForBundle(fromIcon) : null;
    }

    /** 过滤 GT 占位/错误图（locator 字符串层面）。 */
    static boolean isLikelyGtRenderingErrorLocator(String locator) {
        if (locator == null) {
            return true;
        }
        String s = locator.toLowerCase();
        return s.contains("rendering_error") || s.contains("error_rendering");
    }

    /**
     * <b>假设</b>：{@link Block#getIcon} 返回的 {@link IIcon} 来自方块纹理图集。
     */
    static String locatorFromBlockIcon(Block block, int meta, int sampleSideOrdinal) {
        try {
            net.minecraft.util.IIcon icon = block.getIcon(sampleSideOrdinal, meta);
            return locatorFromIcon(icon);
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * {@link IIcon#getIconName()} → 中间形式 {@code ns:path}（仍可能缺 {@code blocks/} 层，由 {@link #normalizeLocatorForBundle}
     * 补全）。
     */
    public static String locatorFromIcon(IIcon icon) {
        if (icon == null) {
            return null;
        }
        String iconName = icon.getIconName();
        if (iconName == null || iconName.isEmpty()) {
            return null;
        }
        return iconNameToLocator(iconName);
    }

    /**
     * 图集注册名（与 {@link IIcon#getIconName()} 一致）→ 带命名空间的 locator 前缀。
     * <p>
     * <b>假设</b>：无 {@code :} 的名称按 Minecraft 约定视为默认域 {@code minecraft:}。
     */
    public static String iconNameToLocator(String iconName) {
        int colon = iconName.indexOf(':');
        if (colon < 0) {
            return "minecraft:" + iconName;
        }
        return iconName;
    }

    /**
     * 将各来源的 locator 字符串规范为与 {@link net.minecraft.client.resources.IResourceManager#getResource}、磁盘
     * {@code assets/.../textures/...}
     * 一致的形式，供 {@link ExportBundleClient} 拼接 {@code textures/ + path + .png} 做资源探测。
     * <p>
     * <b>假设（本模组导出语境）</b>：此处出现的纹理均来自<b>方块</b>侧（{@link Block#getIcon}、MTE 对方块采样等），即对应
     * Minecraft 的<b>方块纹理图集</b>（与 {@code TextureMap} 的 block sprites 一致），而非物品图集。许多模组注册名形如
     * {@code modid:iconsets/...}，相对 {@code textures/} 仍缺一层 {@code blocks/}，磁盘实际路径为
     * {@code assets/modid/textures/blocks/iconsets/...png}。
     * <p>
     * <b>处理规则</b>：去掉 path 段重复的 {@code textures/}；若 path 不以显式纹理根（{@code blocks/}、{@code items/}、{@code models/}、
     * {@code entity/} 等，与 Wiki {@code resolveAssets} 一致）开头，则补上 {@code blocks/}。{@code models/…} 对应磁盘
     * {@code assets/&lt;ns&gt;/models/…png}，不得误加 {@code blocks/} 前缀。Botania 等使用 {@code textures/model/…}
     * （单数 {@code model/}，与 {@code models/} 不同）。GregTech {@code materialicons/…} 在
     * {@code textures/blocks/materialicons/} 与 {@code textures/items/materialicons/} 均可能出现，见
     * {@link #texturePngResourceLocationsForBundle}。
     * <p>
     * 可多次调用，幂等。
     */
    private static final String[] EXPLICIT_TEXTURE_PATH_ROOTS = new String[] { "blocks/", "items/", "materialicons/",
        "models/", "model/", "entity/", "gui/", "misc/", "environment/", "font/", "map/", "painting/", "particle/",
        "colormap/", };

    private static boolean pathHasExplicitTextureRoot(String path) {
        for (String root : EXPLICIT_TEXTURE_PATH_ROOTS) {
            if (path.startsWith(root)) {
                return true;
            }
        }
        return false;
    }

    public static String normalizeLocatorForBundle(String locator) {
        if (locator == null) {
            return null;
        }
        int colon = locator.indexOf(':');
        if (colon < 0) {
            return locator;
        }
        String ns = locator.substring(0, colon)
            .toLowerCase(Locale.ROOT);
        String path = locator.substring(colon + 1);
        while (path.startsWith("textures/")) {
            path = path.substring("textures/".length());
        }
        /*
         * 1.7.10 中许多 {@link IIcon#getIconName()} 为 modid:baseName:worldMeta，磁盘 PNG 无 :meta 后缀。仅剥去 0–15
         * 的尾段，避免误伤 GregTech 等 {@code mID} 四位数。见 debug：ic2:blockAlloyGlass:0 → .../blockAlloyGlass.png。
         */
        path = stripWorldMetaSuffixInPathForBundle(path);
        if (!pathHasExplicitTextureRoot(path)) {
            path = "blocks/" + path;
        }
        return ns + ":" + path;
    }

    /**
     * 若 path 中<b>仅有一个</b> {@code :} 且其右侧为 0..15 的十进制，则视为世界 meta 并去掉
     * {@code :N}；否则原样返回（多段 : 或 mID>15 不剥）。
     */
    static String stripWorldMetaSuffixInPathForBundle(String path) {
        if (path == null || path.isEmpty()) {
            return path;
        }
        int c = path.indexOf(':');
        if (c < 0) {
            return path;
        }
        if (path.indexOf(':', c + 1) >= 0) {
            return path;
        }
        String tail = path.substring(c + 1);
        if (!tail.matches("[0-9]+")) {
            return path;
        }
        int meta;
        try {
            meta = Integer.parseInt(tail, 10);
        } catch (NumberFormatException e) {
            return path;
        }
        if (meta < 0 || meta > 15) {
            return path;
        }
        return path.substring(0, c);
    }

    /**
     * 规范化后的 locator → 探测 PNG 时依次尝试的 {@link ResourceLocation}（与 {@link #normalizeLocatorForBundle} 配套）。
     * GregTech {@code materialicons/} 同时存在于 blocks/items 纹理目录，不得拼成 {@code textures/materialicons/…}。
     */
    public static List<ResourceLocation> texturePngResourceLocationsForBundle(String normalizedLocator) {
        if (normalizedLocator == null) {
            return Collections.emptyList();
        }
        int colon = normalizedLocator.indexOf(':');
        if (colon < 0) {
            return Collections.emptyList();
        }
        String ns = normalizedLocator.substring(0, colon);
        String path = normalizedLocator.substring(colon + 1);
        List<ResourceLocation> out = new ArrayList<>(2);
        if (path.startsWith("models/")) {
            /* 与方块纹理一致：磁盘为 assets/<ns>/textures/models/...png，非 assets/<ns>/models/... */
            out.add(new ResourceLocation(ns, "textures/" + path + ".png"));
            return out;
        }
        if (path.startsWith("model/")) {
            /* Botania：assets/<ns>/textures/model/...png（如 hourglass），非 textures/blocks/model/... */
            out.add(new ResourceLocation(ns, "textures/" + path + ".png"));
            return out;
        }
        if (path.startsWith("materialicons/")) {
            out.add(new ResourceLocation(ns, "textures/blocks/" + path + ".png"));
            out.add(new ResourceLocation(ns, "textures/items/" + path + ".png"));
            return out;
        }
        out.add(new ResourceLocation(ns, "textures/" + path + ".png"));
        if (path.startsWith("blocks/")) {
            String stripped = path.substring("blocks/".length());
            out.add(new ResourceLocation(ns, "textures/" + stripped + ".png"));
        }
        return out;
    }
}
