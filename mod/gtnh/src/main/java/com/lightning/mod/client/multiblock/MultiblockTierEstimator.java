package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;

import com.gtnewhorizon.structurelib.StructureLibAPI;
import com.gtnewhorizon.structurelib.alignment.constructable.IConstructable;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.interfaces.INEIPreviewModifier;
import gregtech.api.interfaces.tileentity.IGregTechTileEntity;
import gregtech.api.threads.RunnableMachineUpdate;

/**
 * T1.2 总 Tier 探测：逐级 {@code construct} 试探。
 * <p>
 * 参考 {@code BlockRenderer6343/client/world/ObserverWorld#estimateTier}，但把「结构是否还在长」的判据从参考实现的
 * 元素回调换成 {@link ProbeDummyWorld#blocksPlaced()} 的变更计数 —— 与参考实现等价（它自己的
 * {@code setBlock} 也在同一位置置 {@code hasChanged}），但不依赖任何元素内部实现，因而对自定义元素同样成立。
 * <p>
 * 每次迭代都先调 {@code INEIPreviewModifier#onPreviewConstruct(holo)}，因为 GT 的 {@code construct} 会读
 * <b>实例状态</b>（T0.4 R5：{@code MTEIndustrialCokeOven#construct} 读 {@code getCoilTier()}），必须每轮用当前
 * trigger 重新灌一遍通道数据，否则同一 trigger 在不同调用顺序下会给出不同几何。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockTierEstimator {

    /** 对齐 {@code ObserverWorld.MAX_TRIES}。 */
    public static final int MAX_TRIES = 64;

    private MultiblockTierEstimator() {}

    public static void estimate(MultiblockChannelProbe.MachineProbe m, IConstructable multi, ProbeDummyWorld world) {
        long started = System.currentTimeMillis();
        boolean prevThreadFlag = RunnableMachineUpdate.isCurrentThreadEnabled();
        RunnableMachineUpdate.setCurrentThreadEnabled(false);
        try {
            m.probeWorld = world;
            if (m.probeContext == null) m.probeContext = multi;
            ProbeFakePlayer player = new ProbeFakePlayer(world);

            ItemStack form = (multi instanceof gregtech.api.interfaces.metatileentity.IMetaTileEntity)
                ? ((gregtech.api.interfaces.metatileentity.IMetaTileEntity) multi).getStackForm(1)
                : null;
            if (form == null) {
                m.tierFailure = "getStackForm(1) 返回 null，无法放置控制器";
                m.tierSource = "failed";
                return;
            }
            form.getItem()
                .onItemUse(
                    form,
                    player,
                    world,
                    MultiblockWorldBuilder.PLACE_X,
                    MultiblockWorldBuilder.PLACE_Y,
                    MultiblockWorldBuilder.PLACE_Z,
                    0,
                    MultiblockWorldBuilder.PLACE_X,
                    MultiblockWorldBuilder.PLACE_Y,
                    MultiblockWorldBuilder.PLACE_Z);
            TileEntity te = world.getTileEntity(
                MultiblockWorldBuilder.PLACE_X,
                MultiblockWorldBuilder.PLACE_Y,
                MultiblockWorldBuilder.PLACE_Z);
            if (!(te instanceof IGregTechTileEntity)) {
                m.tierFailure = "onItemUse 未产生 IGregTechTileEntity，实际=" + te;
                m.tierSource = "failed";
                return;
            }
            IConstructable placed = (IConstructable) ((IGregTechTileEntity) te).getMetaTileEntity();
            if (placed == null) {
                m.tierFailure = "基座 getMetaTileEntity() 为 null";
                m.tierSource = "failed";
                return;
            }

            ItemStack holo = new ItemStack(StructureLibAPI.getDefaultHologramItem(), 1);
            int tier = 0;
            boolean changed;
            List<Integer> deltas = new ArrayList<Integer>();
            String prevSignature = null;
            do {
                holo.stackSize = tier + 1;
                if (placed instanceof INEIPreviewModifier) {
                    try {
                        ((INEIPreviewModifier) placed).onPreviewConstruct(holo);
                    } catch (Throwable t) {
                        m.notes.add(
                            "onPreviewConstruct(tier=" + (tier + 1)
                                + ") 抛出: "
                                + t.getClass()
                                    .getSimpleName());
                    }
                }
                int before = world.blocksPlaced();
                world.beginTrace();
                placed.construct(holo, false);
                int delta = world.blocksPlaced() - before;
                deltas.add(Integer.valueOf(delta));
                if (tier == 1 && delta != 0) {
                    m.tierSecondTierTrace = world.trace();
                }
                // 收敛判据 = 布局签名相对上一级是否变化（见 ProbeDummyWorld#stateSignature 的注释）
                String signature = world.stateSignature();
                changed = prevSignature == null || !prevSignature.equals(signature);
                prevSignature = signature;
                tier++;
                m.tierAttempts = tier;
            } while (tier <= MAX_TRIES && changed);
            m.tierMutationDeltas = deltas;

            m.tierEstimateHitCap = tier > MAX_TRIES;
            if (changed && m.tierEstimateHitCap) {
                m.notes.add("总 Tier 试探在 " + MAX_TRIES + " 次后仍在变化，已截断（上界标 fallback）");
            }
            m.maxTotalTier = Integer.valueOf(tier - 1);
            m.tierSource = m.tierEstimateHitCap ? "probed-capped" : "probed";
            m.tierBlocksAtMax = world.nonAirCount();
            if (m.maxTotalTier.intValue() <= 1) {
                m.tierSource = "probed-single";
            }
        } catch (Throwable t) {
            m.tierFailure = MultiblockChannelProbe.describe(t);
            m.tierSource = "failed";
            m.notes.add("总 Tier 试探失败（已落盘，不静默跳过）");
        } finally {
            RunnableMachineUpdate.setCurrentThreadEnabled(prevThreadFlag);
            m.tierElapsedMs = System.currentTimeMillis() - started;
            // 世界实例由调用方（runner）在通道探测也用完之后释放；此处不清引用。
        }
    }
}
