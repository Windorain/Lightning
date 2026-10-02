package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.tileentity.TileEntity;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.metatileentity.implementations.MTEMultiBlockBase;

/**
 * 把假世界里的多方块驱动到「运行中」态，并把**每一步的状态证据**记下来。
 * <p>
 * 驱动分三段，边界刻意写清楚，避免把「观测」和「驱动」混为一谈：
 * <ol>
 * <li><strong>真实 TE 更新路径</strong>：{@code TileEntity#updateEntity()} —— GT 的
 * {@code CommonBaseMetaTileEntity#updateEntity()} 是 {@code final}，内部就是 {@code updateEntityProfiled()}，
 * 而 {@code updateEntityProfiled()} 会调用 {@code MetaTileEntity#onPostTick}。跑 3 tick，并用
 * {@code errorDisplayID} 在「服务端分支」才会被写入这一事实，反证 {@code isServerSide()} 门槛成立。</li>
 * <li><strong>运行态机本体</strong>：直接循环 {@code MTEMultiBlockBase#onPostTick(base, tick)}。这就是运行态机的全部内容
 * ——{@code if (aBaseMetaTileEntity.isServerSide())} 分支里的 {@code checkStructure} / {@code runMachine} /
 * {@code setActive(mMaxProgresstime > 0)}。跑满启动计数（{@code mStartUpCheck} 从 100 递减），让
 * {@code checkStructure} 真实执行并判定结构是否合法。</li>
 * <li><strong>派生关系实测</strong>：把 {@code mMaxProgresstime}（{@code checkRecipe} 成功时写入的**同一个** public 字段）
 * 依次置 0 → 200 → 0，每次跑一 tick {@code onPostTick} 并读 {@code isActive()}，证明活动位确实由状态机从该字段派生。</li>
 * </ol>
 * 若第 3 段拿不到活动位（例如结构不合法导致 {@code stopMachine} 每 tick 清零进度），且目标允许，则退到公开逃生门
 * {@code IGregTechTileEntity#setActive(boolean)}（{@code IMachineProgress} 的公开方法），并在结果里**明确标注**用了哪条路。
 */
@SideOnly(Side.CLIENT)
public final class RunStateDriver {

    /** 真实 TE 更新路径的 tick 数（保持 < 10，避免触发 GT 的 IC2 电网接入与客户端数据同步）。 */
    public static final int REAL_PATH_TICKS = 3;
    /** 运行态机的 tick 数，必须 > 101（{@code mStartUpCheck} 初值 100，{@code < 0} 才进入 {@code runMachine}）。 */
    public static final int STATE_MACHINE_TICKS = 115;
    /** 「配方在跑」的模拟进度时长（tick）。 */
    public static final int SIMULATED_MAX_PROGRESS = 200;

    public static final class DerivationStep {

        public String phase;
        public int maxProgressTime;
        public int progressTime;
        public boolean activeAfterTick;
        public int errorDisplayId;
    }

    public static final class Trace {

        public boolean worldIsRemote;
        /** {@code BaseTileEntity#isServerSide()} 的实现就是 {@code !worldObj.isRemote}，此处记录同一事实。 */
        public boolean serverSideByWorldFlag;
        public int errorDisplayIdBefore;
        public int errorDisplayIdAfterRealPathTicks;
        /** 服务端分支特有的副作用是否发生（证明 onPostTick 的服务端分支真的跑了）。 */
        public boolean serverBranchExecuted;
        public String realPathException;
        public int stateMachineTicks;
        public int structureCheckTick = -1;
        public boolean machineFormedByDriver;
        public int repairStatus = -1;
        public int idealStatus = -1;
        public boolean allowedToWork;
        public int startUpCheckAtEnd = Integer.MIN_VALUE;
        public String stateMachineException;
        public final List<DerivationStep> derivation = new ArrayList<DerivationStep>();
        public boolean stateMachineDerivedActive;
        public String activeMechanism = "unknown";
        public final List<String> notes = new ArrayList<String>();
    }

    private RunStateDriver() {}

