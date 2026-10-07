package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.tileentity.TileEntity;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.interfaces.metatileentity.IMetaTileEntity;
import gregtech.api.metatileentity.implementations.MTEMultiBlockBase;

/**
 * T1.3：把<strong>一个变体</strong>的假世界机器驱动到「待机 / 运行」两态，并在进入指定状态后<strong>断言
 * {@code isActive()}</strong>，再交给几何捕获。
 * <p>
 * 与 T0.3 运行态探针驱动的关系（该类已随 Gitea #104 按 V12 裁决删除）：机制完全相同（同一组 public 字段 + 同一条
 * {@code onPostTick} 服务端分支 + 同一道公开逃生门），差异只在<strong>用途与覆盖面</strong>：
 * T0.3 是「一次探针 + 全程 trace」，本类是「逐变体、可停、两态各一次断言」，且把
 * {@code activeMechanism} 直接记进变体产物（计划硬约束 4）。此外本类按 {@code IMetaTileEntity} 的公开接口
 * {@code onPostTick} 驱动，因此也能覆盖<strong>非 {@link MTEMultiBlockBase} 的多方块</strong>
 * （实证：{@code MTEBrickedBlastFurnace extends MetaTileEntity}）。
 *
 * <h3>驱动契约（T0.3 §4.2 的实测结论）</h3>
 * <ol>
 * <li><b>真实 TE 更新路径</b>：{@code TileEntity#updateEntity()} ×3；用只有服务端分支才会写的
 * {@code errorDisplayID} 反证 {@code onPostTick} 的服务端分支确实执行过。</li>
 * <li><b>运行态机本体</b>：{@code onPostTick(base, tick)} 循环，直到机器「结构成形」（{@code mMachine}）或
 * 「自我停工」（{@code isAllowedToWork() == false}，即 {@code stopMachine(STRUCTURE_INCOMPLETE)} 已发生），
 * 或到达 tick 上限。两者都是 GT 自己走出来的真实状态迁移，不是探针写字段伪造的。</li>
 * <li><b>进态三行</b>：{@code mProgresstime = 0; mMaxProgresstime = <0 或 模拟时长>; onPostTick(base, tick)}，
 * 然后断言 {@code base.isActive()}。活动位由 {@code setActive(mMaxProgresstime > 0)} 派生。
 * <b>这三行只对 {@link MTEMultiBlockBase} 成立</b>：它把 {@code mProgresstime}/{@code mMaxProgresstime}
 * 作为 public 字段暴露；其它基类（如 {@code MetaTileEntity}）的公开面里没有进度字段可写，
 * 本类**不用反射**（避免在受控反射内核之外新增断点）。</li>
 * <li><b>逃生门</b>：仅当第 3 步不适用或拿不到活动位且调用方允许时，才用
 * {@code IGregTechTileEntity#setActive(boolean)}（{@code IMachineProgress} 的公开方法）兜底，
 * 并在 {@link Drive#activeMechanism} 与变体产物里显式标注<strong>为什么</strong>走了这条路。</li>
 * </ol>
 */
@SideOnly(Side.CLIENT)
public final class VariantStateDriver {

    /** 真实 TE 更新路径的 tick 数（与 T0.3 一致：保持 < 10，避免触发 IC2 电网接入与客户端数据同步）。 */
    public static final int REAL_PATH_TICKS = 3;
    /** 「配方在跑」的模拟进度时长（tick）。 */
    public static final int SIMULATED_MAX_PROGRESS = 200;
    /** 运行态机 tick 上限：必须 > 101（{@code mStartUpCheck} 初值 100，{@code < 0} 才进入 {@code runMachine}）。 */
    public static final int MAX_STATE_MACHINE_TICKS = 140;

    public static final class Drive {

        public boolean worldIsRemote;
        public boolean serverSideByWorldFlag;
        public int errorDisplayIdBefore = Integer.MIN_VALUE;
        public int errorDisplayIdAfterRealPathTicks = Integer.MIN_VALUE;
        /** 服务端分支特有的副作用是否发生（证明 {@code onPostTick} 的服务端分支真的跑了）。 */
        public boolean serverBranchExecuted;
        public String realPathException;
        public int stateMachineTicks;
        /** 第一次观测到 {@code mMachine == true} 的 tick（−1 = 始终未成形）。 */
        public int structureCheckTick = -1;
        public boolean machineFormed;
        /** {@code false} = 该机不是 {@link MTEMultiBlockBase}，{@code mMachine} 不在公开面上，成形与否未知。 */
        public boolean machineFormedKnown;
        public boolean isMultiBlockBase;
        /** 是否为「自我停工」停下了循环（{@code isAllowedToWork() == false} 由 GT 自己置）。 */
        public boolean selfDisabled;
        public boolean allowedToWorkAtEnd;
        public int repairStatus = -1;
        public int idealStatus = -1;
        public int startUpCheckAtEnd = Integer.MIN_VALUE;
        public String stateMachineException;
        /** 进入「运行」态实际用了哪条路（计划硬约束 4 要求落进产物）。 */
        public String activeMechanism = "unknown";
        public boolean escapeHatchUsed;
        /** 走逃生门的具体原因（为什么没能用状态机派生）。 */
        public String escapeHatchReason = "";
        public final List<String> notes = new ArrayList<String>();
    }

