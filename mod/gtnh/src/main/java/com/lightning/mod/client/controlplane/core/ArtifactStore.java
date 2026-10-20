package com.lightning.mod.client.controlplane.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * run 目录与产物登记（case-file.md §8.4、observation-record.md §1）。
 *
 * <p>
 * run 目录：{@code <mcDataDir>/controlplane/runs/<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>/}，
 * 全程只增不改；{@code manifest.json} 登记全部产物的 sha256。本类同时负责
 * 「产物相对路径 → 真实路径」的防穿越解析，是 {@code GET /cp/v1/artifacts/...} 的唯一入口。
 *
 * <p>
 * 活动 run 在内存中登记，已结束（或重启后）的 run 从磁盘 {@code manifest.json} 还原，
 * 因此产物下载与清单查询都不依赖动作是否仍在运行。
 */
public final class ArtifactStore {

    /** 内存中保留的活动 run 目录数上限（超出后按创建顺序淘汰，磁盘不受影响）。 */
    private static final int MAX_ACTIVE_RUNS = 64;

    /** 单个产物 {@code path} 字段的合法形态。 */
    private static final String RUN_ID_PATTERN = "[A-Za-z0-9._-]+";

    /** 一个产物的登记项。 */
    public static final class Artifact {

        private final String path;
        private final long bytes;
        private final String sha256;
        private final String role;

        Artifact(String path, long bytes, String sha256, String role) {
            this.path = path;
            this.bytes = bytes;
            this.sha256 = sha256;
            this.role = role;
        }

        /** run 目录内相对路径（统一 '/' 分隔）。 */
        public String path() {
            return path;
        }

        /** 字节数。 */
        public long bytes() {
            return bytes;
        }

        /** 内容 sha256（十六进制小写）。 */
        public String sha256() {
            return sha256;
        }

        /** 角色标签（如 observation / criteria / scene-manifest）。 */
        public String role() {
            return role;
        }

        /** {@code {path, bytes, sha256, role}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("path", path);
            o.addProperty("bytes", bytes);
            o.addProperty("sha256", sha256);
            if (role != null) {
                o.addProperty("role", role);
            }
            return o;
        }
    }

    /** 一次 run 的目录与产物登记。 */
    public static final class Run {

        private final String runId;
        private final String caseId;
        private final long jobSeq;
        private final Path dir;
        private final String createdAt;
        private final Map<String, Artifact> artifacts = new LinkedHashMap<String, Artifact>();

        Run(String runId, String caseId, long jobSeq, Path dir, String createdAt) {
            this.runId = runId;
            this.caseId = caseId;
            this.jobSeq = jobSeq;
            this.dir = dir;
            this.createdAt = createdAt;
        }

        /** run 标识，等于 run 目录名。 */
        public String runId() {
            return runId;
        }

        /** 关联用例 id。 */
        public String caseId() {
            return caseId;
        }

        /** 关联作业序号。 */
        public long jobSeq() {
            return jobSeq;
        }

        /** run 目录绝对路径。 */
        public Path dir() {
            return dir;
        }

        /** 目录创建时间（ISO-8601）。 */
        public String createdAt() {
            return createdAt;
        }

        /** 已登记产物（按登记顺序）。 */
        public Map<String, Artifact> artifacts() {
            return artifacts;
        }

        /** 取单个已登记产物，未登记返回 null。 */
        public Artifact artifact(String path) {
            return path == null ? null : artifacts.get(path);
        }

        /** 产物清单数组。 */
        public JsonArray artifactsJson() {
            JsonArray arr = new JsonArray();
            for (Artifact a : artifacts.values()) {
                arr.add(a.toJson());
            }
            return arr;
        }

        /** 在 run 目录内解析相对路径（不做防穿越检查，调用方应经 {@link ArtifactStore#resolveInRun}）。 */
        public Path resolve(String relPath) {
            return dir.resolve(relPath);
        }

        /** 写一个文本产物（UTF-8）并登记；便捷方法，等价 writeArtifact(dir, bytes)。 */
        public Artifact writeText(ArtifactStore store, String relPath, String text, String role) {
            return store.writeArtifact(this, relPath, text.getBytes(StandardCharsets.UTF_8), role);
        }
    }

