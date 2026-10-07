package com.lightning.mod.client.controlplane.mc.input;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateProvider;

/**
 * 输入手段族（{@code input.*}）的**能力真值表**（Gitea #162 冻结件 §5.2 / §11.2 的机读落点）。
 *
 * <h2>这个类存在的唯一理由：不许把「未实现」伪装成「已具备」</h2>
 * 契约 §5.2 末条要求 {@code implemented:false} 时<b>每一个</b>能力字段都自洽（{@code actions} 空、
 * {@code keyCatalog} 空、{@code text.ranges} 空、{@code held.count} 为 0、{@code notImplemented} 非空）；
 * §11.2 第 17 条更直接禁止「用默认值把未知伪装成已具备但当前为 0」。因此「本族能不能做 X」这件事
 * 不写在散文里，而是**集中在这里的常量**：状态装配方（T2-B）与动作实现（T2-A/T3）都从这里取值，
 * 任何一条能力被真正打通时，只能改这里 + 契约 §11.2（同源，两处一起删）。
 *
 * <p>
 * 「本类里的常量」= 「本运行时当前愿意背书的事实」。写 {@code true} 之前必须有一条实机判据，
 * 否则就是把未验证项当已具备项卖出去。
 */
public final class InputCapabilities {

    /** 输入手段族名（{@code input.state.family}）。 */
    public static final String FAMILY = "input";

    /** 手段归因（§10.3：与 {@code layer}/{@code semantics} 并列，不替代）。 */
    public static final String MEANS = "input";

    // ------------------------------------------------------------------ 上限（§3.2 / §2.3 / §2.4）

    /**
     * 单键/单按钮持有上限（tick）。
     *
     * <p>
     * 与 {@code player.dig} 的 {@code MAX_HOLD_TICKS} 同值，避免同一动作面出现两套上界（§3.2）。
     * {@code holdTicks} 越界一律 {@code CP-VALID-002}；已投递的持有到期由设施自动抬起并报
     * {@code autoReleased}（D-4 裁决：不允许无限期持有）。
     */
    public static final int HOLD_TICKS_MAX = 1200;

    /** 滚轮档位绝对值上限（§2.7 第 3 条）。 */
    public static final int WHEEL_AMOUNT_MAX = 8;

    /** 位置类投递与按下之间的最小间隔（§2.4 第 5 条：GUI 命中集每帧重建）。 */
    public static final int MIN_SETTLE_TICKS = 2;

    /** 合法 LWJGL 键码闭区间（§2.2 第 3 条；由 {@code Keyboard.KEY_*} 全集校验后写死）。 */
    public static final int KEY_CODE_MIN = 0;

    /** 见 {@link #KEY_CODE_MIN}。 */
    public static final int KEY_CODE_MAX = 255;

    /** 键盘事件队列容量（{@code Keyboard.eventQueue}，§4.4 第 3 条）。 */
    public static final int KEYBOARD_QUEUE_CAPACITY = 256;

    /**
     * 键盘队列的静态 seed 哨兵基线（§4.1「已投递」判据）。
     *
     * <p>
     * lwjgl3ify 的 {@code Keyboard} 静态初始化会塞一条 RELEASE 哨兵事件，因此
     * 「队列里没有别人的事件」时 {@code getNumKeyboardEvents()} 是 1 而不是 0。
     */
    public static final int KEYBOARD_SEED_BASELINE = 1;

    /** 鼠标侧队列深度探针的存在性（§3.6 第 3 条：{@code Mouse} 无公开深度探针）。 */
    public static final String MOUSE_QUEUE_DEPTH = "unobservable";

    // ------------------------------------------------------------------ 轮询面（§2.0）

    /** 轮询面声明：本族只覆盖事件队列面。 */
    public static final String POLL_SURFACE = "not-covered：Keyboard.isKeyDown / Mouse.isButtonDown / GameSettings.isKeyDown 读 SDL 物理数组，"
        + "队列注入不改变它们；因此 Shift/Ctrl/Alt 组合、GuiContainer 的 Shift 点击、NEI 快捷键、SyncedKeybind、MUI Interactable 不在承诺范围；"
        + "组合键只保证事件序（契约 §2.0 / §2.8）";