    public static final class StateResult {

        public String stateId;
        public boolean requestedActive;
        /** 断言口径：进态后读到的 {@code IGregTechTileEntity#isActive()}。 */
        public boolean activeObserved;
        public int maxProgressTime;
        public int progressTime;
        public int errorDisplayId = Integer.MIN_VALUE;
        public String mechanism;
        public boolean assertionPassed;
    }

    private VariantStateDriver() {}

    /**
     * 驱动到「可进态」的稳定点：真实 TE 路径 → 运行态机循环。返回的 {@link Drive} 里含全部状态证据；机器此刻
     * 处于「已停工 / 已成形」的确定状态，可以直接调 {@link #enterIdle} / {@link #enterActive}。
     */
    public static Drive drive(MultiblockWorldBuilder.BuildResult build) {
        Drive d = new Drive();
        d.worldIsRemote = build.world.isRemote;
        d.serverSideByWorldFlag = !build.world.isRemote;
        MTEMultiBlockBase multi = build.multi;
        boolean isMulti = multi != null;
        IMetaTileEntity mte = build.placedMetaTile;
        d.isMultiBlockBase = isMulti;
        d.machineFormedKnown = isMulti;
        d.errorDisplayIdBefore = multi == null ? Integer.MIN_VALUE : multi.getErrorDisplayID();

        // ---- 1) 真实 TE 更新路径
        for (int i = 0; i < REAL_PATH_TICKS; i++) {
            try {
                TileEntity te = build.tileEntity;
                te.updateEntity();
            } catch (Throwable ex) {
                if (d.realPathException == null) {
                    d.realPathException = describe(ex);
                }
            }
        }
        d.errorDisplayIdAfterRealPathTicks = multi == null ? Integer.MIN_VALUE : multi.getErrorDisplayID();
        d.serverBranchExecuted = multi != null && d.errorDisplayIdAfterRealPathTicks != d.errorDisplayIdBefore;

        if (mte == null) {
            d.notes.add("控制器没有 IMetaTileEntity：运行态机不适用");
            return d;
        }

        if (isMulti) {
            // 维护工具置位 = 「维护仓插满工具」，让 runMachine 走「修复正常」这条真实分支
            multi.mWrench = true;
            multi.mScrewdriver = true;
            multi.mSoftMallet = true;
            multi.mHardHammer = true;
            multi.mSolderingTool = true;
            multi.mCrowbar = true;
        }

        // ---- 2) 运行态机本体（走 IMetaTileEntity 的公开 onPostTick，兼容非 MTEMultiBlockBase 的多方块）
        int tick = REAL_PATH_TICKS;
        int exceptions = 0;
        for (int i = 0; i < MAX_STATE_MACHINE_TICKS; i++) {
            tick++;
            try {
                mte.onPostTick(build.baseTile, tick);
            } catch (Throwable ex) {
                exceptions++;
                if (d.stateMachineException == null) {
                    d.stateMachineException = describe(ex);
                }
                if (exceptions > 3) {
                    break;
                }
            }
            if (isMulti) {
                if (!d.machineFormed && multi.mMachine) {
                    d.machineFormed = true;
                    d.structureCheckTick = tick;
                }
                if (d.machineFormed) {
                    break;
                }
                if (!multi.isAllowedToWork()) {
                    d.selfDisabled = true;
                    break;
                }
            } else if (!build.baseTile.isAllowedToWork()) {
                d.selfDisabled = true;
                break;
            }
        }
        d.stateMachineTicks = tick - REAL_PATH_TICKS;
        if (isMulti) {
            d.machineFormed = multi.mMachine;
            d.startUpCheckAtEnd = multi.mStartUpCheck;
            d.repairStatus = multi.getRepairStatus();
            d.idealStatus = multi.getIdealStatus();
            d.allowedToWorkAtEnd = multi.isAllowedToWork();
        } else {
            d.allowedToWorkAtEnd = build.baseTile.isAllowedToWork();
            d.notes.add(
                "目标不是 MTEMultiBlockBase（" + mte.getClass()
                    .getName() + "）：mMachine 不在公开面上，成形与否记 unknown；进「运行」态只能走公开逃生门");
        }

        if (!d.serverBranchExecuted) {
            d.notes.add("errorDisplayID 未变化，服务端分支是否执行存疑（可能被异常中断；非 MTEMultiBlockBase 无此字段）");
        }
        if (isMulti && !d.machineFormed) {
            d.notes.add("结构未成形（mMachine=false）：进态依赖状态机 + 显式驱动量，必要时用公开逃生门并标注");
        }
        return d;
    }

