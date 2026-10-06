package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

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

    private static final Probe[] PROBES = { new Probe("lp-te-round-trip", LpTeRoundTripAutomation::isRequested),
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
