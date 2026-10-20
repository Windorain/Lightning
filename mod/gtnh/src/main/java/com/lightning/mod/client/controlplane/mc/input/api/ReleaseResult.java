package com.lightning.mod.client.controlplane.mc.input.api;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一次释放的结果（Gitea #162 冻结件 §9.3 引用了该类型但未列字段；此处落定**最小面**，
 * 字段只增不改）。
 *
 * <p>
 * 释放是**幂等**的：没有可释放的东西时返回 {@code released=0} 且 **不是错误**（§3.3）。
 * 只清**设施所持**状态，绝不碰 SDL 物理态或游戏自己的 KeyBinding 语义（§3.5）。
 */
public final class ReleaseResult {

    /** 本次实际释放的条目数。 */
    public int released;
    /** 释放的键码清单（如实给出，便于核对泄漏）。 */
    public List<Integer> keyCodes = new ArrayList<Integer>();
    /** 释放的鼠标按钮清单。 */
    public List<Integer> buttons = new ArrayList<Integer>();
    /** 释放发生的客户端 tick 序号。 */
    public long releasedAtTick;
    /** 属于哪个作业（{@code releaseAll} 时为 null）。 */
    public String jobId;

    /** 什么都没释放（幂等路径）。 */
    public static ReleaseResult none(long tick, String jobId) {
        ReleaseResult r = new ReleaseResult();
        r.released = 0;
        r.releasedAtTick = tick;
        r.jobId = jobId;
        return r;
    }

    /** 只读键码清单。 */
    public List<Integer> keyCodeList() {
        return keyCodes == null ? Collections.<Integer>emptyList() : Collections.unmodifiableList(keyCodes);
    }

    /** 只读按钮清单。 */
    public List<Integer> buttonList() {
        return buttons == null ? Collections.<Integer>emptyList() : Collections.unmodifiableList(buttons);
    }
}
