package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.init.Blocks;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;

import com.gtnewhorizon.structurelib.StructureLibAPI;
import com.gtnewhorizon.structurelib.alignment.constructable.IConstructable;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.GregTechAPI;
import gregtech.api.interfaces.INEIPreviewModifier;
import gregtech.api.interfaces.metatileentity.IMetaTileEntity;
import gregtech.api.interfaces.tileentity.IGregTechTileEntity;
import gregtech.api.metatileentity.implementations.MTEHatchDynamo;
import gregtech.api.metatileentity.implementations.MTEHatchEnergy;
import gregtech.api.metatileentity.implementations.MTEHatchInput;
import gregtech.api.metatileentity.implementations.MTEHatchInputBus;
import gregtech.api.metatileentity.implementations.MTEHatchMaintenance;
import gregtech.api.metatileentity.implementations.MTEHatchMuffler;
import gregtech.api.metatileentity.implementations.MTEHatchOutput;
import gregtech.api.metatileentity.implementations.MTEHatchOutputBus;
import gregtech.api.metatileentity.implementations.MTEMultiBlockBase;
import gregtech.api.threads.RunnableMachineUpdate;
import gregtech.common.tileentities.machines.multi.MTEAbstractMultiFurnace;

/**
 * 在 {@link ProbeDummyWorld} 里「真实」放下一台 GT 多方块控制器，并按需把结构建起来。
 * <p>
 * 关键路径全部是游戏内真实路径，不是合成几何：
 * <ol>
 * <li>控制器：{@code ItemStack#onItemUse(stack, FAKE_PLAYER, world, x, y, z, 0, ...)} —— 与参考实现
 * {@code GTGuiMultiblockHandler#placeMultiblock} 相同的构造钩子；</li>
 * <li>结构：{@link IConstructable#construct(ItemStack, boolean)} 且 {@code hintsOnly=false} —— 走
 * {@code placeBlock} 通道（T0.4 R4：{@code getBlocksToPlace} 不换通道，只有 {@code placeBlock}/{@code spawnHint} 换通道）；</li>
 * <li>成形的最后一块拼图：{@code construct} 不会放舱口（舱口是 hint 位），因此本类用「逐格试放维护仓 + 每试一次调
 * {@code checkStructure(true, base)}」把结构真的判成合法，而不是靠改 {@code mMachine} 字段作弊。</li>
 * </ol>
 */
@SideOnly(Side.CLIENT)
public final class MultiblockWorldBuilder {

    /** 控制器放置坐标（远离原点，便于调试时看坐标）。 */
    public static final int PLACE_X = 8;
    public static final int PLACE_Y = 64;
    public static final int PLACE_Z = 8;

    /** 主通道触发值（等价于滑杆「Tier=1」）。 */
    public static final int TRIGGER_TIER = 1;

    /** 单次探测最多尝试的舱口候选位置数，防病态结构拖死探针。 */
    private static final int MAX_HATCH_CANDIDATES = 512;

    /**
     * 舱口骨架的搜索顺序：先放「结构校验必需」的两种（静音仓 / 维护仓），再按需补其它。
     * <p>
     * 依据（GT5U 源码）：{@code MTEElectricBlastFurnace#checkMachine} 要求
     * {@code mMaintenanceHatches.size() == 1}，而结构串里 {@code 'm'} 位由 {@code HatchElement.Muffler} 校验
     * ——{@code IConstructable#construct} 不会放它们（舱口元素的 {@code placeBlock} 是 hint），所以必须补。
     */
    private static final Class<?>[] HATCH_CLASSES = { MTEHatchMuffler.class, MTEHatchMaintenance.class,
        MTEHatchEnergy.class, MTEHatchInput.class, MTEHatchOutput.class, MTEHatchInputBus.class,
        MTEHatchOutputBus.class, MTEHatchDynamo.class };

    private static final String[] HATCH_NAMES = { "muffler", "maintenance", "energy", "input_hatch", "output_hatch",
        "input_bus", "output_bus", "dynamo" };

    public static final class BuildResult {