    // ------------------------------------------------------------------ 文本（§2.9）

    /**
     * 文本投递是否可用。
     *
     * <p>
     * {@code false} 的判据（P0 实机）：{@code GuiChat.fieldText} 可读且为空，
     * {@code addCharEvent} 与「键事件自带 codepoint」两条路都没到达 ⇒ 声明为空（§11.2 第 4 条）。
     */
    public static final boolean TEXT_SUPPORTED = false;

    /** 文本在工作链是否到达（{@code false} = 未验证到达）。 */
    public static final boolean TEXT_ROUTE_WORLD = false;

    /** 文本在 GUI 链是否到达（{@code false} = 未验证到达）。 */
    public static final boolean TEXT_ROUTE_GUI = false;

    /** 投递粒度：逐 UTF-16 码元一条事件（§2.9 第 1/5 条）。 */
    public static final String TEXT_DELIVERY = "per-character";

    /** 范围外字符的行为：整条显式失败（§2.9 第 3 条，禁止静默丢弃/替换）。 */
    public static final String TEXT_UNSUPPORTED_BEHAVIOR = "explicit-fail";

    /** 滚轮单位（§2.7）。 */
    public static final String WHEEL_UNIT = "notch";

    /** 滚轮符号口径：由原版 {@code changeCurrentItem(i)} 的行为校准（正档 = 向后/向下）。 */
    public static final String WHEEL_SIGN = "positive=backward";

    /** 坐标 Y 翻转口径（§5.2 冻结字符串）。 */
    public static final String Y_FLIP = "eventY = displayHeight - sdlY";

    /** 坐标口径说明（请求侧空间 / 投递侧空间）。 */
    public static final String COORDINATE_SPACE = "gui-scaled-request / sdl-window-delivered";

    // ------------------------------------------------------------------ 注入白名单（§1.2）

    /** §1.2 白名单的五个入口名（{@code runtime.injectors} 用；只增不改）。 */
    public static final List<String> INJECTORS;

    static {
        List<String> l = new ArrayList<String>();
        l.add("Keyboard.addRawKeyEvent");
        l.add("Keyboard.addCharEvent");
        l.add("Mouse.addMoveEvent");
        l.add("Mouse.addButtonEvent");
        l.add("Mouse.addWheelEvent");
        INJECTORS = Collections.unmodifiableList(l);
    }

    // ------------------------------------------------------------------ 清理路径（§3.4）

    /** 一条清理路径的机读声明。 */
    public static final class CleanupPath {

        private final String id;
        private final String strength;

        CleanupPath(String id, String strength) {
            this.id = id;
            this.strength = strength;
        }

        /** 路径 id（§3.4 表第 1 列）。 */
        public String id() {
            return id;
        }

        /** 承诺强度：{@code promised} | {@code best-effort}。 */
        public String strength() {
            return strength;
        }

        /** {@code {id, strength}}。 */
        public JsonObject toJson() {
            return Json.object("id", id, "strength", strength);
        }
    }

    /** §3.4 承诺的五条清理路径（表外一律不承诺）。 */
    public static final List<CleanupPath> CLEANUP_PATHS;

    static {
        List<CleanupPath> l = new ArrayList<CleanupPath>();
        l.add(new CleanupPath("normal-completion", "promised"));
        l.add(new CleanupPath("action-exception", "promised"));
        l.add(new CleanupPath("step-timeout", "promised"));
        l.add(new CleanupPath("explicit-release", "promised"));
        l.add(new CleanupPath("process-exit", "best-effort"));
        CLEANUP_PATHS = Collections.unmodifiableList(l);
    }

    /** 崩溃后清理：不承诺（状态随 JVM 消失）。 */
    public static final String CRASH = "not-promised";

