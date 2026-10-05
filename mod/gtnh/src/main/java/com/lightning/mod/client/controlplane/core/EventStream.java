package com.lightning.mod.client.controlplane.core;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.function.Consumer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 结构化事件流水（contract.md §8）。
 *
 * <p>
 * 每条事件 {@code {seq, ts, level, kind, action?, jobId?, message, data?}}；{@code seq} 进程内
 * 单调递增。内存环形缓冲默认 4096 条，同时追加写 {@code events.jsonl}（一行一条紧凑 JSON）。
 * 同一份流水同时服务活动面板与审计，因此缓冲只是「近窗」，落盘才是全量。
 *
 * <p>
 * 落盘 writer 可注入，便于单测断言与避免触碰真实文件。
 */
public final class EventStream {

    /** 环形缓冲默认容量（contract.md §8）。 */
    public static final int DEFAULT_CAPACITY = 4096;

    /** 事件级别（自由字符串，但这三个是约定值）。 */
    public static final String LEVEL_INFO = "info";

    /** 见 {@link #LEVEL_INFO}。 */
    public static final String LEVEL_WARN = "warn";

    /** 见 {@link #LEVEL_INFO}。 */
    public static final String LEVEL_ERROR = "error";

    /** 事件落盘口；实现可以是文件追加、内存列表或空实现。 */
    public interface LineWriter {

        /** 追加一行（不含换行符）。 */
        void writeLine(String json) throws IOException;

        /** 关闭底层资源（默认无操作）。 */
        default void close() throws IOException {}
    }

    /** contract.md §8 约定的 kind 取值。 */
    public static final class Kinds {

        /** 控制面启动。 */
        public static final String SERVER_START = "server-start";
        /** 控制面停止。 */
        public static final String SERVER_STOP = "server-stop";
        /** 动作入队成功。 */
        public static final String ACTION_SUBMIT = "action-submit";
        /** 动作被拒（鉴权/confirm/忙/参数/未知）。 */
        public static final String ACTION_REJECT = "action-reject";
        /** 动作开始执行。 */
        public static final String ACTION_START = "action-start";
        /** 动作进度。 */
        public static final String ACTION_PROGRESS = "action-progress";
        /** 动作成功结束。 */
        public static final String ACTION_DONE = "action-done";
        /** 动作失败结束。 */
        public static final String ACTION_FAIL = "action-fail";
        /** 世界重建。 */
        public static final String WORLD_REBUILD = "world-rebuild";
        /** 世界快照。 */
        public static final String WORLD_SNAPSHOT = "world-snapshot";
        /** 世界回滚。 */
        public static final String WORLD_ROLLBACK = "world-rollback";
        /** 用例段执行。 */
        public static final String CASE_SEGMENT = "case-segment";
        /** 判据结论。 */
        public static final String CRITERIA_VERDICT = "criteria-verdict";

        private Kinds() {}
    }

    /** 不可变事件。 */
    public static final class Event {

        private final long seq;
        private final String ts;
        private final String level;
        private final String kind;
        private final String action;
        private final String jobId;
        private final String message;
        private final JsonObject data;

        Event(long seq, String ts, String level, String kind, String action, String jobId, String message,
            JsonObject data) {
            this.seq = seq;
            this.ts = ts;
            this.level = level;
            this.kind = kind;
            this.action = action;
            this.jobId = jobId;
            this.message = message;
            this.data = data;
        }

        /** 单调递增序号。 */
        public long seq() {
            return seq;
        }

        /** ISO-8601 时间戳。 */
        public String ts() {
            return ts;
        }

        /** info / warn / error。 */
        public String level() {
            return level;
        }

        /** 事件类型，见 {@link Kinds}。 */
        public String kind() {
            return kind;
        }

        /** 关联动作名，可为 null。 */
        public String action() {
            return action;
        }

        /** 关联作业号，可为 null。 */
        public String jobId() {
            return jobId;
        }

        /** 人读信息。 */
        public String message() {
            return message;
        }

        /** 结构化附加数据，可为 null。 */
        public JsonObject data() {
            return data;
        }

        /** 事件 JSON（省略 null 字段）。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("seq", seq);
            o.addProperty("ts", ts);
            o.addProperty("level", level);
            o.addProperty("kind", kind);
            if (action != null) {
                o.addProperty("action", action);
            }
            if (jobId != null) {
                o.addProperty("jobId", jobId);
            }
            if (message != null) {
                o.addProperty("message", message);
            }
            if (data != null) {
                o.add("data", data);
            }
            return o;
        }
    }

    private final int capacity;
    private final Deque<Event> buffer;
    private final LineWriter writer;
    private final Consumer<String> logger;
    private final TimeSource time;

    private long seq = 0;

    /** 文件落盘 + 系统时钟。 */
    public EventStream(Path jsonlFile, Consumer<String> logger) {
        this(DEFAULT_CAPACITY, fileWriter(jsonlFile, logger), logger, TimeSource.system());
    }

    /** 自定义容量与落盘口（测试主用）。 */
    public EventStream(int capacity, LineWriter writer, Consumer<String> logger) {
        this(capacity, writer, logger, TimeSource.system());
    }