        public ProbeDummyWorld world;
        public ProbeFakePlayer player;
        public ItemStack trigger;
        public int x;
        public int y;
        public int z;
        public Block controllerBlock;
        public int controllerMeta;
        public TileEntity tileEntity;
        public IGregTechTileEntity baseTile;
        public IMetaTileEntity placedMetaTile;
        public MTEMultiBlockBase multi;
        public boolean controllerPlaced;
        public boolean structureBuilt;
        public String structureMode = "none";
        public int blocksAfterConstruct;
        public int hatchCandidateTries;
        public final List<String> hatchPlacements = new ArrayList<String>();
        public final List<String> structureErrors = new ArrayList<String>();
        public String hatchCounts = "";
        public String coilLevel = "n/a";
        public int errorDisplayId = Integer.MIN_VALUE;
        public boolean machineFormed;
        public String failure;
        public final List<String> notes = new ArrayList<String>();
    }

    private MultiblockWorldBuilder() {}

    public static BuildResult build(ProbeTarget target) {
        BuildResult r = new BuildResult();
        r.world = new ProbeDummyWorld();
        r.player = new ProbeFakePlayer(r.world);
        r.x = PLACE_X;
        r.y = PLACE_Y;
        r.z = PLACE_Z;
        r.trigger = new ItemStack(StructureLibAPI.getDefaultHologramItem(), 1);
        r.trigger.stackSize = TRIGGER_TIER;

        boolean prevThreadFlag = RunnableMachineUpdate.isCurrentThreadEnabled();
        RunnableMachineUpdate.setCurrentThreadEnabled(false);
        try {
            placeController(r, target);
            if (!r.controllerPlaced) {
                return r;
            }
            if (target.structurePlan == ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH) {
                buildStructure(r);
                findHatchSkeleton(r);
            } else {
                r.notes.add("structurePlan=NONE：只放控制器，不建结构");
            }
        } catch (Throwable t) {
            r.failure = t.getClass()
                .getName() + ": "
                + t.getMessage();
        } finally {
            RunnableMachineUpdate.setCurrentThreadEnabled(prevThreadFlag);
        }
        return r;
    }

    private static void placeController(BuildResult r, ProbeTarget target) {
        ItemStack form = target.metaTile.getStackForm(1);
        if (form == null) {
            r.failure = "getStackForm(1) returned null";
            return;
        }
        form.getItem()
            .onItemUse(form, r.player, r.world, r.x, r.y, r.z, 0, r.x, r.y, r.z);
        TileEntity te = r.world.getTileEntity(r.x, r.y, r.z);
        if (!(te instanceof IGregTechTileEntity)) {
            r.failure = "onItemUse 未在 (" + r.x + "," + r.y + "," + r.z + ") 产生 IGregTechTileEntity，实际=" + te;
            return;
        }
        r.controllerPlaced = true;
        r.tileEntity = te;
        r.baseTile = (IGregTechTileEntity) te;
        r.controllerBlock = r.world.getBlock(r.x, r.y, r.z);
        r.controllerMeta = r.world.getBlockMetadata(r.x, r.y, r.z);
        r.placedMetaTile = r.baseTile.getMetaTileEntity();
        if (r.placedMetaTile instanceof MTEMultiBlockBase) {
            r.multi = (MTEMultiBlockBase) r.placedMetaTile;
        }
        try {
            // 与参考实现一致：固定朝向，使「正面覆盖层」落在确定的一侧
            r.baseTile.setFrontFacing(net.minecraftforge.common.util.ForgeDirection.NORTH);
        } catch (Throwable t) {
            r.notes.add("setFrontFacing 失败: " + t);
        }
        if (r.placedMetaTile instanceof INEIPreviewModifier) {
            try {
                ((INEIPreviewModifier) r.placedMetaTile).onPreviewConstruct(r.trigger);
            } catch (Throwable t) {
                r.notes.add("onPreviewConstruct 抛出: " + t);
            }
        }
    }

