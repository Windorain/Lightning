package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * 快照仓（{@code world.snapshot} / {@code world.rollback} 的 v1 口径：<b>整目录复制</b>）。
 *
 * <pre>
 * controlplane/snapshots/&lt;id&gt;/     存档目录的完整副本（树哈希口径见 {@link FileTrees}）
 * controlplane/snapshots/&lt;id&gt;.json 元数据：{schema, snapshotId, folder, createdAt, treeSha256, fileCount, bytes}
 * </pre>
 *
 * <p>
 * 元数据放在<b>副本之外</b>：副本目录必须与存档目录逐字节同构，否则回滚校验（重建后的树哈希 == 快照时
 * 的树哈希）永远对不上。id 形如 {@code <yyyyMMdd-HHmmss>-<folder>}，因此按名字排序即时间序，
 * 「默认最近」不需要额外索引。
 */
public final class SnapshotStore {

    /** 元数据 schema。 */
    public static final String SCHEMA = "lightning.cp-snapshot/1";

    private SnapshotStore() {}

    /** 新快照 id：{@code <紧凑时间戳>-<folder>}。 */
    public static String newId(String folder) {
        return TimeSource.system()
            .compactNow() + "-"
            + folder;
    }

    /** id 是否形态安全（用作目录名/文件名，且不含路径成分）。 */
    public static boolean isSafeId(String id) {
        if (id == null || id.isEmpty() || ".".equals(id) || "..".equals(id)) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c == '_'
                || c == '-'
                || c == '.';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    /** 从 id 反解托管世界目录名（{@code <ts>-<folder>}，按 {@code cp_} 前缀起点切片）。 */
    public static String folderOf(String id) {
        if (id == null) {
            return null;
        }
        int idx = id.indexOf(ManagedWorld.PREFIX);
        if (idx < 0) {
            return null;
        }
        String folder = id.substring(idx);
        return ManagedWorld.isManagedFolderName(folder) ? folder : null;
    }

    /** 快照副本目录。 */
    public static Path dir(File mcDataDir, String id) {
        requireSafeId(id);
        Path root = CpPaths.snapshotsRoot(mcDataDir);
        Path p = root.resolve(id)
            .normalize();
        if (!p.startsWith(root) || p.equals(root)) {
            throw CpException.param("快照 id 越界", "snapshotId", id);
        }
        return p;
    }

    /** 快照元数据文件。 */
    public static Path metaFile(File mcDataDir, String id) {
        requireSafeId(id);
        Path root = CpPaths.snapshotsRoot(mcDataDir);
        Path p = root.resolve(id + ".json")
            .normalize();
        if (!p.startsWith(root)) {
            throw CpException.param("快照 id 越界", "snapshotId", id);
        }
        return p;
    }

    /** 写元数据。 */
    public static void writeMeta(File mcDataDir, JsonObject meta) {
        String id = Json.optString(meta, "snapshotId", null);
        requireSafeId(id);
        Path file = metaFile(mcDataDir, id);
        try {
            Files.createDirectories(file.getParent());
            Files.write(
                file,
                Json.toPretty(meta)
                    .getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw CpException.io("写快照元数据失败: " + file, e);
        }
    }

    /** 读元数据；不存在或不可解析返回 null。 */
    public static JsonObject readMeta(File mcDataDir, String id) {
        Path file = metaFile(mcDataDir, id);
        if (!Files.isRegularFile(file)) {
            return null;
        }
        try {
            return Json.parseStrictObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw CpException.io("读快照元数据失败: " + file, e);
        } catch (JsonSyntaxException e) {
            throw new CpException(ErrorCodes.IO, "快照元数据不是合法 JSON: " + file + " / " + e.getMessage());
        }
    }

    /** 全部快照 id（按名字升序 = 时间序）。 */
    public static List<String> listIds(File mcDataDir) {
        List<String> out = new ArrayList<String>();
        Path root = CpPaths.snapshotsRoot(mcDataDir);
        if (!Files.isDirectory(root)) {
            return out;
        }
        try {
            for (Path p : Files.newDirectoryStream(root)) {
                if (Files.isDirectory(p)) {
                    String name = p.getFileName()
                        .toString();
                    if (isSafeId(name)) {
                        out.add(name);
                    }
                }
            }
        } catch (IOException e) {
            CpLog.warn("列举快照目录失败: %s", String.valueOf(e));
        }
        out.sort(String::compareTo);
        return out;
    }

    /** 最近一次快照 id；没有则 null。 */
    public static String latestId(File mcDataDir) {
        List<String> ids = listIds(mcDataDir);
        return ids.isEmpty() ? null : ids.get(ids.size() - 1);
    }

    private static void requireSafeId(String id) {
        if (!isSafeId(id)) {
            throw CpException.param("快照 id 非法", "snapshotId", "只允许 [A-Za-z0-9_.-]，收到: " + id);
        }
    }
}
