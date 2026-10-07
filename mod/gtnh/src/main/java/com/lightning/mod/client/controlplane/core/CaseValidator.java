package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 用例校验器：产出「规范化执行计划」（case-file.md §9 的 {@code case.validate} 数据源）。
 *
 * <p>
 * 分工：{@link CaseParser} 负责「字段名/类型/未知字段」，本类负责「取值范围、判据参数完备性、
 * 证据清单与负对照补丁的可执行性」。所有问题累计后一次性抛 {@code CP-VALID-002}
 * （{@code context.fields} 逐字段说明）。
 *
 * <p>
 * 规范化点是运行器的<b>唯一输入</b>：坐标已展开为绝对坐标、默认值已补齐（{@code settleTicks=60}、
 * {@code meta=0}、{@code minBytes=1}、{@code minCount=1}），因此交互路径与无人值守路径不会因为
 * 「谁负责填默认值」而产生偏差。
 */
public final class CaseValidator {

    /**
     * 变体补丁适用性判定模式（{@link #plan(CaseFile, VariantCheck)}）。
     *
     * <h2>为什么需要两种模式</h2>
     * 「补丁必须改变用例内容」这条判定只在<b>原始</b>用例文件上成立：空转的负对照会制造恒绿假断言，
     * 必须拦住。但变体执行路径（{@code case.run} 的 {@code variant} 参数与整跑后的变体扫描）会
     * <b>先</b>把补丁应用到用例上，再拿<b>产物文档</b>过一遍校验——在那份文档上补丁本来就是幂等的，
     * 再应用一次必然「什么都没改」。同一判定用在这里就是误报（实测：冒烟 A8 的负对照
     * {@code neg-manifest-missing} 被判成「补丁未改变用例内容」，变体评估整段被跳过，A8 假红）。
     * 原始文件的那一遍校验由 {@code CaseSources.resolve} 用 {@link #ENFORCE} 完成，因此产物文档
     * 这一遍用 {@link #SKIP} 是安全的。
     */
    public enum VariantCheck {

        /** 补丁必须改变用例内容（空转即 CP-VALID-002）；用于<b>原始</b>用例文件。 */
        ENFORCE,
        /** 不判定适用性：文档本身已是补丁产物；用于变体执行路径的二次校验。 */
        SKIP
    }

    /** 1.7.10 世界高度范围。 */
    public static final int MIN_Y = 0;

    /** 见 {@link #MIN_Y}。 */
    public static final int MAX_Y = 255;

    /** 水平坐标绝对值上限（与原版世界边界一致）。 */
    public static final int MAX_HORIZONTAL = 30000000;

    /** 1.7.10 方块 meta 取值上限。 */
    public static final int MAX_META = 15;

    /**
     * 用例执行段（case-file.md §8；段序即执行序）。
     *
     * <p>
     * PR-2 起 {@code capture}/{@code cameras} 不再是「延后段」，而是真实执行段：{@code capture}
     * 段建立捕获会话（{@code capture.begin}），{@code cameras} 段逐机位拍摄，证据段收尾时释放。
     * 因此在 {@code build} 之后、{@code criteria} 之前插入两段——{@code world→capture→build} 的
     * 契约口径是「capture 段包住 build 之后的区间」，而会话标志对开场作业自身放行，故把 capture
     * 排在 build 之前即可同时满足「build 在会话内」与「build 写出世界后立刻受保护」。
     */
    public static final List<String> SEGMENTS;

    static {
        List<String> s = new ArrayList<String>();
        s.add("world");
        s.add("capture");
        s.add("build");
        s.add("read");
        s.add("action");
        s.add("export");
        s.add("cameras");
        s.add("criteria");
        s.add("evidence");
        SEGMENTS = java.util.Collections.unmodifiableList(s);
    }

    /**
     * {@code read} 段的动作名前缀（v1.3，issue #98）。
     *
     * <p>
     * 只允许 {@code read.*}：读面段的语义是「读世界并落产物」，放进写动作会让
     * 「读面只读」这条纪律失去一个可静态检查的落点（而且写动作该走 build 段）。
     */
    public static final String READ_ACTION_PREFIX = "read.";

    /**
     * {@code export} 段的动作名前缀（v1.7，Gitea #102）。
     *
     * <p>
     * 只允许 {@code export.*}：导出段的语义是「把当前世界状态写成场景文件/注册表/数据集」，
     * 放进读动作会让「导出件真的落进了本 run」这条 C4 判据失去静态可查的落点。
     */
    public static final String EXPORT_ACTION_PREFIX = "export.";

