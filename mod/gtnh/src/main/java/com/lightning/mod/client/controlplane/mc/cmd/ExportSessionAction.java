package com.lightning.mod.client.controlplane.mc.cmd;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.core.session.ExportSession;

/**
 * {@code export.session}（observe，同步）：{@link ExportSession} 单例态的**只读快照**（Gitea #100 裁决 14）。
 *
 * <h2>为什么必须有这个动作（Gitea #97 §2.4-G2）</h2>
 *
 * #97 首验指出：cp 动作面在 PR-1/2 阶段共 11 个动作，<b>没有任何一个能读 {@code ExportSession}</b>。
 * 后果不是「少一个读面」这么轻——它是<b>自查能力缺失</b>：AI 经 {@code cmd.exec} 设完选区/活动帧之后，
 * 无法经 API 确认「命令到底生效了没有」，只能靠命令文本回报（那是命令的<b>自述</b>，不是状态本身），
 * 或者干脆截图看线框。这既违反 #96 §8.1「动作自描述」，也违反 §8.6「产物显式」的精神。
 *
 * <p>
 * 本动作因此与 {@code cmd.exec} 配套交付：<b>设状态靠命令通道，验状态靠本动作</b>。这也是 #96 §10-D2
 * 「双通道一致」可判定的前提——没有读面就无法把「命令设的值」与「API 读回的值」摆在一张表上比对。
 *
 * <h2>只读性论证（#96 §5「全部读面只读、无副作用」）</h2>
 *
 * <ul>
 * <li>唯一触碰的单例方法是 {@link ExportSession#snapshot()}——它在<b>同一临界区</b>内取走全部字段并返回
 * 不可变值对象 {@link ExportSession.Snapshot}（见该方法注释：逐调 getter 会拿到互相矛盾的组合）；</li>
 * <li><b>不</b>调用任何 setter、<b>不</b>触碰 {@code frameJson}/{@code cellNotesByFrame}（快照里帧号是拷贝、
 * 备注根本不在快照里）；</li>
 * <li><b>不</b>触碰 MC 世界、玩家、渲染或文件系统 ⇒ 世界清单哈希不变（B1 判据），也不产生任何产物；</li>
 * <li>本动作<b>不</b>调用 {@code ctx.beginRun(...)}：没有产物就不该建 run 目录（否则每次只读调用都在
 * {@code controlplane/runs/} 下留一个空目录，污染产物面）。调用与回报仍进事件流水与作业登记——审计的是
 * <b>调用</b>，不是产物。</li>
 * </ul>
 *
 * <h2>线程语义（Gitea #100 裁决 13）</h2>
 *
 * 本动作与其余 cp 动作一样在<b>客户端 tick 线程</b>执行（{@code ActionSteppingExecutor} 于
 * {@code TickEvent.ClientTickEvent} Phase.END 排空）。它读的是与 {@code Server thread} 上 {@code /sde} 命令
 * 共享的同一把锁（{@code ExportSession.LOCK}，私有静态终态），因此：
 *
 * <ul>
 * <li>不会读到「写一半」的状态——要么看到命令执行前的完整态，要么看到执行后的完整态；</li>
 * <li>临界区是内存级赋值与拷贝（无 IO、无世界遍历）⇒ 持锁时间以微秒计，服务端线程不会被它堵住；</li>
 * <li>方向单一（本动作只取锁、不反向请求服务端线程做任何事）⇒ <b>结构上不可能</b>与服务端线程形成
 * 环路等待，这正是 #100 验收「命令执行期间 cp 读面与世界动作不死锁」的实现依据。</li>
 * </ul>
 */
public final class ExportSessionAction implements ControlAction {

    @Override
    public JsonObject execute(ActionContext ctx) {
        return snapshotJson();
    }