    /** 全参构造。 */
    public EventStream(int capacity, LineWriter writer, Consumer<String> logger, TimeSource time) {
        this.capacity = capacity <= 0 ? DEFAULT_CAPACITY : capacity;
        this.buffer = new ArrayDeque<Event>(Math.min(this.capacity, 256));
        this.writer = writer;
        this.logger = logger;
        this.time = time == null ? TimeSource.system() : time;
    }

    /** 追加一条事件（无关联动作/作业）。 */
    public Event append(String level, String kind, String message) {
        return append(level, kind, null, null, message, null);
    }

    /** 追加一条事件。 */
    public Event append(String level, String kind, String message, JsonObject data) {
        return append(level, kind, null, null, message, data);
    }

    /**
     * 追加一条事件：写环形缓冲 + 追加落盘（落盘失败只记警告，不影响调用方）。
     *
     * @return 生成的事件
     */
    public synchronized Event append(String level, String kind, String action, String jobId, String message,
        JsonObject data) {
        long s = ++seq;
        Event e = new Event(
            s,
            time.isoNow(),
            level == null ? LEVEL_INFO : level,
            kind == null ? "unknown" : kind,
            action,
            jobId,
            message,
            data);
        buffer.addLast(e);
        while (buffer.size() > capacity) {
            buffer.removeFirst();
        }
        if (writer != null) {
            try {
                writer.writeLine(Json.toJson(e.toJson()));
            } catch (IOException ex) {
                warn("事件落盘失败: " + ex.getMessage());
            } catch (RuntimeException ex) {
                warn("事件落盘异常: " + ex);
            }
        }
        return e;
    }

    /**
     * 查询流水（{@code GET /cp/v1/events} 的数据源）。
     *
     * @param since 只返回 {@code seq > since} 的事件
     * @param limit 最多返回条数；&le;0 表示不限（受环形缓冲容量天然约束）
     */
    public synchronized JsonArray since(long since, int limit) {
        JsonArray out = new JsonArray();
        for (Event e : buffer) {
            if (e.seq <= since) {
                continue;
            }
            if (limit > 0 && out.size() >= limit) {
                break;
            }
            out.add(e.toJson());
        }
        return out;
    }

    /** 当前最大序号（进程内单调递增；重启归零）。 */
    public synchronized long lastSeq() {
        return seq;
    }

    /** 缓冲中现存条数。 */
    public synchronized int size() {
        return buffer.size();
    }

    /** 环形缓冲容量。 */
    public int capacity() {
        return capacity;
    }

    /** 缓冲快照（按 seq 升序），供判据引擎与测试使用。 */
    public synchronized List<Event> events() {
        return new ArrayList<Event>(buffer);
    }

    /** 统计指定 kind 在缓冲中的条数（{@code event-emitted} 判据用）。 */
    public synchronized int countKind(String kind) {
        int n = 0;
        if (kind == null) {
            return 0;
        }
        for (Event e : buffer) {
            if (kind.equals(e.kind)) {
                n++;
            }
        }
        return n;
    }

    /** 最近一条指定 kind 的事件，无则 null。 */
    public synchronized Event lastOfKind(String kind) {
        Event found = null;
        if (kind == null) {
            return null;
        }
        for (Event e : buffer) {
            if (kind.equals(e.kind)) {
                found = e;
            }
        }
        return found;
    }

    private void warn(String message) {
        if (logger != null) {
            logger.accept(Contract.LOG_PREFIX + " " + message);
        }
    }

    /**
     * 构造追加写 {@code events.jsonl} 的 writer；每行一次 flush，保证进程崩溃时已写事件不丢。
     */
    public static LineWriter fileWriter(final Path jsonlFile, final Consumer<String> logger) {
        if (jsonlFile == null) {
            return null;
        }
        return new LineWriter() {

            private BufferedWriter out;

            private BufferedWriter open() throws IOException {
                if (out == null) {
                    Path parent = jsonlFile.toAbsolutePath()
                        .getParent();
                    if (parent != null) {
                        Files.createDirectories(parent);
                    }
                    out = Files.newBufferedWriter(
                        jsonlFile,
                        StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE,
                        StandardOpenOption.APPEND,
                        StandardOpenOption.WRITE);
                }
                return out;
            }

            @Override
            public synchronized void writeLine(String json) throws IOException {
                BufferedWriter w = open();
                w.write(json);
                w.newLine();
                w.flush();
            }

            @Override
            public synchronized void close() throws IOException {
                if (out != null) {
                    out.close();
                    out = null;
                }
            }
        };
    }

    /**
     * 关闭落盘资源（幂等）。服务停止或测试收尾时调用，避免在 Windows 上留下占用中的文件句柄。
     */
    public void close() {
        if (writer == null) {
            return;
        }
        try {
            writer.close();
        } catch (IOException e) {
            warn("关闭事件落盘失败: " + e.getMessage());
        } catch (RuntimeException e) {
            warn("关闭事件落盘异常: " + e);
        }
    }
}
