package com.lightning.mod.client.controlplane.mc.cmd;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import com.lightning.mod.client.controlplane.core.Tier;

/**
 * {@code /sde} 子命令白名单表（Gitea #100 裁决 2）：**独立可审**的唯一权威。
 *
 * <h2>为什么单独成文件（任务单要求「白名单表独立可审」）</h2>
 *
 * 白名单是<b>安全边界</b>，不是实现细节：
 *
 * <ul>
 * <li><b>一处可审</b>：全部准入/排除决策集中在本文件，评审者不必翻动作实现就能回答
 * 「哪些命令能被 AI 驱动、哪些被拒、为什么」；</li>
 * <li><b>可机械核对</b>：{@link #ALL} 与 {@link #EXCLUDED} 是<b>显式枚举</b>，不是「排除法默认放行」
 * ——新增子命令时若忘了登记，{@link #classify} 会走 {@link Decision#NOT_WHITELISTED} 而**拒绝**，
 * 而不是默认放行。这是「失败显式」在通道层的落地（#96 §8.5）；</li>
 * <li><b>与命令实现解耦</b>：白名单只表达「准入 + 权限级 + 替代动作」，命令的实际执行一律走
 * 真实 {@code MinecraftServer.getCommandManager()}（见 {@code CmdExecAction}），因此白名单
 * <b>不可能</b>自己发明命令语义——它只能放行或拒绝。</li>
 * </ul>
 *
 * <h2>准入清单（#96 §6.2 首批候选，任务单逐条点名）</h2>
 *
 * {@code pos1 / pos2 / hpos1 / hpos2 / sel / start / end / setname / setframe / setstructureid /
 * record / export / multiblock / dump / status}——共 15 条，与任务单裁决 2 逐字一致。
 *
 * <h2>排除清单（含理由，不是「忘了加」）</h2>
 *
 * <ul>
 * <li>{@code web} / {@code webstop}：启动/停止内置工作区 HTTP 服务（{@code SdeWebServer}），
 * <b>涉及端口占用</b>。让 AI 经 cp 通道开第二个 HTTP 服务会产生「谁占了哪个端口」的隐式状态，
 * 且该服务与 cp 是两套独立鉴权域（contract.md §9 明示「零共享可变状态」）——放了它等于开一条
 * 绕过 cp 鉴权与事件流水的<b>第二能力路径</b>，直接违反 #96 §8.7「无隐藏通道」。
 * 人工需要时在游戏内手动执行 {@code /sde web}；控制面侧无需也不应有等价入口。</li>
 * <li>{@code hajimi} / {@code hjm}：{@code /sde hajimi <name>} 是「设输出名 → record → export → 发客户端」
 * 的四步<b>复合快捷方式</b>（{@code CommandSde} 的 {@code case "hajimi"/"hjm"}）。它不提供任何
 * 其余子命令没有的能力，却把四个动作压成一个不可分步、不可审计的原子操作——AI 需要的是
 * <b>可编排的原语</b>（{@code setname}/{@code record}/{@code export} 各自可调、各自留痕）。
 * 放行它等于给自己一条「绕过细粒度审计」的捷径，违反 #96 §8.2「命令不扭曲行为」。</li>
 * </ul>
 *
 * <h2>权限级定级（任务单「写操作类命令升格」）</h2>
 *
 * 定级口径是「这条命令会不会改变可观察状态」：
 *
 * <ul>
 * <li>{@link Tier#OBSERVE}——纯读取：{@code status}。无副作用，可被 AI 自由轮询；</li>
 * <li>{@link Tier#SCENE}——写场景/会话/缓冲区状态：选区、会话开关、命名、帧号、record、导出、
 * 注册表 dump、多方块导出。其中 {@code export}/{@code multiblock}/{@code dump} 会<b>产生文件产物</b>，
 * 但产物不是「取证材料」而是「场景数据」，按契约 §1.5「scene：场景操作」归 scene；</li>
 * <li>{@link Tier#FORENSIC}——本通道<b>无</b>此级：{@code /sde} 家族不含截图/捕获/渲染类子命令
 * （那些是 cp 自己的 {@code shot.multi}/{@code capture.*} 动作，不走命令通道）。</li>
 * </ul>
 *
 * <p>
 * 因为 scene 及以上是「可写级」，{@link Tier#SCENE} 的条目一律要求调用体带 {@code "confirm": true}——
 * 这是契约 §1.6 由权限级<b>派生</b>的行为，白名单不需要（也不应该）自己再实现一遍。
 */
public final class SdeCommandWhitelist {

