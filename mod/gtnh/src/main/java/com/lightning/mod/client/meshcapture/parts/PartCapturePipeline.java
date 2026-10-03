package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.init.Blocks;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.parts.PartProviderRegistry.DispatchOutcome;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 三档兜底流水线编排器（契约 {@code format-parts-contract.md} §7.1，硬约束：永远降级）。
 *
 * <pre>
 * 格判定（§1 满方块？）─是→ 跳过（零开销，PartCaptureResult.fullCube()）
 *    │否
 *    ▼
 * 档 1 族权威：所有 applies 命中的 tier-1 提供者全部执行、结果合并（§4 命名空间隔离）
 *    │ 任一部件产出？
 *    ├─是→ 完成（tier 1；不再执行档 2/3）
 *    │否
 *    ▼
 * 档 2 通用盒（P1.2 GenericSingleBoxPartProvider）
 *    │ 有效结果？
 *    ├─是→ 完成（tier 2）
 *    │否（§7.3 退化情形）
 *    ▼
 * 档 3 几何推断（P1.6 InferredGeometryPartProvider，输入 = 该格烘焙四边形快照）
 * </pre>
 *
 * <p>
 * 硬约束落点：
 * <ul>
 * <li><strong>推断永不当主来源</strong>（§7.2）：档 3 只在档 1/档 2 均无产出时执行，结构保证；</li>
 * <li>任何提供者异常 ⇒ 注册表捕获留痕，流水线照常走完（§7.2）；</li>
 * <li>满方块快速否定 = {@link #isFullCube} 三条件判定（§1 终版，P0.3 实证 11/11），
 * 命中即返回，零额外开销；未命中提供者时档 1 调度对空列表零迭代，零额外开销。</li>
 * </ul>
 *
 * <p>
 * <strong>挂载点</strong>（P1.1 拍板）：客户端捕获路径——P1.7 将在
 * {@code MeshCaptureService} 逐格捕获循环内对本入口 {@link #collectParts} 做一次性调用，
 * 结果按契约 §2（cellPartsGrid + partLists）落盘。本轮（P1.1/P1.2）不改落盘逻辑，
 * 输出经 parts/probe 探针日志/调试落盘验证。权威盒接口仅客户端可用（§7），
 * 故本类 {@code @SideOnly(Side.CLIENT)}。
 */
@SideOnly(Side.CLIENT)
public final class PartCapturePipeline {

    private static final double EPS = 1.0E-4;

    /** 无产出（含满方块快速否定）。 */
    public static final int TIER_NONE = 0;

    private PartCapturePipeline() {}

    /**
     * 满方块判定（契约 §1 终版三条件，P0.3 p03-run-3 实证 11/11 场景正确）：
     * {@code renderAsNormalBlock()} 且 选择盒 == 整格 且 碰撞盒 == 整格（碰撞 null ⇒ false）。
     * 两个更松变体均有实测反例（火把 / 四向连接栅栏），禁止采用。
     */
    public static boolean isFullCube(Block block, World world, int x, int y, int z) {
        block.setBlockBoundsBasedOnState(world, x, y, z); // 纪律：每次取盒前必须显式调（§6.2）
        AxisAlignedBB sel = block.getSelectedBoundingBoxFromPool(world, x, y, z);
        block.setBlockBoundsBasedOnState(world, x, y, z);
        AxisAlignedBB col = block.getCollisionBoundingBoxFromPool(world, x, y, z);
        return block.renderAsNormalBlock() && equalsBox(sel, x, y, z, x + 1, y + 1, z + 1)
            && equalsBox(col, x, y, z, x + 1, y + 1, z + 1);
    }

    private static boolean equalsBox(AxisAlignedBB bb, double minX, double minY, double minZ, double maxX, double maxY,
        double maxZ) {
        return bb != null && Math.abs(bb.minX - minX) < EPS
            && Math.abs(bb.minY - minY) < EPS
            && Math.abs(bb.minZ - minZ) < EPS
            && Math.abs(bb.maxX - maxX) < EPS
            && Math.abs(bb.maxY - maxY) < EPS
            && Math.abs(bb.maxZ - maxZ) < EPS;
    }

    /**
     * 一格的部件采集主入口（P1.7 挂载点）。绝不抛出：任何内部失败都降级为"无产出 + notes 留痕"。
     *
     * @return 满方块 ⇒ {@link PartCaptureResult#hostFullCube} = true（零额外开销快速否定）；
     *         非满方块 ⇒ 三档兜底结果（可能为空列表，档位与失败记录见结果字段）。
     */
    public static PartCaptureResult collectParts(World world, int x, int y, int z) {
        return collectParts(world, x, y, z, null);
    }

    /**
     * {@link #collectParts(World, int, int, int)} 的全参形态（P1.6/P1.7）：
     * {@code bakedQuads} = 该格客户端烘焙四边形快照（块局部 [0,1]³，捕获产物；
     * {@code MeshCaptureService} 逐格捕获循环在 {@code TessellatorCaptureState.endBlock} 后传入），
     * 供档 3 几何推断消费；为 null 时档 3 提供者自行现场烘焙（探针等无捕获产物路径）。
     */
    public static PartCaptureResult collectParts(World world, int x, int y, int z,
        List<TessellatorCaptureState.CapturedQuad> bakedQuads) {
        List<String> notes = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        try {
            if (world == null) {
                notes.add("world is null");
                return PartCaptureResult.of(new ArrayList<PartRecord>(), TIER_NONE, notes, failures);
            }
            Block block = world.getBlock(x, y, z);
            if (block == null || block == Blocks.air) {
                return PartCaptureResult.fullCube();
            }
            // 满方块快速否定（§1）：命中即返回，不发射任何部件数据，零额外开销
            boolean full;
            try {
                full = isFullCube(block, world, x, y, z);
            } catch (Throwable t) {
                // 判定本身失败 ⇒ 按非满处理走兜底（宁多勿缺），留痕
                notes.add("isFullCube check failed, treated as non-full: " + t);
                full = false;
            }
            if (full) {
                return PartCaptureResult.fullCube();
            }

            PartProviderContext ctx = new PartProviderContext(
                world,
                x,
                y,
                z,
                block,
                world.getBlockMetadata(x, y, z),
                bakedQuads);

            // 档 1 族权威：全部命中都执行、结果合并（§7.1/§7.2）
            DispatchOutcome tier1 = PartProviderRegistry.dispatch(ctx, PartSource.TIER_FAMILY);
            failures.addAll(tier1.failures);
            if (!tier1.parts.isEmpty()) {
                dedupeLocalIds(tier1.parts, notes);
                return PartCaptureResult.of(tier1.parts, PartSource.TIER_FAMILY, notes, failures);
            }

            // 档 2 通用盒（P1.2）
            DispatchOutcome tier2 = PartProviderRegistry.dispatch(ctx, PartSource.TIER_GENERIC);
            failures.addAll(tier2.failures);
            if (!tier2.parts.isEmpty()) {
                dedupeLocalIds(tier2.parts, notes);
                return PartCaptureResult.of(tier2.parts, PartSource.TIER_GENERIC, notes, failures);
            }

            // 档 3 几何推断：只在档 1/档 2 均无产出时执行（推断永不当主来源，§7.2 结构保证）。
            // P1.6 已注册 InferredGeometryPartProvider（family=inferred, fallback=true）：
            // 输入 = 该格烘焙四边形快照（bakedQuads；为 null 时提供者现场烘焙），永远有结果
            // （连可用几何都没有 ⇒ 整格 degenerate 盒）。
            DispatchOutcome tier3 = PartProviderRegistry.dispatch(ctx, PartSource.TIER_INFERRED);
            failures.addAll(tier3.failures);
            if (!tier3.parts.isEmpty()) {
                dedupeLocalIds(tier3.parts, notes);
                return PartCaptureResult.of(tier3.parts, PartSource.TIER_INFERRED, notes, failures);
            }
            notes.add("tier-3 inference produced no parts for this cell (unexpected; provider should always emit)");
            return PartCaptureResult.of(new ArrayList<PartRecord>(), TIER_NONE, notes, failures);
        } catch (Throwable t) {
            // 流水线级兜底：绝不中断导出（§7.2）
            FMLLog.warning(
                "[SDE] PartCapturePipeline: collectParts(%d,%d,%d) failed: %s",
                Integer.valueOf(x),
                Integer.valueOf(y),
                Integer.valueOf(z),
                String.valueOf(t));
            notes.add("pipeline-level failure, no parts emitted: " + t);
            return PartCaptureResult.of(new ArrayList<PartRecord>(), TIER_NONE, notes, failures);
        }
    }

    /**
     * localId 族内冲突兜底（§4 末段）：同格重复 localId 追加 {@code #2}/{@code #3} 序号并记录。
     * 命名空间隔离（{@code <族>:<定位符>}）保证多族合并不冲突，此处只兜族内异常重复。
     */
    private static void dedupeLocalIds(List<PartRecord> parts, List<String> notes) {
        Map<String, Integer> seen = new LinkedHashMap<>();
        for (PartRecord p : parts) {
            Integer count = seen.get(p.localId);
            if (count == null) {
                seen.put(p.localId, Integer.valueOf(1));
                continue;
            }
            int next = count.intValue() + 1;
            seen.put(p.localId, Integer.valueOf(next));
            String renamed = p.localId + "#" + next;
            notes.add("duplicate localId " + p.localId + " renamed to " + renamed + " (§4)");
            FMLLog.warning("[SDE] PartCapturePipeline: duplicate localId %s renamed to %s", p.localId, renamed);
            p.localId = renamed;
        }
    }
}