    /**
     * 构造 {@link ExportSession} 单例态快照 JSON（**唯一实现**）。
     *
     * <p>
     * 抽成静态方法是为了让 {@code cmd.exec} 的结果里能带上「命令生效后的单例态」——两处必须给出
     * <b>逐字段相同</b>的结构，否则调用方要写两套解析（也会让 D2 双通道对照失去意义）。
     * 本方法本身<b>只读</b>：唯一触碰的是 {@link ExportSession#snapshot()}。
     */
    public static JsonObject snapshotJson() {
        ExportSession.Snapshot s = ExportSession.get()
            .snapshot();

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-export-session/1");
        o.addProperty("contractVersion", Contract.VERSION);

        // ---- 会话态 ----
        o.addProperty("inSession", s.inSession());
        o.addProperty(
            "selectionMode",
            s.selectionMode() == null ? null
                : s.selectionMode()
                    .name());

        // ---- 选区 ----
        JsonObject selection = new JsonObject();
        selection.addProperty("complete", s.selectionComplete());
        selection.add("pos1", coords(s.pos1x(), s.pos1y(), s.pos1z()));
        selection.add("pos2", coords(s.pos2x(), s.pos2y(), s.pos2z()));
        // 规范化的 min/max：与 /sde 内部一致（pos1/pos2 的书写顺序不决定 AABB 方向）
        selection.add("min", coords(min(s.pos1x(), s.pos2x()), min(s.pos1y(), s.pos2y()), min(s.pos1z(), s.pos2z())));
        selection.add("max", coords(max(s.pos1x(), s.pos2x()), max(s.pos1y(), s.pos2y()), max(s.pos1z(), s.pos2z())));
        if (s.selectionComplete()) {
            // size 用「跨度 + 1」（闭区间方块数），与 scan 的 cellGrid 维度同口径
            selection.addProperty("sizeX", Math.abs(s.pos1x() - s.pos2x()) + 1);
            selection.addProperty("sizeY", Math.abs(s.pos1y() - s.pos2y()) + 1);
            selection.addProperty("sizeZ", Math.abs(s.pos1z() - s.pos2z()) + 1);
        }
        o.add("selection", selection);

        // ---- 帧 ----
        o.addProperty("activeFrame", s.activeFrame());
        JsonArray frames = new JsonArray();
        for (int f : s.recordedFrames()) {
            Json.add(frames, Integer.valueOf(f));
        }
        o.add("recordedFrames", frames);
        o.addProperty("recordedFrameCount", s.recordedFrameCount());

        // 逐帧内容 sha256（派发裁决 3，只增不改）：与 recordedFrames 同序一一对应。
        // 用途 = C3「同会话同缓冲」机械判据；跨会话拼接的产物其帧哈希落在不同缓冲/世代，可据此判红。
        JsonArray hashes = new JsonArray();
        for (String h : s.frameSha256()) {
            Json.add(hashes, h);
        }
        o.add("frameSha256", hashes);
        // 缓冲世代号：判断「缓冲有没有动过」的廉价伴随物（比逐帧哈希更省事）。
        o.addProperty("bufferGeneration", s.bufferGeneration());

        // ---- 输出参数与作者 ----
        o.addProperty("outputName", s.outputName());
        o.addProperty("structureId", s.structureId());
        o.addProperty("lastAuthor", s.lastAuthor());
        o.addProperty("lastGtnhVersion", s.lastGtnhVersion());

        // 一行的等价文本：与 `/sde status` 同源同形，便于双通道对照（D2）时肉眼/脚本直接比字符串。
        o.addProperty(
            "statusLine",
            ExportSession.get()
                .statusLine());

        return o;
    }

    /** 三点坐标数组；任一分量为 null 时返回 JSON null（「没设过」与「设在原点」必须可区分）。 */
    private static JsonArray coords(Integer x, Integer y, Integer z) {
        if (x == null || y == null || z == null) {
            return null;
        }
        JsonArray a = new JsonArray();
        Json.add(a, Integer.valueOf(x));
        Json.add(a, Integer.valueOf(y));
        Json.add(a, Integer.valueOf(z));
        return a;
    }

    private static Integer min(Integer a, Integer b) {
        if (a == null || b == null) {
            return null;
        }
        return Integer.valueOf(Math.min(a, b));
    }

    private static Integer max(Integer a, Integer b) {
        if (a == null || b == null) {
            return null;
        }
        return Integer.valueOf(Math.max(a, b));
    }
}