    /** {@code /sde} 的命令名（白名单只覆盖这一个根命令；其余根命令一律拒）。 */
    public static final String COMMAND = "sde";

    /** 白名单外的替代动作提示（{@code export.session}，Gitea #100 裁决 14）。 */
    public static final String ALT_SESSION = "export.session";

    /** 分类判定结果。 */
    public enum Decision {

        /** 在白名单内：放行。 */
        ALLOWED,
        /** 在<b>排除</b>清单内（web/webstop/hajimi/hjm）：显式拒绝，带专属理由与替代。 */
        EXCLUDED,
        /** 是 {@code /sde} 的子命令但<b>不在</b>白名单内：显式拒绝（新增子命令忘了登记也走这里）。 */
        NOT_WHITELISTED,
        /** <b>不是</b> {@code /sde} 命令（含任意非 /sde 命令）：显式拒绝。 */
        NOT_SDE
    }

    /** 一条白名单条目。 */
    public static final class Entry {

        private final String sub;
        private final Tier tier;
        private final String summary;
        private final String alternatives;

        Entry(String sub, Tier tier, String summary, String alternatives) {
            this.sub = sub;
            this.tier = tier;
            this.summary = summary;
            this.alternatives = alternatives;
        }

        /** 子命令名（小写，与 {@code CommandSde} 的 {@code args[0].toLowerCase()} 同口径）。 */
        public String sub() {
            return sub;
        }

        /** 所需权限级。 */
        public Tier tier() {
            return tier;
        }

        /** 一句话语义（用于自描述与拒绝时的替代建议）。 */
        public String summary() {
            return summary;
        }

        /**
         * 更细粒度/更可编排的替代（自描述用，可为空串）。
         *
         * <p>
         * 注意与「被拒时的可行替代」不同：这里是「本命令虽放行，但存在更好的原语组合」的提示，
         * 供 AI 选择；拒绝时的替代建议见 {@link #alternatives()}。
         */
        public String alternatives() {
            return alternatives;
        }
    }

    /** 被排除的子命令 → 理由（显式枚举，见类注释）。 */
    private static final Map<String, String> EXCLUDED;

    /** 白名单（有序：自描述与拒绝建议按此顺序呈现，便于人读）。 */
    private static final Map<String, Entry> ALL;

    static {
        Map<String, String> ex = new LinkedHashMap<String, String>();
        ex.put(
            "web",
            "启动内置工作区 HTTP 服务（涉及端口占用），且它是与控制面并列的第二套 HTTP/鉴权域；" + "控制面契约 §9 要求二者零共享可变状态，经本通道放行等于开一条绕过控制面鉴权与事件流水的隐藏能力路径"
                + "（#96 §8.7）。需要时请在游戏内手动执行 /sde web。");
        ex.put(
            "webstop",
            "停止内置工作区 HTTP 服务；与 web 同属第二套 HTTP 服务域，控制面不代理它的启停" + "（#96 §8.7 无隐藏通道）。需要时请在游戏内手动执行 /sde webstop。");
        ex.put(
            "hajimi",
            "复合快捷方式（设输出名 → record → export → 发客户端四步合一），不提供任何其余子命令没有的能力，" + "却把四个动作压成一个不可分步、不可单独审计的原子操作，"
                + "违反 #96 §8.2「命令不扭曲行为」。请改用可编排的原语组合："
                + "cmd.exec sub=setname / record / export（或在游戏内手动执行）。");
        ex.put("hjm", "hajimi 的别名，排除理由同 hajimi（#96 §8.2）。请改用 setname / record / export 原语组合。");
        EXCLUDED = Collections.unmodifiableMap(ex);

        Map<String, Entry> all = new LinkedHashMap<String, Entry>();
        // ---- observe：纯只读 ----
        all.put(
            "status",
            new Entry(
                "status",
                Tier.OBSERVE,
                "打印 ExportSession 单例态一行摘要（session/sel/pos1/pos2/activeFrame/recordedFrames）",
                "只读读面优先用 cp 动作 " + ALT_SESSION + "（结构化 JSON，可被判据直接引用）"));
        // ---- scene：选区与会话 ----
        all.put("pos1", new Entry("pos1", Tier.SCENE, "把选区角点一记为玩家脚下方块", ""));
        all.put("pos2", new Entry("pos2", Tier.SCENE, "把选区角点二记为玩家脚下方块", ""));
        all.put("hpos1", new Entry("hpos1", Tier.SCENE, "把选区角点一记为玩家准星指向的方块", ""));
        all.put("hpos2", new Entry("hpos2", Tier.SCENE, "把选区角点二记为玩家准星指向的方块", ""));
        all.put("sel", new Entry("sel", Tier.SCENE, "设置选区模式 [cuboid|extend]（缺省 cuboid）", ""));
        all.put("start", new Entry("start", Tier.SCENE, "开始导出会话", ""));
        all.put("end", new Entry("end", Tier.SCENE, "结束导出会话", ""));
        all.put("setname", new Entry("setname", Tier.SCENE, "设置输出文件名（无后缀）", ""));
        all.put("setframe", new Entry("setframe", Tier.SCENE, "设置活动帧号（后续 record 写入该帧）", ""));
        all.put("setstructureid", new Entry("setstructureid", Tier.SCENE, "设置 structureId", ""));
        // ---- scene：录制与产物 ----
        all.put("record", new Entry("record", Tier.SCENE, "把当前选区扫入活动帧（内存，不落盘）；带参数时为连录/cycle", ""));
        all.put("export", new Entry("export", Tier.SCENE, "把内存中的帧写出为场景文件到 structure_exports/<outputName>.json", ""));
        all.put("multiblock", new Entry("multiblock", Tier.SCENE, "排队多方块导出（枚举 → 逐台变体构建捕获 → 编码 → 信封落盘）", ""));
        all.put(
            "dump",
            new Entry("dump", Tier.SCENE, "请求客户端下一 tick 生成全量注册表 JSON（block/material/model_registry.json）", ""));
        ALL = Collections.unmodifiableMap(all);
    }

