package com.lightning.mod.client.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * {@link MaterialBlendMode} 的判定表：导出件 {@code materialPalette[].blend} 是**导出侧权威**
 * （消费方缺席时按 opaque 兜底），故这张表必须机械可判。
 *
 * <p>
 * 规则来源见类注释（MC 1.7.10 的两遍渲染：pass 0 有 alpha test 无混合、pass 1 有混合），
 * 这里只钉"输入 → 输出"，不复制实现。
 */
public class MaterialBlendModeTest {

    @Test
    public void pass0OpaqueCubeIsOpaque() {
        // 石头/羊毛/机器方块：整格不透明，pass 0 直接写
        assertEquals(MaterialBlendMode.OPAQUE, MaterialBlendMode.of(0, true));
    }

    @Test
    public void pass0NonOpaqueCubeIsCutout() {
        // 玻璃/树叶/植物/台阶/箱子：pass 0 + alpha test 丢洞
        assertEquals(MaterialBlendMode.CUTOUT, MaterialBlendMode.of(0, false));
    }

    @Test
    public void anyPositivePassIsTranslucent() {
        // 水/冰/染色玻璃：pass 1 混合
        assertEquals(MaterialBlendMode.TRANSLUCENT, MaterialBlendMode.of(1, false));
        assertEquals(MaterialBlendMode.TRANSLUCENT, MaterialBlendMode.of(1, true));
        assertEquals(MaterialBlendMode.TRANSLUCENT, MaterialBlendMode.of(2, true));
    }

    @Test
    public void nullBlockMeansUndeclaredNotOpaque() {
        // 拿不到方块 ⇒ 不声明（消费方按缺席口径兜底），绝不能冒充 opaque
        assertNull(MaterialBlendMode.of(null));
    }

    @Test
    public void constantsMatchContractVocabulary() {
        assertEquals("opaque", MaterialBlendMode.OPAQUE);
        assertEquals("cutout", MaterialBlendMode.CUTOUT);
        assertEquals("translucent", MaterialBlendMode.TRANSLUCENT);
    }
}