    /** 离图/断连/关服：无钩子（{@code ClientDisconnect}/{@code WorldEvent}/{@code onWorldUnload} 零命中）。 */
    public static final String WORLD_UNLOAD = "no-hook";

    /** 作业取消：不存在该能力（core 层零 {@code cancel}、端点表无取消端点）。 */
    public static final String CANCEL = "unavailable";

    // ------------------------------------------------------------------ 文本字符范围声明（§2.9 第 2 条）

    /** 一个闭区间码点段。 */
    public static final class Range {

        private final int from;
        private final int to;

        Range(int from, int to) {
            this.from = from;
            this.to = to;
        }

        /** 闭区间下界。 */
        public int from() {
            return from;
        }

        /** 闭区间上界。 */
        public int to() {
            return to;
        }

        /** 是否包含码点。 */
        public boolean contains(int codepoint) {
            return codepoint >= from && codepoint <= to;
        }

        /** {@code {from, to}}。 */
        public JsonObject toJson() {
            return Json.object("from", Integer.valueOf(from), "to", Integer.valueOf(to));
        }
    }

    /**
     * 声明支持的字符范围（闭区间表）。
     *
     * <p>
     * <b>本单为空表</b>：P0 只证明了「字符事件没到达任何一条链」，因此没有任何一段可以被声明
     * （§2.9 第 2 条禁止「全 Unicode」这类不可判定的声明）。空表 ⇒ 任何非空 {@code input.text}
     * 请求在能力未就绪时一律 {@code CP-STATE-001}（§2.9 第 6 条）。
     */
    public static final List<Range> TEXT_RANGES;

    static {
        List<Range> l = new ArrayList<Range>();
        TEXT_RANGES = Collections.unmodifiableList(l);
    }

    /** 码点是否在声明范围内（空表 ⇒ 恒 false，绝不静默放行）。 */
    public static boolean inDeclaredTextRange(int codepoint) {
        for (Range r : TEXT_RANGES) {
            if (r.contains(codepoint)) {
                return true;
            }
        }
        return false;
    }

    /** 声明范围的 JSON 形态（{@code [{from,to}]}）。 */
    public static JsonArray textRangesJson() {
        JsonArray a = new JsonArray();
        for (Range r : TEXT_RANGES) {
            a.add(r.toJson());
        }
        return a;
    }

    /** 五条清理路径的 JSON 形态。 */
    public static JsonArray cleanupPathsJson() {
        JsonArray a = new JsonArray();
        for (CleanupPath p : CLEANUP_PATHS) {
            a.add(p.toJson());
        }
        return a;
    }

    // ------------------------------------------------------------------ 未实现清单（§11.2 同源）

    /** 本族动作是否已注册（Gitea #165 已注册 ⇒ 调用不再得 {@code CP-VALID-001}）。 */
    public static final boolean ACTIONS_REGISTERED = true;

    /** {@code since} 的当前真相（§1.4：与 {@code contractVersion} 前进同 PR 写入，本批为 {@code 1.8}）。 */
    public static final String SINCE = "1.8";

    /**
     * 已冻结但**未实现/未验证**的项（§11.2 同源摘录）。
     *
     * <p>
     * 实现一项就同时删两处（本常量 + 契约 §11.2），不得只删一处（§11.2 末条）。
     *
     * <p>
     * <b>本批（#165）删掉的四条与本批<b>不</b>删的说明</b>：动作注册、契约版本前进、
     * {@code means} 自描述字段、{@code input.state} 注册四条已随本批落地 ⇒ 删除；
     * 「坐标换算的实机自校准」「codepoint 通路」「G1 扩展」三条<b>不</b>因代码合入而删——
     * 前两条要实机判据，G1 的实现由并行分支承载（合入后再删，见 Gitea #165 的收口评论）。
     * 「写 true 之前必须有一条实机判据」是本类的宪法，不许按「代码写完了」结账。
     */
    public static final List<String> NOT_IMPLEMENTED;

