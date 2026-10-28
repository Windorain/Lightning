package com.lightning.mod.client.controlplane.core;

import java.util.Locale;

/**
 * 控制面权限级（contract.md §2 第 3 条）。
 *
 * <p>
 * 三级严格递增：{@link #OBSERVE} &lt; {@link #SCENE} &lt; {@link #FORENSIC}；高阶含低阶，
 * 即持 forensic token 的调用方同时具备 scene 与 observe 的全部权限。
 * 授权判定用 {@link #covers(Tier)}，可写判定用 {@link #isWritable()}。
 */
public enum Tier {

    /** 只读观察：状态、动作目录、作业查询、事件流水、日志 tail、产物下载。 */
    OBSERVE("observe", 0),

    /** 场景操作：世界幂等构建/快照/回滚、用例文件执行（不含取证拍摄段）。 */
    SCENE("scene", 1),

    /** 取证拍摄：截图、捕获、渲染相关动作。 */
    FORENSIC("forensic", 2);

    private final String id;
    private final int rank;

    Tier(String id, int rank) {
        this.id = id;
        this.rank = rank;
    }

    /** 配置与 JSON 中使用的稳定标识（{@code observe} / {@code scene} / {@code forensic}）。 */
    public String id() {
        return id;
    }

    /** 权限序数，数值越大权限越高。 */
    public int rank() {
        return rank;
    }

    /** 本权限级是否覆盖 {@code other}（高阶含低阶）；{@code other} 为 null 时返回 false。 */
    public boolean covers(Tier other) {
        return other != null && rank >= other.rank;
    }

    /** 是否为可写级（scene 及以上）；可写级动作的调用体必须含 {@code "confirm": true}。 */
    public boolean isWritable() {
        return rank >= SCENE.rank;
    }

    /**
     * 按稳定标识解析权限级。
     *
     * @param id 标识，可为 null、可含首尾空白、大小写不敏感
     * @return 匹配的权限级；未知或 null 返回 {@code null}（调用方据此判 CP-AUTH-002）
     */
    public static Tier parse(String id) {
        if (id == null) {
            return null;
        }
        String s = id.trim()
            .toLowerCase(Locale.ROOT);
        for (Tier t : values()) {
            if (t.id.equals(s)) {
                return t;
            }
        }
        return null;
    }
}