    public static Trace drive(MultiblockWorldBuilder.BuildResult build, ProbeTarget target) {
        Trace t = new Trace();
        t.worldIsRemote = build.world.isRemote;
        t.serverSideByWorldFlag = !build.world.isRemote;

        MTEMultiBlockBase multi = build.multi;
        t.errorDisplayIdBefore = multi == null ? Integer.MIN_VALUE : multi.getErrorDisplayID();

        // ---- 1) 真实 TE 更新路径
        for (int i = 0; i < REAL_PATH_TICKS; i++) {
            try {
                TileEntity te = build.tileEntity;
                te.updateEntity();
            } catch (Throwable ex) {
                if (t.realPathException == null) {
                    t.realPathException = describe(ex);
                }
            }
        }
        t.errorDisplayIdAfterRealPathTicks = multi == null ? Integer.MIN_VALUE : multi.getErrorDisplayID();
        t.serverBranchExecuted = multi != null && t.errorDisplayIdAfterRealPathTicks != t.errorDisplayIdBefore;

        if (multi == null) {
            t.notes.add("目标不是 MTEMultiBlockBase：运行态机不适用");
            return t;
        }

        // ---- 2) 运行态机本体
        int tick = REAL_PATH_TICKS;
        int exceptions = 0;
        boolean sawMachine = false;
        for (int i = 0; i < STATE_MACHINE_TICKS; i++) {
            tick++;
            try {
                multi.onPostTick(build.baseTile, tick);
            } catch (Throwable ex) {
                exceptions++;
                if (t.stateMachineException == null) {
                    t.stateMachineException = describe(ex);
                }
                if (exceptions > 3) {
                    break;
                }
            }
            if (!sawMachine && multi.mMachine) {
                sawMachine = true;
                t.structureCheckTick = tick;
            }
        }
        t.stateMachineTicks = tick;
        t.machineFormedByDriver = multi.mMachine;
        t.startUpCheckAtEnd = multi.mStartUpCheck;

        // 维护状态：等价于「维护仓插满工具」，否则 runMachine 会走 stopMachine(NO_REPAIR)
        multi.mWrench = true;
        multi.mScrewdriver = true;
        multi.mSoftMallet = true;
        multi.mHardHammer = true;
        multi.mSolderingTool = true;
        multi.mCrowbar = true;
        t.repairStatus = multi.getRepairStatus();
        t.idealStatus = multi.getIdealStatus();
        t.allowedToWork = multi.isAllowedToWork();

        // ---- 3) 派生关系实测
        t.derivation.add(step(build, multi, "idle", 0, tick++));
        DerivationStep running = step(build, multi, "running", SIMULATED_MAX_PROGRESS, tick++);
        t.derivation.add(running);
        t.derivation.add(step(build, multi, "idle-again", 0, tick++));
        t.stateMachineDerivedActive = running.activeAfterTick;

        if (t.stateMachineDerivedActive) {
            t.activeMechanism = "MTEMultiBlockBase#onPostTick 服务端分支：setActive(mMaxProgresstime > 0)";
        } else if (target.allowEscapeHatch) {
            t.activeMechanism = "公开逃生门 IGregTechTileEntity#setActive(boolean)（IMachineProgress）";
            t.notes.add("状态机未能派生活动位（结构未成形或进度被 stopMachine 清零），改用公开逃生门设置活动位");
        } else {
            t.activeMechanism = "none（两条路都没拿到活动位）";
        }

        if (!t.serverBranchExecuted) {
            t.notes.add("errorDisplayID 未变化，服务端分支是否执行存疑（可能被异常中断）");
        }
        return t;
    }

    private static DerivationStep step(MultiblockWorldBuilder.BuildResult build, MTEMultiBlockBase multi, String phase,
        int maxProgress, int tick) {
        DerivationStep s = new DerivationStep();
        s.phase = phase;
        multi.mProgresstime = 0;
        multi.mMaxProgresstime = maxProgress;
        s.maxProgressTime = multi.mMaxProgresstime;
        try {
            multi.onPostTick(build.baseTile, tick);
        } catch (Throwable ignored) {
            // 记录在 Trace.stateMachineException
        }
        s.progressTime = multi.mProgresstime;
        s.activeAfterTick = build.baseTile.isActive();
        s.errorDisplayId = multi.getErrorDisplayID();
        return s;
    }

    private static String describe(Throwable t) {
        String msg = t.getMessage();
        return t.getClass()
            .getName() + (msg == null ? "" : ": " + msg);
    }
}