    /**
     * {@code export} 段<b>额外</b>允许的两个非 {@code export.*} 动作（v1.7，Gitea #102）。
     *
     * <h2>为什么必须开这两个口子（不是偷懒）</h2>
     *
     * C4 要求「导出件与实拍/观测记录<b>同一 run</b>」，因此导出必须发生在用例<b>内部</b>。
     * 但「把当前世界状态扫进指定帧」（{@code /sde record}）**只有命令通道**可达——
     * #100 已裁决录制不提供 cp 动作（它是命令态原语，见 {@code SdeCommandWhitelist}）。
     * 因此用例若要自己造出可导出的帧缓冲，就必须能在段内跑 {@code cmd.exec}。
     *
     * <p>
     * 而 {@code /sde pos1|pos2|hpos1|hpos2} 的坐标**只来自玩家实体**（没有坐标参数），
     * 于是「构造一个非平凡的选区」必须能移动玩家。{@code scene.player.pose}（L0，同步、确定性）
     * 是做这件事的正确原语——{@code player.move}（L1）会走真实物理，不确定也不必要。
     *
     * <p>
     * <b>为什么不是「段内放任何动作都行」</b>：那会让人把 {@code world.rebuild} 塞进导出段，
     * 绕开段序纪律（{@code world} 必须是第一段，见 §8.8 hermetic 纪律）。
     * 白名单把口子限死在「造帧缓冲 + 摆玩家」这两件导出<b>前置</b>事实上。
     *
     * <p>
     * {@code cmd.exec} 还有第二层限制：它携带的子命令必须是**成帧类**（见
     * {@link #EXPORT_SEGMENT_FRAMING_SUBS}）——{@code /sde export} / {@code dump} / {@code multiblock}
     * 在段内被拒，因为它们各有专用动作（{@code export.scene} / {@code export.registry} /
     * {@code export.multiblock}），放行等于开第二条产物路径（#96 §8.7「无隐藏通道」）。
     */
    public static final java.util.Set<String> EXPORT_SEGMENT_EXTRA_ACTIONS = java.util.Collections
        .unmodifiableSet(new java.util.LinkedHashSet<String>(java.util.Arrays.asList("cmd.exec", "scene.player.pose")));

    /**
     * {@code export} 段内允许 {@code cmd.exec} 携带的 {@code /sde} 子命令（成帧类）。
     *
     * <p>
     * 不含 {@code export} / {@code dump} / {@code multiblock}：它们有专用动作，
     * 命令形式在段内放行会绕过「产物落 run + 登记」的纪律。
     */
    public static final java.util.Set<String> EXPORT_SEGMENT_FRAMING_SUBS = java.util.Collections.unmodifiableSet(
        new java.util.LinkedHashSet<String>(
            java.util.Arrays.asList(
                "pos1",
                "pos2",
                "hpos1",
                "hpos2",
                "sel",
                "start",
                "end",
                "setname",
                "setframe",
                "setstructureid",
                "record",
                "status")));

    /**
     * {@code action} 段（v1.6，issue #103）禁止编排的动作：无人值守收尾原语。
     *
     * <p>
     * {@code core.shutdown} 的语义是「本进程跑完就退出」，把它编进固定程序会让一次
     * {@code case.run} 在跑到那一步时把整个客户端带走——后续步骤、criteria 段、evidence 段
     * 全部作废，而调用方（无人值守驱动）拿到的是一份「跑了一半」的 run。收尾必须由驱动在
     * <b>整跑结束后</b>单独发起（这也是它注册为 {@code confirm} 级可写动作的原因）。
     *
     * <p>
     * 同族的还有「会让进程退出/重启」的动作，一律不许进编排段——判据是「该动作会不会让本作业
     * 之后的段不再执行」，而不是「它危险不危险」（{@code world.rebuild} 同样危险，但它有返回）。
     */
    public static final java.util.Set<String> ACTION_FORBIDDEN = java.util.Collections
        .unmodifiableSet(new java.util.LinkedHashSet<String>(java.util.Arrays.asList("core.shutdown")));

    /** {@code action} 段逐步断言的单步最大条目数（防一次编排写出上万条断言）。 */
    public static final int MAX_STEP_EXPECT = 64;

    /** 解析并校验，返回规范化计划。 */
    public static JsonObject validate(String text) {
        CaseFile file = new CaseParser().parse(text);
        return new CaseValidator().plan(file);
    }

    /**
     * 产出规范化执行计划。
     *
     * @throws CpException CP-VALID-002：存在逐字段问题
     */
    public JsonObject plan(CaseFile file) {
        return plan(file, VariantCheck.ENFORCE);
    }

