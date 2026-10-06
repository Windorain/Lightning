package com.lightning.mod.client.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * issue #87 修复的纯 JVM 锚：MCPatcher/Angelica CTM tile locator → 磁盘资源路径映射。
 * <p>
 * 缺陷现场：CTM 覆盖使捕获侧材质键取到 {@code gregtech:mcpatcher/ctm/blockglassnotgt/antimatterglass/N}
 * 形态的 sprite 名，而 {@code texturePngResourceLocationsForBundle} 只探测 {@code textures/...} 路径
 * （CTM 资源实际在 {@code assets/<ns>/mcpatcher/...}，没有 {@code textures/} 段）→ 磁盘探测永远失败 →
 * 落占位 PNG（导出件里就是紫黑棋盘）。修复后该映射必须命中 {@code mcpatcher/...} 真实路径。
 * <p>
 * 只测纯字符串映射（{@link ExportTextureLocator#mcpatcherResourcePathForBundle}），不触碰 MC 类型 ——
 * 与 {@link com.lightning.mod.SanityTest} 的纯 JVM 边界一致。
 */
public class ExportTextureLocatorTest {

    /** 核心修复断言：CTM tile 路径映射到 textures/ 之外的真实资源路径。 */
    @Test
    public void mcpatcherCtmTileMapsToNonTexturesPath() {
        assertEquals(
            "mcpatcher/ctm/blockglassnotgt/antimatterglass/0.png",
            ExportTextureLocator.mcpatcherResourcePathForBundle("mcpatcher/ctm/blockglassnotgt/antimatterglass/0"));
        assertEquals(
            "mcpatcher/ctm/blockglassnotgt/antimatterglass/3.png",
            ExportTextureLocator.mcpatcherResourcePathForBundle("mcpatcher/ctm/blockglassnotgt/antimatterglass/3"));
    }

    /** 兼容形态：修复前 normalize 会给 mcpatcher 路径补上 blocks/ 前缀，存量形态也要能解。 */
    @Test
    public void mcpatcherLegacyBlocksPrefixedFormStillMaps() {
        assertEquals(
            "mcpatcher/ctm/blockglassnotgt/antimatterglass/0.png",
            ExportTextureLocator
                .mcpatcherResourcePathForBundle("blocks/mcpatcher/ctm/blockglassnotgt/antimatterglass/0"));
    }

    /** 负对照：普通方块贴图路径不得被误判为 CTM（否则 textures/ 探测被跳过，回归误伤）。 */
    @Test
    public void nonCtmPathsReturnNull() {
        assertNull(ExportTextureLocator.mcpatcherResourcePathForBundle("blocks/stone"));
        assertNull(ExportTextureLocator.mcpatcherResourcePathForBundle("materialicons/FOIL"));
        assertNull(ExportTextureLocator.mcpatcherResourcePathForBundle("iconsets/MACHINE_CASING_ANTIMATTER"));
        assertNull(ExportTextureLocator.mcpatcherResourcePathForBundle(""));
        assertNull(ExportTextureLocator.mcpatcherResourcePathForBundle(null));
    }

    /**
     * normalize 行为锚（Lead 复核观察项，#87 评论 id=1662）：{@code mcpatcher/} 计为显式纹理根后，
     * CTM locator 经 normalize 不得被补 {@code blocks/} 前缀（修复前会被补成 {@code blocks/mcpatcher/...}，
     * 磁盘探测拼出 {@code textures/blocks/mcpatcher/...} 永远落空）；普通路径行为不变。
     */
    @Test
    public void normalizeKeepsMcpatcherRootBare() {
        assertEquals(
            "gregtech:mcpatcher/ctm/blockglassnotgt/antimatterglass/0",
            ExportTextureLocator.normalizeLocatorForBundle("gregtech:mcpatcher/ctm/blockglassnotgt/antimatterglass/0"));
        /* 负对照：无显式根的普通注册名仍补 blocks/（既有行为不变） */
        assertEquals(
            "goodgenerator:blocks/antimatterContainmentCasing",
            ExportTextureLocator.normalizeLocatorForBundle("goodgenerator:antimatterContainmentCasing"));
    }
}
