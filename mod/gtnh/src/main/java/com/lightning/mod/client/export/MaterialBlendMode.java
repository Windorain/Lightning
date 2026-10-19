package com.lightning.mod.client.export;

import net.minecraft.block.Block;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 导出契约 {@code materialPalette[].blend} 的判定 —— **导出侧是权威**，消费方（Web 内核）只在
 * 字段缺席时才按 {@code opaque} 兜底。
 *
 * ## 规则从哪来（不是挑的，是从渲染分工推出来的）
 *
 * MC 1.7.10 的世界渲染按 pass 分两遍（`EntityRenderer.renderWorld`）：
 *
 * | pass | 状态 | 等价呈现 |
 * |---|---|---|
 * | 0（`sortAndRender(..., 0, ...)`，:1287） | `GL_ALPHA_TEST` + `GL_ALPHA_FUNC(GREATER, 0.1)`（:1113/:1289），**无混合** | 丢弃
 * alpha ≤ 0.1 的纹素，其余按不透明写 |
 * | 1（`sortAndRender(..., 1, ...)`，:1396） | 混合开（`SRC_ALPHA/ONE_MINUS_SRC_ALPHA`，:1378） | 半透明混合 |
 *
 * 于是 `getRenderBlockPass() > 0` ⇒ {@link #TRANSLUCENT}。
 *
 * pass 0 里"到底会不会丢纹素"取决于贴图像素，但**方块自己已经声明了这件事**：
 * `isOpaqueCube()` 为假的方块（玻璃/树叶/植物/台阶/箱子…）必然是"面里有洞"或不占满整格，
 * 而 `isOpaqueCube()` 为真的方块其贴图必然全不透明 —— 否则光照与邻面剔除会先坏掉
 * （这正是游戏自己用这个标志做剔除的原因）。故：
 *
 * - pass 0 且 `isOpaqueCube()` ⇒ {@link #OPAQUE}；
 * - pass 0 且非不透明立方体 ⇒ {@link #CUTOUT}。
 *
 * ## 为什么不去扫贴图像素
 *
 * 贴图像素的取回在本工程里有**一条**多级回退链（`TextureBlobEmbedder`：帧缓冲 → 磁盘 PNG →
 * GPU 回读 → 缓存）；在这里再造一条就成了"同一语义两处实现"。而 `isOpaqueCube` 是方块
 * 自己给出的判据，与上面那条链的结论在 MC 方块体系里一致。
 *
 * ⚠️ 已知边界：`isOpaqueCube()` 为假但贴图全不透明的方块（台阶、箱子…）会被标成
 * {@code cutout}。呈现上等价（alpha 全 1，alphaTest 不丢任何像素），代价是该批进"透明"绘制
 * 列表，排序更贵一些；**不会**改变像素结果。
 */
@SideOnly(Side.CLIENT)
public final class MaterialBlendMode {

    public static final String OPAQUE = "opaque";
    public static final String CUTOUT = "cutout";
    public static final String TRANSLUCENT = "translucent";

    private MaterialBlendMode() {}

    /**
     * 渲染分工 → 混合模式（**纯函数**，可脱离 MC 运行期单测）。
     *
     * @param renderBlockPass `Block#getRenderBlockPass()`（0 = 实体 pass，≥1 = 半透明 pass）
     * @param opaqueCube      `Block#isOpaqueCube()`
     */
    public static String of(int renderBlockPass, boolean opaqueCube) {
        if (renderBlockPass > 0) {
            return TRANSLUCENT;
        }
        return opaqueCube ? OPAQUE : CUTOUT;
    }

    /**
     * 方块侧入口。
     *
     * @return {@code null} 表示**不声明**（拿不到方块时不猜：消费方按缺席口径处理），
     *         不是"不透明"。
     */
    public static String of(Block block) {
        if (block == null) {
            return null;
        }
        return of(block.getRenderBlockPass(), block.isOpaqueCube());
    }
}