    /**
     * 产出规范化执行计划。
     *
     * @param variantCheck 变体补丁适用性判定模式；文档本身已是补丁产物时用
     *                     {@link VariantCheck#SKIP}（见该枚举的说明）
     * @throws CpException CP-VALID-002：存在逐字段问题
     */
    public JsonObject plan(CaseFile file, VariantCheck variantCheck) {
        VariantCheck check = variantCheck == null ? VariantCheck.ENFORCE : variantCheck;
        Fields fields = new Fields();
        List<String> warnings = new ArrayList<String>(file.warnings());

        JsonObject world = validateWorld(file, fields);
        JsonArray build = validateBuild(file, fields, warnings);
        JsonArray read = validateRead(file, fields, warnings);
        JsonArray action = validateAction(file, fields, warnings);
        JsonArray export = validateExport(file, fields, warnings);
        JsonObject capture = validateCapture(file, fields);
        JsonArray cameras = validateCameras(file, fields, warnings);
        JsonArray criteria = validateCriteria(file, fields);
        JsonArray evidence = validateEvidence(file, fields);
        JsonArray variants = validateVariants(file, criteria, fields, check);
        // read 与 action 两段共享同一个 run 目录（都经 ActionContext.withParams 落产物），
        // 因此跨段重名同样会让后写者静默覆盖前写者——判据引用哪一份就说不清了。
        // 段内重名各自已判，这里只补跨段那一半（一个定义点：本方法）。
        crossSegmentPathConflicts(read, action, fields);
        if (build.size() == 0) {
            warnings.add("build 段为空：世界将只有种子与虚空地形");
        }
        if (cameras != null && cameras.size() > 0) {
            // case-file.md §4：含 cameras 段的用例必须 forensic 调用（运行期升格检查，见 CaseRunAction）
            warnings.add("cameras 段非空：case.run 需 forensic 级 token（运行期按内容升格校验，CP-AUTH-002）");
        }

        fields.throwIfAny("用例执行计划非法（" + fields.size() + " 处）");

        JsonObject plan = new JsonObject();
        plan.addProperty("schema", Contract.SCHEMA_CASE);
        plan.addProperty("id", file.id());
        if (file.label() != null) {
            plan.addProperty("label", file.label());
        }
        plan.addProperty("caseSha256", file.sha256());
        plan.add("world", world);
        JsonArray segments = new JsonArray();
        for (String s : SEGMENTS) {
            Json.add(segments, s);
        }
        plan.add("segments", segments);
        plan.add("build", build);
        plan.add("read", read);
        plan.add("action", action);
        plan.add("export", export);
        if (capture != null) {
            plan.add("capture", capture);
        }
        if (cameras != null) {
            plan.add("cameras", cameras);
        }
        plan.add("criteria", criteria);
        plan.add("variants", variants);
        JsonObject ev = new JsonObject();
        ev.add("expect", evidence);
        plan.add("evidence", ev);
        JsonArray warnArr = new JsonArray();
        for (String w : warnings) {
            Json.add(warnArr, w);
        }
        plan.add("warnings", warnArr);
        return plan;
    }

    // ------------------------------------------------------------ 各段

    private JsonObject validateWorld(CaseFile file, Fields fields) {
        CaseFile.World w = file.world();
        JsonObject out = w.toJson();
        int[] base = w.base();
        if (base != null) {
            checkCoords(base, "world.base", fields);
        }
        return out;
    }

    private JsonArray validateBuild(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray out = new JsonArray();
        List<CaseFile.Step> steps = file.build();
        for (int i = 0; i < steps.size(); i++) {
            CaseFile.Step step = steps.get(i);
            String ctx = "build[" + i + "]";
            String op = step.op();
            JsonObject json = step.json();
            if (op == null) {
                fields.add(ctx + ".op", "缺失");
                continue;
            }
            switch (op) {
                case "clear": {
                    int[] from = step.from();
                    int[] to = step.to();
                    if (from == null) {
                        fields.add(ctx + ".from", "缺失或非法");
                    } else {
                        checkCoords(from, ctx + ".from", fields);
                    }
                    if (to == null) {
                        fields.add(ctx + ".to", "缺失或非法");
                    } else {
                        checkCoords(to, ctx + ".to", fields);
                    }
                    if (from != null && to != null) {
                        for (int k = 0; k < 3; k++) {
                            if (from[k] > to[k]) {
                                fields.add(ctx, "清场范围非法：第 " + k + " 轴 from " + from[k] + " > to " + to[k]);
                                break;
                            }
                        }
                    }
                    break;
                }
                case "block": {
                    int[] at = step.at();
                    if (at == null) {
                        fields.add(ctx + ".at", "缺失或非法");
                    } else {
                        checkCoords(at, ctx + ".at", fields);
                    }
                    String blockId = step.blockId();
                    if (blockId != null && blockId.indexOf(':') < 0) {
                        warnings.add(ctx + ".id 未带命名空间（" + blockId + "），按 minecraft: 前缀处理");
                    }
                    int meta = step.meta();
                    if (meta < 0 || meta > MAX_META) {
                        fields.add(ctx + ".meta", "须在 0.." + MAX_META + "，收到 " + meta);
                    }
                    break;
                }
                case "te": {
                    int[] at = step.at();
                    if (at == null) {
                        fields.add(ctx + ".at", "缺失或非法");
                    } else {
                        checkCoords(at, ctx + ".at", fields);
                    }
                    String completer = step.completer();
                    if (completer == null || completer.trim()
                        .isEmpty()) {
                        fields.add(ctx + ".completer", "缺失或为空");
                    }
                    break;
                }
                case "wait": {
                    int ticks = step.ticks();
                    if (ticks < 0) {
                        fields.add(ctx + ".ticks", "不得为负");
                    }
                    break;
                }
                default:
                    fields.add(ctx + ".op", "未知 op: " + op);
            }
            JsonObject item = Json.copyObject(json);
            item.addProperty("index", i);
            out.add(item);
        }
        return out;
    }