    private static void buildStructure(BuildResult r) {
        if (!(r.placedMetaTile instanceof IConstructable)) {
            r.failure = "目标未实现 IConstructable，无法真实构造";
            return;
        }
        ((IConstructable) r.placedMetaTile).construct(r.trigger, false);
        r.structureBuilt = true;
        r.structureMode = "IConstructable#construct(hintsOnly=false) -> placeBlock";
        r.blocksAfterConstruct = r.world.nonAirCount();
        if (r.placedMetaTile instanceof INEIPreviewModifier) {
            try {
                ((INEIPreviewModifier) r.placedMetaTile).onPreviewStructureComplete(r.trigger);
            } catch (Throwable t) {
                r.notes.add("onPreviewStructureComplete 抛出: " + t);
            }
        }
    }

    /**
     * {@code construct} 只放机壳/线圈，<strong>不放舱口</strong>（{@code buildHatchAdder} / {@code HatchElement} 的
     * {@code placeBlock} 只写 hint）。因此这里做「舱口骨架搜索」：对每种舱口类型，逐格「清成空气 → 放该舱口 →
     * {@code checkStructure(true, base)}」，用 <strong>GT 自己的公开舱口清单</strong>（{@code mMaintenanceHatches} /
     * {@code mMufflerHatches} / …）判断这一格是否被结构接受；被接受就保留，否则回滚。任一时刻
     * {@code multi.mMachine} 变为 true 即停止。
     * <p>
     * 这条路径完全走游戏内真实构造/校验，不写 {@code mMachine} 字段。
     */
    private static void findHatchSkeleton(BuildResult r) {
        if (r.multi == null) {
            r.failure = "目标不是 MTEMultiBlockBase，跳过舱口骨架搜索";
            return;
        }
        if (!r.structureBuilt) {
            return;
        }
        List<int[]> candidates = candidatePositions(r);
        Set<String> occupied = new HashSet<String>();

        for (int hi = 0; hi < HATCH_CLASSES.length && !r.machineFormed; hi++) {
            IMetaTileEntity hatchMeta = findMetaTile(HATCH_CLASSES[hi]);
            if (hatchMeta == null) {
                r.notes.add("注册表里找不到 " + HATCH_CLASSES[hi].getSimpleName() + "，跳过该舱口类型");
                continue;
            }
            int before = hatchCount(r.multi, hi);
            for (int[] p : candidates) {
                if (r.hatchCandidateTries >= MAX_HATCH_CANDIDATES) {
                    r.notes.add("舱口候选位置超过上限 " + MAX_HATCH_CANDIDATES + "，提前停止");
                    return;
                }
                String key = p[0] + "," + p[1] + "," + p[2];
                if (occupied.contains(key)) {
                    continue;
                }
                if (p[0] == r.x && p[1] == r.y && p[2] == r.z) {
                    continue;
                }
                r.hatchCandidateTries++;
                Block prevBlock = r.world.getBlock(p[0], p[1], p[2]);
                int prevMeta = r.world.getBlockMetadata(p[0], p[1], p[2]);

                r.world.setBlock(p[0], p[1], p[2], Blocks.air, 0, 2);
                ItemStack hatchStack = hatchMeta.getStackForm(1);
                if (hatchStack != null) {
                    hatchStack.getItem()
                        .onItemUse(hatchStack, r.player, r.world, p[0], p[1], p[2], 0, p[0], p[1], p[2]);
                }
                boolean formed = false;
                try {
                    formed = r.multi.checkStructure(true, r.baseTile);
                } catch (Throwable t) {
                    r.notes.add("checkStructure 在 (" + key + ") 抛出: " + t);
                }
                r.machineFormed = formed && r.multi.mMachine;
                int after = hatchCount(r.multi, hi);
                if (r.machineFormed || after > before) {
                    r.hatchPlacements.add(HATCH_NAMES[hi] + "@" + key);
                    occupied.add(key);
                    break;
                }
                // 回滚：清掉舱口，恢复原方块
                r.world.setBlock(p[0], p[1], p[2], Blocks.air, 0, 2);
                r.world.setBlock(p[0], p[1], p[2], prevBlock, prevMeta, 2);
            }
        }
        if (!r.machineFormed) {
            r.notes.add("舱口骨架搜索后 checkMachine 仍未通过（结构/舱口约束不满足）");
        }
        snapshotReadiness(r);
    }