    private final Path runsRoot;
    private final TimeSource time;
    private final Consumer<String> logger;
    private final Map<String, Run> active = new LinkedHashMap<String, Run>();

    /** 默认 run 根：{@code <dataDir>/runs}。 */
    public ArtifactStore(Path runsRoot) {
        this(runsRoot, TimeSource.system(), null);
    }

    /** 全参构造。 */
    public ArtifactStore(Path runsRoot, TimeSource time, Consumer<String> logger) {
        if (runsRoot == null) {
            throw new IllegalArgumentException("runsRoot 不能为 null");
        }
        this.runsRoot = runsRoot.toAbsolutePath()
            .normalize();
        this.time = time == null ? TimeSource.system() : time;
        this.logger = logger;
    }

    /** run 根目录。 */
    public Path runsRoot() {
        return runsRoot;
    }

    /**
     * 建一个新 run 目录（{@code <compact ts>-<caseId>-<jobSeq>}）。
     *
     * <p>
     * 若同名目录已存在（同秒同作业号），追加 {@code -2}、{@code -3} 后缀，保证不复用既有目录
     * （「全程只增不改」）。
     *
     * @throws CpException CP-IO-001：目录创建失败
     */
    public Run createRun(String caseId, long jobSeq) {
        String safeCase = sanitizeCaseId(caseId);
        String base = time.compactNow() + "-" + safeCase + "-" + jobSeq;
        IOException last = null;
        for (int i = 1; i <= 99; i++) {
            String runId = i == 1 ? base : base + "-" + i;
            Path dir = runsRoot.resolve(runId)
                .normalize();
            if (!dir.startsWith(runsRoot)) {
                throw new CpException(ErrorCodes.IO, "run 目录越界: " + runId, null, 500);
            }
            if (Files.exists(dir)) {
                continue;
            }
            try {
                Files.createDirectories(dir);
                Run run = new Run(runId, safeCase, jobSeq, dir, time.isoNow());
                synchronized (active) {
                    active.put(runId, run);
                    while (active.size() > MAX_ACTIVE_RUNS) {
                        String oldest = active.keySet()
                            .iterator()
                            .next();
                        active.remove(oldest);
                    }
                }
                return run;
            } catch (IOException e) {
                last = e;
                break;
            }
        }
        throw CpException.io("创建 run 目录失败: " + base, last);
    }

    /** 内存中登记的活动 run；没有则 null。 */
    public Run activeRun(String runId) {
        synchronized (active) {
            return active.get(runId);
        }
    }

    /**
     * 查找 run：优先内存，其次从磁盘 {@code manifest.json} 还原。
     *
     * @return run；目录不存在返回 null
     */
    public Run findRun(String runId) {
        Run live = activeRun(runId);
        if (live != null) {
            return live;
        }
        Path dir = runDir(runId);
        if (dir == null || !Files.isDirectory(dir)) {
            return null;
        }
        return loadFromDisk(runId, dir);
    }

    /** run 目录（防穿越）；非法 runId 或越界返回 null。 */
    public Path runDir(String runId) {
        if (!isSafeRunId(runId)) {
            return null;
        }
        Path dir = runsRoot.resolve(runId)
            .normalize();
        return dir.startsWith(runsRoot) ? dir : null;
    }

    /**
     * 在指定 run 目录内解析相对路径并做防穿越检查。
     *
     * @throws CpException CP-VALID-002：路径非法或越出 run 目录
     */
    public static Path resolveInRun(Path runDir, String relPath) {
        if (runDir == null) {
            throw CpException.param("产物路径非法", "path", "run 目录不存在");
        }
        if (relPath == null || relPath.isEmpty()) {
            throw CpException.param("产物路径非法", "path", "不能为空");
        }
        if (relPath.indexOf('\0') >= 0) {
            throw CpException.param("产物路径非法", "path", "含 NUL 字符");
        }
        String unified = relPath.replace('\\', '/');
        if (unified.startsWith("/")) {
            throw CpException.param("产物路径非法", "path", "不允许绝对路径");
        }
        Path base = runDir.toAbsolutePath()
            .normalize();
        Path full = base.resolve(unified)
            .normalize();
        if (!full.startsWith(base)) {
            throw CpException.param("产物路径非法", "path", "越出 run 目录: " + relPath);
        }
        return full;
    }