    /**
     * {@code read} 段（v1.3，issue #98）：读面步骤清单的校验。
     *
     * <p>
     * 校验三件事：动作名已注册且以 {@code read.} 开头（读面段只放读动作）、{@code path} 是合法
     * 的 run 目录内相对路径、同一次用例内 {@code path} 不重复（重复会让后一步静默覆盖前一步的产物，
     * 而判据引用的是哪一份就说不清了）。
     *
     * <p>
     * 动作是否「真的存在」在这里<b>查不到</b>（core 层没有动作注册表——那是 mc 层装配的东西），
     * 因此本类只做前缀与形态判定，存在性由 {@code case.run} 的 {@code read} 段执行期判定并报
     * {@code CP-VALID-001}。这一分工与既有的「core 校验形态、mc 校验运行期」一致。
     */
    private JsonArray validateRead(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray out = new JsonArray();
        java.util.Set<String> seen = new java.util.LinkedHashSet<String>();
        List<CaseFile.ReadStep> steps = file.read();
        for (int i = 0; i < steps.size(); i++) {
            CaseFile.ReadStep step = steps.get(i);
            String ctx = "read[" + i + "]";
            String action = step.action();
            if (action == null || action.trim()
                .isEmpty()) {
                fields.add(ctx + ".action", "必填");
            } else if (!action.startsWith(READ_ACTION_PREFIX)) {
                fields.add(ctx + ".action", "读面段只接受 " + READ_ACTION_PREFIX + "* 动作（读面只读；写动作走 build 段），收到: " + action);
            }
            String path = step.path();
            if (path == null || path.trim()
                .isEmpty()) {
                fields.add(ctx + ".path", "必填");
            } else {
                checkRelPath(path, ctx + ".path", fields);
                if (!seen.add(path)) {
                    fields.add(ctx + ".path", "同一次用例内读面产物路径重复: " + path + "（后一步会覆盖前一步）");
                }
                if ("manifest.json".equals(path) || "criteria.json".equals(path)
                    || "evidence.json".equals(path)
                    || "observation.json".equals(path)) {
                    fields.add(ctx + ".path", "不得与运行器自身产物重名: " + path);
                }
            }
            JsonObject item = Json.copyObject(step.toJson());
            item.addProperty("index", i);
            out.add(item);
        }
        if (steps.size() == 0) {
            warnings.add("read 段为空：本 run 不产读面产物（criteria 不能引用 read/*.json）");
        }
        return out;
    }

    /**
     * {@code export} 段（v1.7，Gitea #102）：导出步骤清单的校验。
     *
     * <p>
     * 校验三件事：动作名是 {@code export.*}，**或者**在
     * {@link #EXPORT_SEGMENT_EXTRA_ACTIONS} 白名单内（{@code cmd.exec}/{@code scene.player.pose}，
     * 理由见该常量的注释）；{@code cmd.exec} 的子命令必须是
     * {@link #EXPORT_SEGMENT_FRAMING_SUBS} 内的成帧类；{@code params} 是对象。
     *
     * <p>
     * <b>不</b>校验落点——导出产物的相对路径由动作自己决定（run 目录的 {@code export/} 下），
     * 段里声明落点会与动作实现产生第二处真相。存在性同 {@link #validateRead}：执行期判定。
     */
    private JsonArray validateExport(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray out = new JsonArray();
        List<CaseFile.ReadStep> steps = file.export();
        for (int i = 0; i < steps.size(); i++) {
            CaseFile.ReadStep step = steps.get(i);
            String ctx = "export[" + i + "]";
            String action = step.action();
            if (action == null || action.trim()
                .isEmpty()) {
                fields.add(ctx + ".action", "必填");
            } else if (!action.startsWith(EXPORT_ACTION_PREFIX)) {
                if (!EXPORT_SEGMENT_EXTRA_ACTIONS.contains(action)) {
                    fields.add(
                        ctx + ".action",
                        "导出段只接受 " + EXPORT_ACTION_PREFIX
                            + "* 动作或白名单内的 "
                            + EXPORT_SEGMENT_EXTRA_ACTIONS
                            + "（后者是造帧缓冲/摆玩家的前置事实，理由见 CaseValidator 常量注释），收到: "
                            + action);
                } else if ("cmd.exec".equals(action)) {
                    // 第二层限制：只许成帧类子命令——export/dump/multiblock 各有专用动作，
                    // 命令形式在段内放行等于开第二条产物路径（#96 §8.7 无隐藏通道）
                    String sub = sdeSubOf(step.params());
                    if (sub == null) {
                        fields.add(ctx + ".params.command", "cmd.exec 在导出段内必须携带形如 \"/sde <sub>\" 的命令");
                    } else if (!EXPORT_SEGMENT_FRAMING_SUBS.contains(sub)) {
                        fields.add(
                            ctx + ".params.command",
                            "导出段内的 cmd.exec 只允许成帧类子命令 " + EXPORT_SEGMENT_FRAMING_SUBS
                                + "；"
                                + "/sde "
                                + sub
                                + " 请改用对应的专用动作"
                                + ("export".equals(sub) ? "（export.scene）"
                                    : "dump".equals(sub) ? "（export.registry）"
                                        : "multiblock".equals(sub) ? "（export.multiblock）" : ""));
                    }
                }
            }
            JsonObject item = Json.copyObject(step.toJson());
            item.addProperty("index", i);
            out.add(item);
        }
        if (steps.size() == 0) {
            warnings.add("export 段为空：本 run 不产导出件（C4「导出件与实拍/观测同 run」需要有导出步骤）");
        }
        return out;
    }