    static {
        List<String> l = new ArrayList<String>();
        l.add("GUI 文本路由未打通（P0 实测：addCharEvent 与键事件自带 codepoint 两条都未到达）");
        l.add("input.key 的 codepoint 通路未验证（只有键位那一半被实机证过）");
        l.add("鼠标侧队列深度无公开探针 ⇒ 鼠标的「已投递」不可独立复核、physicalConcurrent 鼠标侧只能 unobservable");
        l.add("无取消能力（core 层零 cancel、端点表无取消端点）");
        l.add("无世界卸载/断连/关服钩子 ⇒ 离图不触发释放，契约不承诺");
        l.add("不承诺崩溃后清理（状态随 JVM 消失）");
        l.add("轮询面不覆盖（Keyboard.isKeyDown 型判定不随队列注入变化；组合键只保证事件序）");
        l.add("input.mouse op:relative 的失焦生效未验证（消费门是 mc.inGameHasFocus && Display.isActive()）");
        l.add("坐标换算的实机自校准未做（P0 只在 displayHeight=480 / pixelScale=1.0 上定案 Y 翻转）");
        l.add("GUI 截图取证面不存在（shot.* 只 renderWorld + 强制 hideGUI）");
        l.add("read.input 读面不存在（注入有没有生效缺第二观测面）");
        l.add("场景守卫会关聊天框（armed 期间每 tick displayGuiScreen(null)）");
        l.add("§9.2 的 G1 扩展未实现（case-file.md §3.2 的同步性口径、CaseValidator 白名单、CaseRunAction 段内跨 tick 推进）");
        NOT_IMPLEMENTED = Collections.unmodifiableList(l);
    }

    /** 未实现清单的 JSON 形态（{@code input.state.notImplemented}）。 */
    public static JsonArray notImplementedJson() {
        JsonArray a = new JsonArray();
        for (String s : NOT_IMPLEMENTED) {
            Json.add(a, s);
        }
        return a;
    }

    /**
     * 动作目录（§5.2：已注册的输入动作名；未注册时为空数组，**不是** {@code ["input.key", ...]}）。
     *
     * <p>
     * {@code input.state} 的名字取自 {@link InputStateProvider#ACTION_NAME}（{@code api} 面）——
     * 刻意<b>不</b> import {@code mc.input.observe.InputStateAction}：那会让下层 {@code input}
     * 反向依赖上层 {@code observe}。名字只有一处真值，本表只是它的一个消费点。
     */
    public static JsonArray registeredActionsJson() {
        JsonArray a = new JsonArray();
        if (ACTIONS_REGISTERED) {
            Json.add(a, InputKeyAction.NAME);
            Json.add(a, InputTextAction.NAME);
            Json.add(a, InputMouseAction.NAME);
            Json.add(a, InputReleaseAction.NAME);
            Json.add(a, InputStateProvider.ACTION_NAME);
        }
        return a;
    }

    /** 本族会返回的错误码清单（§6.1：不新增错误码）。 */
    public static JsonArray errorsJson() {
        JsonArray a = new JsonArray();
        Json.add(a, "CP-VALID-001");
        Json.add(a, "CP-VALID-002");
        Json.add(a, "CP-STATE-001");
        Json.add(a, "CP-EXEC-002");
        Json.add(a, "CP-CONFIRM-001");
        return a;
    }

    /** 契约允许的 {@code input.key} 取值域。 */
    public static final List<String> KEY_ACTIONS;

    /** 契约允许的 {@code input.mouse} 取值域。 */
    public static final List<String> MOUSE_OPS;

    static {
        List<String> ka = new ArrayList<String>();
        ka.add("down");
        ka.add("up");
        ka.add("tap");
        KEY_ACTIONS = Collections.unmodifiableList(ka);

        List<String> mo = new ArrayList<String>();
        mo.add("move");
        mo.add("relative");
        mo.add("down");
        mo.add("up");
        mo.add("click");
        mo.add("wheel");
        MOUSE_OPS = Collections.unmodifiableList(mo);
    }

    private InputCapabilities() {}
}