    /**
     * 解析 {@code GET /cp/v1/artifacts/{runId}/{path}} 的目标文件。
     *
     * @return 目标文件的绝对路径；run 或文件不存在返回 null
     * @throws CpException CP-VALID-002：路径穿越
     */
    public Path resolveArtifact(String runId, String relPath) {
        Path dir = runDir(runId);
        if (dir == null || !Files.isDirectory(dir)) {
            return null;
        }
        Path full = resolveInRun(dir, relPath);
        return Files.isRegularFile(full) ? full : null;
    }

    /** 列出 run 根下全部 run 目录名（按名称排序，即时间序）。 */
    public List<String> listRunIds() {
        List<String> out = new ArrayList<String>();
        if (!Files.isDirectory(runsRoot)) {
            return out;
        }
        try {
            for (Path p : Files.newDirectoryStream(runsRoot)) {
                if (Files.isDirectory(p)) {
                    out.add(
                        p.getFileName()
                            .toString());
                }
            }
        } catch (IOException e) {
            warn("列举 run 目录失败: " + e.getMessage());
        }
        out.sort(Comparator.naturalOrder());
        return out;
    }

    /**
     * 写产物文件并登记。
     *
     * @param relPath run 目录内相对路径（'/' 分隔）
     * @param data    内容
     * @param role    角色标签，可为 null
     * @throws CpException CP-IO-001：写入失败
     */
    public Artifact writeArtifact(Run run, String relPath, byte[] data, String role) {
        if (run == null) {
            throw new CpException(ErrorCodes.IO, "run 不存在", null, 500);
        }
        byte[] bytes = data == null ? new byte[0] : data;
        Path target = resolveInRun(run.dir, relPath);
        try {
            Path parent = target.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.write(target, bytes);
        } catch (IOException e) {
            throw CpException.io("写产物失败: " + relPath, e);
        }
        return register(run, relPath, bytes.length, Hashing.sha256Hex(bytes), role);
    }

    /** 写 UTF-8 文本产物并登记。 */
    public Artifact writeText(Run run, String relPath, String text, String role) {
        return writeArtifact(run, relPath, (text == null ? "" : text).getBytes(StandardCharsets.UTF_8), role);
    }

    /**
     * 登记一个已存在于 run 目录内的文件（按内容计算 bytes 与 sha256，不复制）。
     *
     * @throws CpException CP-IO-001：文件不存在或不可读
     */
    public Artifact registerArtifact(Run run, String relPath, String role) {
        Path target = resolveInRun(run.dir, relPath);
        if (!Files.isRegularFile(target)) {
            throw new CpException(ErrorCodes.IO, "产物不存在: " + relPath, null, 404);
        }
        long size;
        try {
            size = Files.size(target);
        } catch (IOException e) {
            throw CpException.io("读取产物大小失败: " + relPath, e);
        }
        return register(run, relPath, size, Hashing.sha256Hex(target), role);
    }

    /**
     * 登记一条产物记录（调用方自行给出 bytes 与 sha256）。
     *
     * <p>
     * 用于「哈希口径不是文件字节」的场景：observation-record.md §2.1 规定
     * {@code runtimeReads[].sha256} 对摘要对象的规范化 JSON 计算。
     */
    public Artifact register(Run run, String relPath, long bytes, String sha256, String role) {
        if (run == null) {
            throw new CpException(ErrorCodes.IO, "run 不存在", null, 500);
        }
        // 仅做防穿越校验，不要求文件此刻存在（允许先登记后落盘）
        resolveInRun(run.dir, relPath);
        Artifact a = new Artifact(normalizeRel(relPath), bytes, sha256, role);
        synchronized (run.artifacts) {
            run.artifacts.put(a.path(), a);
        }
        return a;
    }

    /**
     * 生成 {@code manifest.json} 内容（不落盘）。
     */
    public JsonObject manifestJson(Run run) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", Contract.SCHEMA_MANIFEST);
        o.addProperty("runId", run.runId);
        o.addProperty("caseId", run.caseId);
        o.addProperty("jobSeq", run.jobSeq);
        o.addProperty("createdAt", run.createdAt);
        o.add("artifacts", run.artifactsJson());
        return o;
    }