    /**
     * {@code action} 段（v1.6，issue #103）：L2 编排步骤清单的校验。
     *
     * <h2>与 {@code read} 段的对称与差异</h2>
     * 两段的形态逐字段相同（{@code action/params/path/role}），差别只在纪律：
     * <ul>
     * <li>{@code read} 段用<b>动作名前缀</b>做静态纪律（只许 {@code read.*}）；</li>
     * <li>本段<b>不限前缀</b>（它的本职就是调 L0/L1 写动作），改用两条别的静态纪律：
     * ①<b>禁编排收尾原语</b>（{@link #ACTION_FORBIDDEN}，见那里的说明）；
     * ②路径不得与运行器自身产物重名、同段内不得重复、不得穿越（与 {@code read} 段同源判定）。</li>
     * </ul>
     *
     * <p>
     * 「动作是否真的已注册、是不是同步动作」在 core 层查不到（core 没有动作注册表——那是 mc 层
     * 装配的），因此由 {@code case.run} 的 {@code action} 段执行期判定并报 {@code CP-VALID-001}
     * （与 {@code read} 段完全同一分工）。<b>同步性必须在执行期判</b>：步进动作跨 tick，
     * 而本段在单次 {@code advance} 里逐条跑完。
     */
    private JsonArray validateAction(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray out = new JsonArray();
        Set<String> seen = new LinkedHashSet<String>();
        List<CaseFile.ActionStep> steps = file.action();
        for (int i = 0; i < steps.size(); i++) {
            CaseFile.ActionStep step = steps.get(i);
            String ctx = "action[" + i + "]";
            String action = step.action();
            if (action == null || action.trim()
                .isEmpty()) {
                fields.add(ctx + ".action", "必填");
            } else if (ACTION_FORBIDDEN.contains(action)) {
                fields.add(ctx + ".action", "收尾原语不得编入固定程序: " + action + "（它会让本作业后续段不再执行；收尾由驱动在整跑结束后单独发起）");
            }
            String path = step.path();
            if (path == null || path.trim()
                .isEmpty()) {
                fields.add(ctx + ".path", "必填");
            } else {
                checkRelPath(path, ctx + ".path", fields);
                if (!seen.add(path)) {
                    fields.add(ctx + ".path", "同一次用例内编排产物路径重复: " + path + "（后一步会覆盖前一步）");
                }
                if ("manifest.json".equals(path) || "criteria.json".equals(path)
                    || "evidence.json".equals(path)
                    || "observation.json".equals(path)) {
                    fields.add(ctx + ".path", "不得与运行器自身产物重名: " + path);
                }
            }
            validateStepExpect(step, ctx, fields);
            JsonObject item = Json.copyObject(step.toJson());
            item.addProperty("index", i);
            out.add(item);
        }
        if (steps.size() == 0) {
            warnings.add("action 段为空：本 run 不编排任何动作（L0/L1 一步也不跑）");
        }
        return out;
    }