    /** 失败时把「机器还差什么」按 GT 自己的公开面记录下来，避免只报一句「没通过」。 */
    private static void snapshotReadiness(BuildResult r) {
        try {
            r.multi.checkStructure(true, r.baseTile);
        } catch (Throwable t) {
            r.notes.add("snapshot checkStructure 抛出: " + t);
        }
        r.machineFormed = r.multi.mMachine;
        try {
            java.util.EnumSet<gregtech.api.enums.StructureError> errs = r.multi.getStructureErrors();
            if (errs != null) {
                for (gregtech.api.enums.StructureError e : errs) {
                    r.structureErrors.add(String.valueOf(e));
                }
            }
        } catch (Throwable t) {
            r.notes.add("读取 getStructureErrors 失败: " + t);
        }
        r.hatchCounts = "muffler=" + hatchCount(r.multi, 0)
            + " maintenance="
            + hatchCount(r.multi, 1)
            + " energy="
            + hatchCount(r.multi, 2)
            + " inputHatch="
            + hatchCount(r.multi, 3)
            + " outputHatch="
            + hatchCount(r.multi, 4)
            + " inputBus="
            + hatchCount(r.multi, 5)
            + " outputBus="
            + hatchCount(r.multi, 6)
            + " dynamo="
            + hatchCount(r.multi, 7);
        if (r.multi instanceof MTEAbstractMultiFurnace) {
            r.coilLevel = String.valueOf(((MTEAbstractMultiFurnace<?>) r.multi).getCoilLevel());
        }
        r.errorDisplayId = r.multi.getErrorDisplayID();
    }

    /** 已放置方块的包围盒内全部坐标（含空气位：{@code 'm'} 这类舱口位在 construct 后是空气）。 */
    private static List<int[]> candidatePositions(BuildResult r) {
        List<int[]> placed = r.world.placedPositions();
        List<int[]> out = new ArrayList<int[]>();
        if (placed.isEmpty()) {
            return out;
        }
        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
        for (int[] p : placed) {
            minX = Math.min(minX, p[0]);
            minY = Math.min(minY, p[1]);
            minZ = Math.min(minZ, p[2]);
            maxX = Math.max(maxX, p[0]);
            maxY = Math.max(maxY, p[1]);
            maxZ = Math.max(maxZ, p[2]);
        }
        for (int y = minY; y <= maxY; y++) {
            for (int z = minZ; z <= maxZ; z++) {
                for (int x = minX; x <= maxX; x++) {
                    out.add(new int[] { x, y, z });
                }
            }
        }
        return out;
    }

    private static int hatchCount(MTEMultiBlockBase multi, int typeIndex) {
        switch (typeIndex) {
            case 0:
                return multi.mMufflerHatches == null ? 0 : multi.mMufflerHatches.size();
            case 1:
                return multi.mMaintenanceHatches == null ? 0 : multi.mMaintenanceHatches.size();
            case 2:
                return multi.mEnergyHatches == null ? 0 : multi.mEnergyHatches.size();
            case 3:
                return multi.mInputHatches == null ? 0 : multi.mInputHatches.size();
            case 4:
                return multi.mOutputHatches == null ? 0 : multi.mOutputHatches.size();
            case 5:
                return multi.mInputBusses == null ? 0 : multi.mInputBusses.size();
            case 6:
                return multi.mOutputBusses == null ? 0 : multi.mOutputBusses.size();
            case 7:
                return multi.mDynamoHatches == null ? 0 : multi.mDynamoHatches.size();
            default:
                return 0;
        }
    }

    private static IMetaTileEntity findMetaTile(Class<?> cls) {
        IMetaTileEntity[] all = GregTechAPI.METATILEENTITIES;
        if (all == null) {
            return null;
        }
        for (int i = 0; i < all.length; i++) {
            if (all[i] != null && cls.isInstance(all[i])) {
                return all[i];
            }
        }
        return null;
    }

    public static IMetaTileEntity findMaintenanceHatchMetaTile() {
        return findMetaTile(MTEHatchMaintenance.class);
    }
}