    /** 进入「待机」态：三段驱动量置 0 + 一 tick，断言活动位为 false。 */
    public static StateResult enterIdle(MultiblockWorldBuilder.BuildResult build, Drive d) {
        if (!d.isMultiBlockBase) {
            StateResult s = new StateResult();
            s.stateId = "idle";
            s.requestedActive = false;
            s.activeObserved = build.baseTile.isActive();
            s.assertionPassed = !s.activeObserved;
            s.mechanism = "无驱动量可注入（本机非 MTEMultiBlockBase）：真实 onPostTick ×" + d.stateMachineTicks
                + " 后 isActive()="
                + s.activeObserved;
            return s;
        }
        StateResult s = enterState(build, d, false, 0);
        s.mechanism = "onPostTick 服务端分支 + mMaxProgresstime=0（派生 setActive(false)）";
        return s;
    }

    /**
     * 进入「运行」态：{@code mProgresstime=0 / mMaxProgresstime=模拟时长} + 一 tick，断言活动位；失败且允许时退到
     * 公开逃生门并标注 {@code activeMechanism}（含原因）。
     */
    public static StateResult enterActive(MultiblockWorldBuilder.BuildResult build, Drive d, boolean allowEscapeHatch) {
        StateResult s;
        if (d.isMultiBlockBase) {
            s = enterState(build, d, true, SIMULATED_MAX_PROGRESS);
            if (s.activeObserved) {
                s.mechanism = "onPostTick 服务端分支：setActive(mMaxProgresstime > 0)";
                s.assertionPassed = true;
                d.activeMechanism = s.mechanism;
                return s;
            }
        } else {
            s = new StateResult();
            s.stateId = "active";
            s.requestedActive = true;
            s.activeObserved = build.baseTile.isActive();
            s.mechanism = "n/a";
            s.assertionPassed = false;
        }
        if (allowEscapeHatch) {
            d.escapeHatchUsed = true;
            d.escapeHatchReason = d.isMultiBlockBase
                ? "状态机未能派生活动位（mMachine=" + build.multi.mMachine + "，进度可能被 stopMachine 清零）"
                : "本机不是 MTEMultiBlockBase：公开面没有进度字段可写（不引入反射），无法用状态机派生";
            d.activeMechanism = "公开逃生门 IGregTechTileEntity#setActive(boolean)（IMachineProgress）：" + d.escapeHatchReason;
            try {
                build.baseTile.setActive(true);
            } catch (Throwable t) {
                d.notes.add("逃生门 setActive(true) 抛出: " + t);
            }
            s.mechanism = d.activeMechanism;
            s.activeObserved = build.baseTile.isActive();
            s.assertionPassed = s.activeObserved;
            d.notes.add(d.escapeHatchReason + " → 已改用公开逃生门并标注 activeMechanism");
            return s;
        }
        s.mechanism = "none（未能进入运行态）";
        s.assertionPassed = false;
        d.activeMechanism = s.mechanism;
        return s;
    }

    private static StateResult enterState(MultiblockWorldBuilder.BuildResult build, Drive d, boolean active,
        int maxProgress) {
        StateResult s = new StateResult();
        s.stateId = active ? "active" : "idle";
        s.requestedActive = active;
        MTEMultiBlockBase multi = build.multi;
        if (multi == null) {
            s.mechanism = "n/a（目标不是 MTEMultiBlockBase）";
            s.activeObserved = build.baseTile.isActive();
            s.assertionPassed = s.activeObserved == active;
            return s;
        }
        multi.mProgresstime = 0;
        multi.mMaxProgresstime = maxProgress;
        s.maxProgressTime = multi.mMaxProgresstime;
        int tick = REAL_PATH_TICKS + d.stateMachineTicks + 1;
        try {
            multi.onPostTick(build.baseTile, tick);
        } catch (Throwable ignored) {
            // 记录在 Drive.stateMachineException
        }
        s.progressTime = multi.mProgresstime;
        s.activeObserved = build.baseTile.isActive();
        s.errorDisplayId = multi.getErrorDisplayID();
        s.assertionPassed = s.activeObserved == active;
        return s;
    }

    private static String describe(Throwable t) {
        String msg = t.getMessage();
        return t.getClass()
            .getName() + (msg == null ? "" : ": " + msg);
    }
}
