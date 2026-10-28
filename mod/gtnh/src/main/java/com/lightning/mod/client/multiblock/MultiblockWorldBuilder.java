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
import com.gtnewhorizon.structurelib.alignment.constructable.ChannelDataAccessor;
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
 * {@code placeBlock} 通道（通道探测结论：{@code getBlocksToPlace} 不换通道，只有 {@code placeBlock}/{@code spawnHint} 换通道）；</li>
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

    /**
     * 捕获数据集：舱口骨架的<strong>搜索结果</strong>缓存。它只缓存「哪些位置被 GT 自己的舱口清单接受」这一结论，
     * <b>不缓存任何几何</b> —— 每个变体仍然在自己的假世界里用真实 {@code onItemUse} 放控制器、真实
     * {@code construct(hintsOnly=false)} 建结构，只是不再为「形状完全相同」的变体重复做那 100+ 次舱口位置暴力搜索
     * （实测 EBF 一次搜索 183 次 {@code checkStructure}）。
     * <p>
     * 复用安全性由 {@link #applyHatchPlan} 的<strong>公开清单校验</strong>保证：按计划放好舱口后跑一次
     * {@code checkStructure}，只有当 8 个公开舱口清单的计数与计划记录完全一致才接受缓存；否则回滚并退回全量搜索。
     */
    public static final class HatchPlan {

        /** 形状键：已放置坐标集合（不含方块身份）的内容签名。 */
        public String shapeKey = "";
        public String source = "searched";
        /** 展示形态的落点（{@code 名字@x,y,z}），与 {@link BuildResult#hatchPlacements} 同形。 */
        public final List<String> placements = new ArrayList<String>();
        /** 8 个公开舱口清单的计数快照（muffler/maintenance/energy/input_hatch/output_hatch/input_bus/output_bus/dynamo）。 */
        public final int[] hatchCounts = new int[8];
    }

    /** 形状键 → 舱口计划的缓存（由调用方持有，跨变体复用；传入 {@code null} 即退化为「每个变体全量搜索」）。 */
    public interface HatchPlanCache {

        HatchPlan lookup(String shapeKey);

        void store(HatchPlan plan);
    }

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
        /** 捕获数据集：本次构建使用的形状键（已放置坐标集合的内容签名）。 */
        public String shapeKey = "";
        /** 捕获数据集：舱口骨架来自缓存计划还是全量搜索（{@code none} = 未做/不需要）。 */
        public String hatchPlanSource = "none";
        /** 捕获数据集：本变体控制器的 MTE 实例身份哈希（用于证明每个变体拿到全新实例、无实例状态泄漏，通道探测结论）。 */
        public int metaTileInstanceHash;
        public final List<String> notes = new ArrayList<String>();
    }

    private MultiblockWorldBuilder() {}

    /**
     * 造一个携带「通道取值」的 trigger：{@code stackSize = 总 Tier}（= StructureLib 的主通道），每个**非 0** 的通道值
     * 写进 {@code ChannelDataAccessor} 的子通道标签。
     * <p>
     * {@code value == 0} 表示契约 §5.2 的「未设置」：<b>不写该键</b>，于是 {@code getChannelData} 回落到
     * {@code stackSize}（= 总 Tier），这正是 GT 数据层的真实语义，也是捕获数据集与 web 装配器 web 装配器必须一致的
     * 「未设置 → 回落主通道」规则。
     */
    public static ItemStack triggerWithChannels(int totalTier, java.util.Map<String, Integer> channelValues) {
        ItemStack trigger = new ItemStack(
            StructureLibAPI.getDefaultHologramItem(),
            Math.max(1, Math.min(64, totalTier)));
        if (channelValues != null) {
            for (java.util.Map.Entry<String, Integer> e : channelValues.entrySet()) {
                Integer v = e.getValue();
                if (e.getKey() == null || e.getKey()
                    .isEmpty() || v == null || v.intValue() <= 0) {
                    continue;
                }
                ChannelDataAccessor.setChannelData(trigger, e.getKey(), v.intValue());
            }
        }
        return trigger;
    }

    /** 运行态探针 原口径：内部自建默认 trigger（{@code stackSize = TRIGGER_TIER}），不做舱口计划缓存。 */
    public static BuildResult build(ProbeTarget target) {
        return build(target, null, null);
    }

    /**
     * 捕获数据集口径：显式给定 trigger（通道取值注入的载体）与可选的舱口计划缓存。
     * <p>
     * <b>通道取值注入只走 trigger</b>：通道值写在 trigger 的 {@code channels} 子标签上，由 StructureLib 的
     * {@code withChannel} 在 {@code placeBlock} 内读取（通道探测结论：{@code getBlocksToPlace} 不换通道，故绝不能用它
     * 建变体）。{@code trigger == null} 时回落 运行态探针 默认 trigger。
     */
    public static BuildResult build(ProbeTarget target, ItemStack trigger, HatchPlanCache planCache) {
        BuildResult r = new BuildResult();
        r.world = new ProbeDummyWorld();
        r.player = new ProbeFakePlayer(r.world);
        r.x = PLACE_X;
        r.y = PLACE_Y;
        r.z = PLACE_Z;
        if (trigger == null) {
            r.trigger = new ItemStack(StructureLibAPI.getDefaultHologramItem(), 1);
            r.trigger.stackSize = TRIGGER_TIER;
        } else {
            r.trigger = trigger;
        }

        boolean prevThreadFlag = RunnableMachineUpdate.isCurrentThreadEnabled();
        RunnableMachineUpdate.setCurrentThreadEnabled(false);
        try {
            placeController(r, target);
            if (!r.controllerPlaced) {
                return r;
            }
            if (target.structurePlan == ProbeTarget.StructurePlan.BUILD_AND_FIND_HATCH) {
                buildStructure(r);
                findHatchSkeleton(r, planCache);
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
        if (r.placedMetaTile != null) {
            // 通道探测结论的机器判据：onItemUse 走的是 CommonBaseMetaTileEntity#createNewMetatileEntity →
            // METATILEENTITIES[id].newMetaEntity(this)，即每个变体应当拿到**全新实例**。记录实例身份，
            // 供产物证明「不存在跨变体的实例状态泄漏」；若某台机器返回 this 而不新建实例，该判据会暴露。
            r.metaTileInstanceHash = System.identityHashCode(r.placedMetaTile);
        }
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
    private static void findHatchSkeleton(BuildResult r, HatchPlanCache planCache) {
        if (r.multi == null) {
            // 不是 MTEMultiBlockBase 的多方块（例如 MTEBrickedBlastFurnace extends MetaTileEntity）：
            // 它们的结构里没有舱口符号位、也没有 mMufflerHatches 这类公开舱口清单可查，构造到此即完成。
            // 这**不是失败**：枚举事实层的总 Tier 试探对这类机器同样只做 construct。
            r.notes.add("目标不是 MTEMultiBlockBase：结构不含舱口符号位，跳过舱口骨架搜索（构造已完成）");
            r.hatchPlanSource = "not-applicable";
            return;
        }
        if (!r.structureBuilt) {
            return;
        }
        r.shapeKey = shapeKeyOf(r);
        if (planCache != null) {
            HatchPlan cached = planCache.lookup(r.shapeKey);
            if (cached != null && applyHatchPlan(r, cached)) {
                r.hatchPlanSource = "cached";
                snapshotReadiness(r);
                return;
            }
        }
        hatchSearch(r);
        if (planCache != null && !r.hatchPlacements.isEmpty()) {
            HatchPlan plan = new HatchPlan();
            plan.shapeKey = r.shapeKey;
            plan.source = "searched";
            plan.placements.addAll(r.hatchPlacements);
            for (int i = 0; i < HATCH_NAMES.length; i++) {
                plan.hatchCounts[i] = hatchCount(r.multi, i);
            }
            planCache.store(plan);
            r.hatchPlanSource = "searched";
        } else if (r.hatchPlacements.isEmpty()) {
            r.hatchPlanSource = "search-empty";
        }
        snapshotReadiness(r);
    }

    /**
     * 按缓存计划放舱口：<b>只是省掉暴力搜索</b>，放置本身仍走真实 {@code onItemUse}。放完必须用 GT 自己的公开舱口
     * 清单核对计数，一致才算命中；否则回滚所有落点并交回 {@link #hatchSearch} 全量搜索。
     */
    private static boolean applyHatchPlan(BuildResult r, HatchPlan plan) {
        List<int[]> touched = new ArrayList<int[]>();
        try {
            for (String placement : plan.placements) {
                int at = placement.indexOf('@');
                if (at <= 0) return false;
                String name = placement.substring(0, at);
                int[] p = parseCoords(placement.substring(at + 1));
                if (p == null) return false;
                int hi = hatchIndexByName(name);
                if (hi < 0) return false;
                IMetaTileEntity hatchMeta = findMetaTile(HATCH_CLASSES[hi]);
                if (hatchMeta == null) return false;
                r.world.setBlock(p[0], p[1], p[2], Blocks.air, 0, 2);
                ItemStack hatchStack = hatchMeta.getStackForm(1);
                if (hatchStack == null) return false;
                hatchStack.getItem()
                    .onItemUse(hatchStack, r.player, r.world, p[0], p[1], p[2], 0, p[0], p[1], p[2]);
                touched.add(p);
            }
            boolean formed = false;
            try {
                formed = r.multi.checkStructure(true, r.baseTile);
            } catch (Throwable t) {
                r.notes.add("applyHatchPlan checkStructure 抛出: " + t);
            }
            for (int i = 0; i < HATCH_NAMES.length; i++) {
                if (hatchCount(r.multi, i) != plan.hatchCounts[i]) {
                    rollbackHatches(r, touched);
                    return false;
                }
            }
            r.machineFormed = formed && r.multi.mMachine;
            r.hatchPlacements.addAll(plan.placements);
            return true;
        } catch (Throwable t) {
            r.notes.add("applyHatchPlan 抛出: " + t);
            rollbackHatches(r, touched);
            return false;
        }
    }

    private static void rollbackHatches(BuildResult r, List<int[]> touched) {
        for (int[] p : touched) {
            r.world.setBlock(p[0], p[1], p[2], Blocks.air, 0, 2);
        }
        // 计划落点都是结构里的空气位，清成空气即恢复；再跑一次真实 construct 以恢复任何被覆盖的结构方块。
        try {
            if (r.placedMetaTile instanceof IConstructable) {
                ((IConstructable) r.placedMetaTile).construct(r.trigger, false);
            }
        } catch (Throwable t) {
            r.notes.add("rollbackHatches 重新 construct 抛出: " + t);
        }
    }

    private static int[] parseCoords(String s) {
        String[] parts = s.split(",");
        if (parts.length != 3) return null;
        try {
            return new int[] { Integer.parseInt(parts[0].trim()), Integer.parseInt(parts[1].trim()),
                Integer.parseInt(parts[2].trim()) };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static int hatchIndexByName(String name) {
        for (int i = 0; i < HATCH_NAMES.length; i++) {
            if (HATCH_NAMES[i].equals(name)) return i;
        }
        return -1;
    }

    /** 形状键 = 已放置坐标集合（**不含方块身份**）的内容签名：替换型通道不改变形状，故同一键可复用舱口计划。 */
    static String shapeKeyOf(BuildResult r) {
        List<String> entries = new ArrayList<String>();
        for (int[] p : r.world.placedPositions()) {
            entries.add(p[0] + "," + p[1] + "," + p[2]);
        }
        entries.add("controllerMeta:" + r.controllerMeta);
        return sha256Hex(entries);
    }

    private static String sha256Hex(List<String> entries) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            for (String s : entries) {
                md.update(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                md.update((byte) '\n');
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return "sha256-unavailable:" + entries.size();
        }
    }

    /** 全量暴力搜索（运行态探针 原实现，一字未改其判据：只用 GT 的公开舱口清单，不写 {@code mMachine} 字段）。 */
    private static void hatchSearch(BuildResult r) {
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
    }

    /** 失败时把「机器还差什么」按 GT 自己的公开面记录下来，避免只报一句「没通过」。 */
    private static void snapshotReadiness(BuildResult r) {
        try {
            r.multi.checkStructure(true, r.baseTile);
        } catch (Throwable t) {
            r.notes.add("snapshot checkStructure 抛出: " + t);
        }
        r.machineFormed = r.multi.mMachine;
        /*
         * 反射调用：GT 5.09.54 重构了结构错误 API（gregtech.api.enums.StructureError 枚举 →
         * gregtech.api.structure.error 包，MTEMultiBlockBase#getStructureErrors 移除），
         * 而本树依赖基线可分层（legacy=52.283 / ctm=54.194，见 dependencies.gradle），源码须对两态
         * 同时可编译。此处是诊断记录（"机器还差什么"），反射拿不到就记一笔跳过，不影响主流程。
         */
        try {
            java.lang.reflect.Method getErrs = r.multi.getClass()
                .getMethod("getStructureErrors");
            Object errs = getErrs.invoke(r.multi);
            if (errs instanceof Iterable) {
                for (Object e : (Iterable<?>) errs) {
                    r.structureErrors.add(String.valueOf(e));
                }
            }
        } catch (NoSuchMethodException ns) {
            r.notes.add("getStructureErrors 在当前 GT 版本不存在（诊断跳过）");
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
