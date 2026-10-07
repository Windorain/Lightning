package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.lightning.mod.client.meshcapture.parts.probe.CaptureChannelProbeAutomation;
import com.lightning.mod.client.meshcapture.parts.probe.LpTeRoundTripAutomation;
import com.lightning.mod.client.meshcapture.parts.probe.PartsAcceptanceAutomation;
import com.lightning.mod.client.meshcapture.parts.probe.PartsProbeAutomation;
import com.lightning.mod.client.multiblock.MultiblockPipelineAutomation;
import com.lightning.mod.client.multiblock.MultiblockScanAutomation;
import com.lightning.mod.client.multiblock.RunStateProbeAutomation;

/**
 * 既有探针激活状态（contract.md §9 的「单向避让」判据）。
 *
 * <p>
 * 六条既有自动化链（触发文件驱动）各自有自己的 {@code isRequested(mc)} 判据。控制面<b>不改动</b>
 * 它们，只在排空前问一句：现在有没有探针在跑？有就不排空——单向避让，避免两套自动化在同一 tick 里
 * 同时动世界与玩家。
 *
 * <p>
 * 本类只做只读探测：{@code isRequested} 是既有探针的既有语义（只读触发文件），调用无副作用；
 * 万一某个探测抛异常，记一条 WARN 并按「未激活」处理，绝不把异常抛给 tick 线程。
 */
public final class ProbeActivity {

    /** 单个探针的探测口。 */
    private interface ProbeCheck {

        boolean check(Minecraft mc);
    }

    /** 一条探针（名称 + 探测口）。 */
    private static final class Probe {

        private final String name;
        private final ProbeCheck check;

        Probe(String name, ProbeCheck check) {
            this.name = name;
            this.check = check;
        }
    }

    /**
     * 既有自动化链的激活判据（顺序 = {@code SdeClientAutomationTickHandler} 的接管优先级）。
     *
     * <h2>为什么必须与接管优先级<b>逐条</b>对齐（Gitea #102 / #97 §5-D6）</h2>
     *
     * 「单向避让」的判据是「既有探针会不会在这一 tick 动世界」。{@code SdeClientAutomationTickHandler}
     * 按固定优先级分派，<b>任何一条</b>命中都会接管 tick；因此本表必须覆盖它的<b>全部</b>分支，
     * 漏一条就等于「cp 与那条探针同 tick 动世界」。
     *
     * <p>
     * <b>本单修掉的缺口</b>：{@code capture-channel-probe}（接管优先级第 2）此前不在表内，
     * 于是该触发文件存在时 cp <b>不避让</b>——两套自动化同 tick 动世界，现场无法解释。
     * 这是既有缺陷（#97 §5-D6 登记），按 #102 R2-4「搬迁期必须先修」补上。
     *
     * <p>
     * 另外三条（{@code multiblock-scan} / {@code multiblock-pipeline} / {@code parts-*}）与
     * {@code multiblock-export}/{@code variant-capture} 的关系：后两者在
     * {@code MultiblockScanAutomation.isRequested} 里内嵌分派，因此 {@code multiblock-scan}
     * 这一条事实上也覆盖了它们——本表不重复登记，但把这一点写在这里以免后来者以为漏了。
     */
    private static final Probe[] PROBES = { new Probe("lp-te-round-trip", LpTeRoundTripAutomation::isRequested),
        new Probe("capture-channel-probe", CaptureChannelProbeAutomation::isRequested),
        new Probe("multiblock-pipeline", MultiblockPipelineAutomation::isRequested),
        new Probe("multiblock-scan", MultiblockScanAutomation::isRequested),
        new Probe("run-state-probe", RunStateProbeAutomation::isRequested),
        new Probe("parts-probe", PartsProbeAutomation::isRequested),
        new Probe("parts-acceptance", PartsAcceptanceAutomation::isRequested) };

    private ProbeActivity() {}

    /** 是否有任一探针激活。 */
    public static boolean any(Minecraft mc) {
        return firstActive(mc) != null;
    }

    /** 第一个激活的探针名；无则 null。 */
    public static String firstActive(Minecraft mc) {
        if (mc == null) {
            return null;
        }
        for (Probe p : PROBES) {
            try {
                if (p.check.check(mc)) {
                    return p.name;
                }
            } catch (Throwable t) {
                CpLog.warn("探针激活探测异常（%s，按未激活处理）: %s", p.name, String.valueOf(t));
            }
        }
        return null;
    }
}