    /** 从 {@code cmd.exec} 的 params 里取出 {@code /sde} 子命令（小写）；取不到返回 null。 */
    private static String sdeSubOf(JsonObject params) {
        String command = Json.optString(params, "command", null);
        if (command == null) {
            return null;
        }
        String body = command.trim();
        if (body.startsWith("/")) {
            body = body.substring(1);
        }
        String[] parts = body.split("\\s+");
        if (parts.length < 2 || !"sde".equalsIgnoreCase(parts[0])) {
            return null;
        }
        return parts[1].toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * 逐步断言（{@code action[i].expect}）的形态校验。
     *
     * <p>
     * 形态是 {@code {RFC 6901 指针: 期望值}}——一个对象里可以放多条断言，全部必须命中。
     * 指针必须 {@code /} 开头（{@code ""} 表示整棵结果对象）；空对象是<b>错误</b>而不是
     * 「不断言」：写了 {@code expect:{}} 的意图必然是断言，而空断言集永远为真（恒绿假断言）。
     * 要「不断言」就不写这个字段。
     */
    private void validateStepExpect(CaseFile.ActionStep step, String ctx, Fields fields) {
        if (!step.hasExpect()) {
            return;
        }
        JsonObject expect = step.expect();
        if (expect == null || Json.size(expect) == 0) {
            fields.add(ctx + ".expect", "不得为空对象（空断言集恒绿；要不断言就别写 expect）");
            return;
        }
        if (Json.size(expect) > MAX_STEP_EXPECT) {
            fields.add(ctx + ".expect", "单步断言上限 " + MAX_STEP_EXPECT + " 条，收到 " + Json.size(expect));
        }
        for (java.util.Map.Entry<String, com.google.gson.JsonElement> e : Json.entries(expect)) {
            String pointer = e.getKey();
            if (pointer == null || (!pointer.isEmpty() && !pointer.startsWith("/"))) {
                fields.add(ctx + ".expect." + pointer, "指针须以 / 开头或为空串（RFC 6901），收到: " + pointer);
            }
        }
    }

    /**
     * 跨段产物路径冲突（{@code read} ↔ {@code action}）。
     *
     * <p>
     * 两段都经 {@link ActionContext#withParams} 把产物落<b>同一个 run 目录</b>，因此重名会让
     * 后写者静默覆盖前写者。段内重名各自已在 {@link #validateRead}/{@link #validateAction} 判过；
     * 这里只补跨段那一半——判据引用哪一份必须说得清。
     */
    private void crossSegmentPathConflicts(JsonArray read, JsonArray action, Fields fields) {
        java.util.Set<String> readPaths = new java.util.LinkedHashSet<String>();
        for (int i = 0; i < read.size(); i++) {
            readPaths.add(
                Json.optString(
                    read.get(i)
                        .getAsJsonObject(),
                    "path",
                    ""));
        }
        for (int i = 0; i < action.size(); i++) {
            String path = Json.optString(
                action.get(i)
                    .getAsJsonObject(),
                "path",
                "");
            if (!path.isEmpty() && readPaths.contains(path)) {
                fields.add("action[" + i + "].path", "与 read 段的产物路径重名: " + path + "（两段共享同一 run 目录，后写者会静默覆盖前写者）");
            }
        }
    }

    private JsonArray validateCriteria(CaseFile file, Fields fields) {
        JsonArray out = new JsonArray();
        List<CaseFile.Criterion> criteria = file.criteria();
        for (int i = 0; i < criteria.size(); i++) {
            CaseFile.Criterion c = criteria.get(i);
            String ctx = "criteria[" + i + "]";
            JsonObject params = Json.copyObject(c.params());
            String type = c.type();
            if (type == null) {
                fields.add(ctx + ".type", "缺失");
                continue;
            }
            switch (type) {
                case CriteriaEngine.TYPE_ARTIFACT_EXISTS:
                    requirePathParam(params, ctx, fields);
                    break;
                case CriteriaEngine.TYPE_ARTIFACT_NONEMPTY: {
                    requirePathParam(params, ctx, fields);
                    if (params.has("minBytes")) {
                        JsonElement mb = params.get("minBytes");
                        if (!mb.isJsonPrimitive() || !mb.getAsJsonPrimitive()
                            .isNumber()) {
                            fields.add(ctx + ".params.minBytes", "须为整数");
                        } else if (mb.getAsLong() < 0) {
                            fields.add(ctx + ".params.minBytes", "不得为负");
                        }
                    } else {
                        params.addProperty("minBytes", 1);
                    }
                    break;
                }
                case CriteriaEngine.TYPE_JSON_FIELD: {
                    requirePathParam(params, ctx, fields);
                    String pointer = Json.optString(params, "pointer", null);
                    if (pointer == null) {
                        fields.add(ctx + ".params.pointer", "必填（RFC 6901 指针，如 /a/b/0）");
                    } else if (!pointer.isEmpty() && !pointer.startsWith("/")) {
                        fields.add(ctx + ".params.pointer", "指针须以 / 开头或为空串");
                    }
                    if (!c.hasExpect()) {
                        fields.add(ctx + ".expect", "json-field 必填");
                    }
                    break;
                }
                case CriteriaEngine.TYPE_WORLD_HASH_EQUALS:
                    break;
                case CriteriaEngine.TYPE_EVENT_EMITTED: {
                    String kind = Json.optString(params, "kind", null);
                    if (kind == null || kind.trim()
                        .isEmpty()) {
                        fields.add(ctx + ".params.kind", "必填");
                    }
                    if (params.has("minCount")) {
                        JsonElement mc = params.get("minCount");
                        if (!mc.isJsonPrimitive() || !mc.getAsJsonPrimitive()
                            .isNumber()) {
                            fields.add(ctx + ".params.minCount", "须为整数");
                        } else if (mc.getAsLong() < 0) {
                            fields.add(ctx + ".params.minCount", "不得为负");
                        }
                    } else {
                        params.addProperty("minCount", 1);
                    }
                    break;
                }
                case CriteriaEngine.TYPE_IMAGE_SIZE_EQUALS: {
                    requirePathParam(params, ctx, fields);
                    requirePositiveInt(params, "width", ctx, fields);
                    requirePositiveInt(params, "height", ctx, fields);
                    break;
                }
                case CriteriaEngine.TYPE_IMAGE_NOT_UNIFORM: {
                    requirePathParam(params, ctx, fields);
                    requireRatio(params, "maxSameColorRatio", ImageCriteria.DEFAULT_MAX_SAME_COLOR_RATIO, ctx, fields);
                    break;
                }
                case CriteriaEngine.TYPE_IMAGE_UNIFORM: {
                    requirePathParam(params, ctx, fields);
                    requireRatio(params, "minSameColorRatio", ImageCriteria.DEFAULT_MIN_SAME_COLOR_RATIO, ctx, fields);
                    break;
                }
                case CriteriaEngine.TYPE_TE_STATE_EQUALS: {
                    // 运行期轨判据：at/key/expect 三者缺一不可（求值在 mc 侧，见 CaseRunAction 的注入）
                    int[] at = ints(params, "at");
                    if (at == null) {
                        fields.add(ctx + ".params.at", "必填，且须为 [x,y,z] 三个整数（绝对坐标）");
                    } else {
                        checkCoords(at, ctx + ".params.at", fields);
                    }
                    String key = Json.optString(params, "key", null);
                    if (key == null) {
                        fields.add(ctx + ".params.key", "必填（RFC 6901 指针，指向 TE 描述器输出，如 /connections/UP）");
                    } else if (!key.isEmpty() && !key.startsWith("/")) {
                        fields.add(ctx + ".params.key", "指针须以 / 开头或为空串");
                    }
                    if (!c.hasExpect()) {
                        fields.add(ctx + ".expect", "te-state-equals 必填");
                    }
                    break;
                }
                default:
                    fields.add(ctx + ".type", "未知判据类型: " + type);
            }
            JsonObject item = new JsonObject();
            item.addProperty("id", c.id());
            item.addProperty("type", type);
            item.add("params", params);
            if (c.hasExpect()) {
                item.add("expect", c.expect());
            }
            out.add(item);
        }
        return out;
    }

    /**
     * {@code capture} 段（case-file.md §4）：会话默认光照/渲染模式与拍摄时刻。
     *
     * @return 规范化后的 capture 对象；文档未声明该段或声明为 null 时返回 null
     */
    private JsonObject validateCapture(CaseFile file, Fields fields) {
        JsonElement raw = file.capture();
        if (raw == null || raw.isJsonNull()) {
            return null;
        }
        if (!raw.isJsonObject()) {
            fields.add("capture", "须为 object {lighting?,renderMode?,worldTime?}");
            return null;
        }
        JsonObject capture = raw.getAsJsonObject();
        CaptureSpec spec = CaptureSpec.parse(capture, "capture", fields);
        return spec == null ? null : spec.toJson();
    }

    /**
     * {@code cameras} 段（contract.md §4.1）：机位表的解析与范围校验。
     *
     * <p>
     * 与 {@code shot.multi} 执行期用的是 {@link CameraSpecs} 的同一份判定——校验器只是把
     * 字段错误并进本次累计，不另写一套规则。
     *
     * @return 规范化后的机位数组；未声明返回 null
     */
    private JsonArray validateCameras(CaseFile file, Fields fields, List<String> warnings) {
        JsonArray raw = file.cameras();
        if (raw == null) {
            return null;
        }
        CameraSpecs.Parsed parsed = CameraSpecs.parseArray(raw, "cameras");
        merge(fields, parsed.fields());
        if (parsed.specs()
            .isEmpty()) {
            warnings.add("cameras 段为空数组：本 run 不产截图");
        }
        return CameraSpecs.toJson(parsed.specs());
    }

    /** 把子解析器累计的字段错误并进本次累计。 */
    static void merge(Fields target, Fields from) {
        if (from == null || from.isEmpty()) {
            return;
        }
        for (JsonElement e : from.toJson()) {
            if (e != null && e.isJsonObject()) {
                JsonObject o = e.getAsJsonObject();
                target.add(Json.optString(o, "field", "?"), Json.optString(o, "reason", "?"));
            }
        }
    }

    private JsonArray validateEvidence(CaseFile file, Fields fields) {
        JsonArray src = file.evidenceExpect();
        JsonArray out = new JsonArray();
        Set<String> seen = new LinkedHashSet<String>();
        for (int i = 0; i < src.size(); i++) {
            String ctx = "evidence.expect[" + i + "]";
            JsonElement e = src.get(i);
            if (e == null || !e.isJsonObject()) {
                fields.add(ctx, "条目须为 object");
                continue;
            }
            JsonObject item = e.getAsJsonObject();
            String path = Json.optString(item, "path", null);
            if (path == null || path.trim()
                .isEmpty()) {
                fields.add(ctx + ".path", "必填");
                continue;
            }
            checkRelPath(path, ctx + ".path", fields);
            if (!seen.add(path)) {
                fields.add(ctx + ".path", "重复的证据路径: " + path);
            }
            out.add(Json.copyObject(item));
        }
        return out;
    }

    private JsonArray validateVariants(CaseFile file, JsonArray criteria, Fields fields, VariantCheck check) {
        JsonArray out = new JsonArray();
        Set<String> criteriaIds = new LinkedHashSet<String>();
        for (int i = 0; i < criteria.size(); i++) {
            criteriaIds.add(
                Json.optString(
                    criteria.get(i)
                        .getAsJsonObject(),
                    "id",
                    ""));
        }
        JsonObject raw = file.raw();
        List<CaseFile.Variant> variants = file.variants();
        for (int i = 0; i < variants.size(); i++) {
            CaseFile.Variant v = variants.get(i);
            String ctx = "variants[" + i + "]";
            JsonObject mutated = null;
            try {
                mutated = v.applyTo(raw, ctx + ".mutate");
            } catch (CpException e) {
                // SKIP 模式下补丁报错不算问题：文档已是补丁产物，remove/replace 这类补丁再应用
                // 必然撞「目标不存在」，而原始文件那一遍（ENFORCE）已经判过它的可执行性。
                if (check != VariantCheck.SKIP) {
                    JsonElement fs = e.context() == null ? null
                        : e.context()
                            .get("fields");
                    if (fs != null && fs.isJsonArray()) {
                        for (JsonElement fe : fs.getAsJsonArray()) {
                            if (fe.isJsonObject()) {
                                fields.add(
                                    Json.optString(fe.getAsJsonObject(), "field", ctx + ".mutate"),
                                    Json.optString(fe.getAsJsonObject(), "reason", "补丁非法"));
                            }
                        }
                    } else {
                        fields.add(ctx + ".mutate", e.detail());
                    }
                }
            }
            if (check == VariantCheck.ENFORCE && mutated != null && mutated.equals(raw)) {
                fields.add(ctx + ".mutate", "补丁未改变用例内容（负对照将是空的）");
            }
            for (String id : v.expectCriteriaRed()) {
                if (!criteriaIds.contains(id)) {
                    fields.add(ctx + ".expectCriteriaRed", "未知判据 id: " + id);
                }
            }
            JsonObject item = new JsonObject();
            item.addProperty("id", v.id());
            item.add("mutate", Json.copy(v.mutate()));
            JsonArray red = new JsonArray();
            for (String id : v.expectCriteriaRed()) {
                Json.add(red, id);
            }
            item.add("expectCriteriaRed", red);
            item.addProperty("appliedSha256", mutated == null ? null : Hashing.sha256HexUtf8(Json.toJson(mutated)));
            item.addProperty("applicable", mutated != null);
            out.add(item);
        }
        return out;
    }

    // ------------------------------------------------------------ 工具

    private static void requirePathParam(JsonObject params, String ctx, Fields fields) {
        String path = Json.optString(params, "path", null);
        if (path == null || path.trim()
            .isEmpty()) {
            fields.add(ctx + ".params.path", "必填");
            return;
        }
        checkRelPath(path, ctx + ".params.path", fields);
    }

    /** 正整数参数（图像尺寸类判据用）；缺失或非法均记错。 */
    private static void requirePositiveInt(JsonObject params, String key, String ctx, Fields fields) {
        String field = ctx + ".params." + key;
        if (!params.has(key)) {
            fields.add(field, "必填（正整数像素）");
            return;
        }
        JsonElement e = params.get(key);
        if (!CameraSpec.isIntegral(e) || !CameraSpec.isFinite(e)) {
            fields.add(field, "须为整数");
            return;
        }
        if (e.getAsLong() <= 0L) {
            fields.add(field, "须为正整数，收到 " + e.getAsLong());
        }
    }

    /**
     * 0..1 图像阈值参数（图像纯色类判据用）：缺失补默认值，非法记错。
     *
     * <p>
     * 判定复用 {@link ImageCriteria#ratioError}——校验期与求值期必须是同一套规则，否则会出现
     * 「计划校验通过、运行期判 error」的错位。
     */
    private static void requireRatio(JsonObject params, String key, double def, String ctx, Fields fields) {
        if (!params.has(key)) {
            params.addProperty(key, def);
            return;
        }
        String err = ImageCriteria.ratioError(params, key);
        if (err != null) {
            fields.add(ctx + ".params." + key, err.replace("params." + key + " ", ""));
        }
    }

    /** 取 {@code [x,y,z]} 整数三元组；缺失或非法返回 null。 */
    private static int[] ints(JsonObject o, String key) {
        JsonArray a = Json.optArray(o, key);
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement e = a.get(i);
            if (e == null || !e.isJsonPrimitive() || !CameraSpec.isIntegral(e) || !CameraSpec.isFinite(e)) {
                return null;
            }
            out[i] = e.getAsInt();
        }
        return out;
    }

    private static void checkRelPath(String path, String field, Fields fields) {
        try {
            ArtifactStore.resolveInRun(java.nio.file.Paths.get("."), path);
        } catch (CpException e) {
            JsonElement fs = e.context() == null ? null
                : e.context()
                    .get("fields");
            String reason = e.detail();
            if (fs != null && fs.isJsonArray()
                && fs.getAsJsonArray()
                    .size() > 0) {
                reason = Json.optString(
                    fs.getAsJsonArray()
                        .get(0)
                        .getAsJsonObject(),
                    "reason",
                    reason);
            }
            fields.add(field, reason);
        }
    }

    private static void checkCoords(int[] v, String field, Fields fields) {
        if (v[1] < MIN_Y || v[1] > MAX_Y) {
            fields.add(field, "y 须在 " + MIN_Y + ".." + MAX_Y + "，收到 " + v[1]);
        }
        for (int k = 0; k < 3; k += 2) {
            if (v[k] < -MAX_HORIZONTAL || v[k] > MAX_HORIZONTAL) {
                fields.add(field, "水平坐标超出世界边界: " + v[k]);
                break;
            }
        }
    }
}