    /**
     * 落盘 {@code manifest.json}（不把 manifest 自身登记为产物，避免自引用哈希）。
     *
     * @throws CpException CP-IO-001：写入失败
     */
    public Path writeManifest(Run run) {
        Path target = resolveInRun(run.dir, "manifest.json");
        try {
            Files.createDirectories(run.dir);
            Files.write(
                target,
                Json.toPretty(manifestJson(run))
                    .getBytes(StandardCharsets.UTF_8));
            return target;
        } catch (IOException e) {
            throw CpException.io("写 manifest.json 失败: " + run.runId, e);
        }
    }

    /** sha256 工具（转发 {@link Hashing}，供调用方从本类取用）。 */
    public static String sha256Hex(byte[] data) {
        return Hashing.sha256Hex(data);
    }

    /** 规范化相对路径（统一 '/'，去掉前缀 "./"）。 */
    public static String normalizeRel(String relPath) {
        String s = relPath == null ? "" : relPath.replace('\\', '/');
        while (s.startsWith("./")) {
            s = s.substring(2);
        }
        return s;
    }

    /** runId 是否形态安全（不含分隔符与 ..）。 */
    public static boolean isSafeRunId(String runId) {
        if (runId == null || runId.isEmpty() || ".".equals(runId) || "..".equals(runId)) {
            return false;
        }
        return runId.matches(RUN_ID_PATTERN);
    }

    /**
     * 从磁盘 {@code manifest.json} 还原一个 run。
     *
     * <p>
     * <b>元数据也要读回</b>（{@code caseId}/{@code jobSeq}/{@code createdAt}）：manifest 里本来就写着
     * 它们（{@link #manifestJson}），只在内存里认账的话，「按 caseId 发现某个 run」这类查询对
     * 已完成（或重启前）的 run 全部失效——而恰恰是那些 run 才是要事后核对的。
     * 实测症状（issue #98 的 {@code read.run}）：重启后枚举历史 run，{@code caseId} 全是 null、
     * {@code jobSeq} 全是 0，而 manifest 里数据俱全。
     */
    private Run loadFromDisk(String runId, Path dir) {
        Path manifest = dir.resolve("manifest.json");
        if (!Files.isRegularFile(manifest)) {
            return new Run(runId, null, 0, dir, null);
        }
        try {
            String text = new String(Files.readAllBytes(manifest), StandardCharsets.UTF_8);
            JsonObject o = Json.parseStrictObject(text);
            Run run = new Run(
                runId,
                Json.optString(o, "caseId", null),
                Json.optLong(o, "jobSeq", 0L),
                dir,
                Json.optString(o, "createdAt", null));
            JsonArray arr = Json.optArray(o, "artifacts");
            if (arr != null) {
                for (int i = 0; i < arr.size(); i++) {
                    if (!arr.get(i)
                        .isJsonObject()) {
                        continue;
                    }
                    JsonObject a = arr.get(i)
                        .getAsJsonObject();
                    String path = Json.optString(a, "path", null);
                    if (path == null) {
                        continue;
                    }
                    run.artifacts.put(
                        normalizeRel(path),
                        new Artifact(
                            normalizeRel(path),
                            Json.optLong(a, "bytes", -1),
                            Json.optString(a, "sha256", null),
                            Json.optString(a, "role", null)));
                }
            }
            return run;
        } catch (IOException e) {
            warn("读取 manifest 失败: " + runId + " / " + e.getMessage());
        } catch (RuntimeException e) {
            warn("manifest 内容非法: " + runId + " / " + e.getMessage());
        }
        // 解析失败：退化为「只有目录、没有清单」的 run（不吞掉这个 run 本身——目录确实在）
        return new Run(runId, null, 0, dir, null);
    }

    private static String sanitizeCaseId(String caseId) {
        if (caseId == null || caseId.trim()
            .isEmpty()) {
            return "case";
        }
        String s = caseId.trim()
            .toLowerCase(java.util.Locale.ROOT);
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
            sb.append(ok ? c : '-');
        }
        return sb.toString();
    }

    private void warn(String message) {
        if (logger != null) {
            logger.accept(Contract.LOG_PREFIX + " " + message);
        }
    }

    /** 便于调用方按数据目录取默认 run 根。 */
    public static Path defaultRunsRoot(Path dataDir) {
        return Paths.get(dataDir == null ? "." : dataDir.toString(), "runs");
    }
}
