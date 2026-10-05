package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;

/**
 * 异常栈摘要：把 {@link Throwable}（含 cause 链）压成「前 N 帧」的文本行。
 *
 * <h2>为什么需要它</h2>
 * 一次真机验收的事故：{@code case.run} 的 {@code cameras} 段（{@code shot.multi} 路径）首个 step 就抛
 * {@code NullPointerException}，但动作失败路径只把 {@code t.toString()}（类名 + message）写进日志与事件，
 * <b>栈帧一个都没落</b>——事后只能靠猜哪条渲染路径读到了 null。栈是定位这类「NPE 形态相同、根因全靠猜」
 * 问题的唯一线索，必须落下来。
 *
 * <h2>为什么只取前 N 帧</h2>
 * 事件流水 JSONL 每行都要能被人读完：完整栈动辄数十帧、混入 mixin/FML 的包装帧，写进事件里只会把
 * 有用信息淹掉。故摘要取前 {@link #DEFAULT_FRAMES} 帧；<b>完整栈由日志侧落</b>
 * （{@code FMLLog.log(ERROR, t, msg)} 形态，见 {@code CpLog.coreSink()}），两条口径互补：
 * 事件里是「给人和机器快速定位用的摘要」，日志里是「完整证据」。
 *
 * <h2>cause 链</h2>
 * 包装异常（如 {@link CpException}）自身的第一帧往往只是「抛出点」，真正的失败点在 cause 里，
 * 因此 {@link #lines(Throwable, int)} 会展开最多 {@link #MAX_CAUSES} 层 cause，每层先写一行异常描述
 * （第二层起带 {@code Caused by:} 前缀，与 {@code printStackTrace} 口径一致），再写该层的栈帧，
 * 全部层合计不超过 {@code maxFrames} 帧；被截断的那一层末尾补一行 {@code "... N more"}。
 *
 * <p>
 * 纯 JVM 实现：只用 {@code java.lang} 与 gson，可被 {@code src/test} 下的无头单测直接覆盖。
 */
public final class StackSummary {

    /** 摘要默认帧数（事故定位用的「前 12 帧」口径）。 */
    public static final int DEFAULT_FRAMES = 12;

    /** cause 链展开上限（防自引用/超长链条）。 */
    public static final int MAX_CAUSES = 3;

    private StackSummary() {}

    /**
     * 摘要文本行。
     *
     * <h2>帧额度的分配（为什么不是「先到先得」）</h2>
     * 天真的做法是「从外层往里数满 N 帧就停」。实测不可用：包装异常（{@code CpException}）自己的栈
     * 就有十几帧（构造器 + 动作骨架 + 执行器 + 队列 + tick 回调），12 帧额度会被外层<b>全部吃光</b>，
     * 真正失败的内层 cause 一帧都看不到——而事故里恰恰是 cause 那一帧
     * （{@code DataWatcher.updateObject}）才有诊断价值。
     *
     * <p>
     * 故按深度分配：先把最多半额预留给<b>最内层</b>（cause 链最深处），外层平分剩下的额度；
     * 某层写不下时只标注 {@code "... N more"} 并<b>继续往内层走</b>（不是中断整条链）。
     *
     * @param t         目标异常；null 返回空列表
     * @param maxFrames 栈帧总上限（&le;0 时取 {@link #DEFAULT_FRAMES}）
     * @return 逐行文本：各层异常描述行 + {@code "  at &lt;帧&gt;"} 行（截断层补 {@code "... N more"}）；永不为 null
     */
    public static List<String> lines(Throwable t, int maxFrames) {
        List<String> out = new ArrayList<String>();
        if (t == null) {
            return out;
        }
        int budget = maxFrames > 0 ? maxFrames : DEFAULT_FRAMES;
        List<Throwable> chain = chainOf(t);
        int depth = chain.size();
        // 最内层预留额度：最多半额，且不超过它实际的帧数（短栈不浪费）
        int reserveLast = 0;
        if (depth > 1) {
            StackTraceElement[] lastSt = chain.get(depth - 1)
                .getStackTrace();
            int lastLen = lastSt == null ? 0 : lastSt.length;
            reserveLast = Math.min(lastLen, Math.max(1, budget / 2));
        }
        int outerPer = depth > 1 ? Math.max(1, (budget - reserveLast) / (depth - 1)) : budget;
        int used = 0;
        for (int level = 0; level < depth; level++) {
            Throwable cur = chain.get(level);
            out.add((level == 0 ? "" : "Caused by: ") + describe(cur));
            StackTraceElement[] st = cur.getStackTrace();
            int n = st == null ? 0 : st.length;
            int allow;
            if (level == depth - 1) {
                allow = budget - used; // 最内层用掉剩余全部额度
            } else {
                allow = Math.min(outerPer, Math.max(0, budget - reserveLast - used));
            }
            int written = 0;
            while (written < n && written < allow) {
                out.add("  at " + st[written]);
                written++;
                used++;
            }
            if (written < n) {
                out.add("  ... " + (n - written) + " more");
            }
        }
        return out;
    }

    /**
     * 展开 cause 链（自引用即止，最多 {@link #MAX_CAUSES} 层，首元素是传入的异常本身）。
     *
     * <p>
     * 自引用在 {@link Throwable#initCause} 上会被 JDK 直接拒掉（{@code Self-causation not permitted}），
     * 这里仍做防御：任何能返回 {@code this} 的 {@code getCause()} 实现都不得让它死循环。
     */
    public static List<Throwable> chainOf(Throwable t) {
        List<Throwable> chain = new ArrayList<Throwable>();
        Throwable cur = t;
        while (cur != null && chain.size() < MAX_CAUSES) {
            chain.add(cur);
            Throwable next = causeOf(cur);
            if (next == null) {
                break;
            }
            cur = next;
        }
        return chain;
    }

    /** {@link #lines(Throwable, int)} 的 JSON 形态（字符串数组，供事件流水用）。 */
    public static JsonArray frames(Throwable t, int maxFrames) {
        JsonArray a = new JsonArray();
        for (String line : lines(t, maxFrames)) {
            Json.add(a, line);
        }
        return a;
    }

    /** 多行文本（日志侧兜底用；条目间以换行连接）。 */
    public static String text(Throwable t, int maxFrames) {
        StringBuilder sb = new StringBuilder();
        for (String line : lines(t, maxFrames)) {
            if (sb.length() > 0) {
                sb.append('\n');
            }
            sb.append(line);
        }
        return sb.toString();
    }

    /** 单行异常描述：{@code 类名: message}（无 message 时只有类名）。 */
    public static String describe(Throwable t) {
        if (t == null) {
            return "<null>";
        }
        String message = t.getMessage();
        String name = t.getClass()
            .getName();
        return message == null ? name : name + ": " + message;
    }

    /** {@code cause}（自我引用返回 null，避免死循环）。 */
    public static Throwable causeOf(Throwable t) {
        if (t == null) {
            return null;
        }
        Throwable cause = t.getCause();
        return cause == null || cause == t ? null : cause;
    }
}