    private SdeCommandWhitelist() {}

    /**
     * 分类一条命令（<b>唯一入口</b>，动作实现只许调它）。
     *
     * @param rootCommand 根命令名（不含前导 '/'；大小写不敏感）；null 视为非 /sde
     * @param subCommand  子命令名（{} 可为 null/空——{@code /sde} 裸命令）；大小写不敏感
     * @return 判定结果（{@link Decision#ALLOWED} 时 {@link #entry} 必非 null）
     */
    public static Decision classify(String rootCommand, String subCommand) {
        if (rootCommand == null || !COMMAND.equals(
            rootCommand.trim()
                .toLowerCase(Locale.ROOT))) {
            return Decision.NOT_SDE;
        }
        String sub = subCommand == null ? ""
            : subCommand.trim()
                .toLowerCase(Locale.ROOT);
        if (EXCLUDED.containsKey(sub)) {
            return Decision.EXCLUDED;
        }
        if (ALL.containsKey(sub)) {
            return Decision.ALLOWED;
        }
        return Decision.NOT_WHITELISTED;
    }

    /** 取白名单条目；不在白名单（含被排除）返回 null。 */
    public static Entry entry(String subCommand) {
        String sub = subCommand == null ? ""
            : subCommand.trim()
                .toLowerCase(Locale.ROOT);
        return ALL.get(sub);
    }

    /** 被排除子命令的理由；不在排除清单返回 null。 */
    public static String exclusionReason(String subCommand) {
        String sub = subCommand == null ? ""
            : subCommand.trim()
                .toLowerCase(Locale.ROOT);
        return EXCLUDED.get(sub);
    }

    /** 全部白名单子命令名（按登记顺序）。 */
    public static List<String> allowedSubcommands() {
        return new ArrayList<String>(ALL.keySet());
    }

    /** 全部被排除子命令名（按登记顺序）。 */
    public static List<String> excludedSubcommands() {
        return new ArrayList<String>(EXCLUDED.keySet());
    }

    /** 全部已知子命令 = 白名单 + 排除；用于「未知子命令」与「已知但未准入」的区分。 */
    public static Set<String> knownSubcommands() {
        Set<String> s = new HashSet<String>(ALL.keySet());
        s.addAll(EXCLUDED.keySet());
        return s;
    }

    /** 被排除条目 → 理由（自描述用；只读）。 */
    public static Map<String, String> exclusions() {
        return EXCLUDED;
    }

    /** {@code /sde} 全部子命令的用法串（与 {@code CommandSde#getCommandUsage} 同源语义，供自描述引用）。 */
    public static String usageSummary() {
        return "/sde " + String.join(
            " | ",
            Arrays.asList(
                "pos1",
                "pos2",
                "hpos1",
                "hpos2",
                "sel [cuboid|extend]",
                "start",
                "end",
                "setName",
                "setFrame",
                "setStructureId",
                "record [N|cycle]",
                "export [raw]",
                "multiblock [all|<name,...>] [limit=N]",
                "dump",
                "status"));
    }
}
