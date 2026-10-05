package com.lightning.mod.client.controlplane.mc;

import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code world.snapshot}（scene，步进）：托管世界快照（v1 口径 = <b>整目录复制</b>）。
 *
 * <p>
 * 序：离开世界（让集成服保存并释放 region 句柄）→ 复制 {@code saves/<folder>} 到
 * {@code controlplane/snapshots/<snapshotId>/} → 计算目录哈希清单并写同 id 的 {@code .json} 元数据 →
 * 重进世界（复用 {@code level.dat}，不重建）。
 *
 * <p>
 * 参数：{@code folder}（可选；缺省用当前所在托管世界）、{@code snapshotId}（可选；缺省
 * {@code <yyyyMMdd-HHmmss>-<folder>}）、两个超时参数。
 */
public final class WorldSnapshotAction extends SteppingActionBase {

    /** 内部阶段。 */
    private enum Stage {
        /** 离开世界。 */
        LEAVE,
        /** 复制目录。 */
        COPY,
        /** 计算清单并写元数据。 */
        METADATA,
        /** 重进世界。 */
        ENTER,
        /** 完成。 */
        DONE
    }

    private final ControlPlaneRuntime runtime;
    private Stage stage = Stage.LEAVE;
    private Minecraft mc;
    private String folder;
    private String snapshotId;
    private WorldLoader loader;
    private FileTrees.Manifest manifest;
    private JsonObject worldDescription;
    private long copyStartedAt;

    public WorldSnapshotAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        String requested = ctx.optString("folder", null);
        if (requested != null && !requested.trim()
            .isEmpty()) {
            folder = requested.trim();
        } else if (mc.theWorld != null) {
            // 服务端权威优先：客户端 WorldClient 的目录名是占位 "none"，快照会对着一个不存在的世界
            folder = WorldDescriber.currentFolder(mc);
        }
        if (folder == null || folder.isEmpty()) {
            throw new CpException(
                ErrorCodes.STATE,
                "未有世界加载且未给 folder：快照需要指定托管世界目录",
                Json.object("folder", (String) null));
        }
        if (!ManagedWorld.isManagedFolderName(folder)) {
            throw CpException.param("托管世界目录名非法", "folder", "须以 " + ManagedWorld.PREFIX + " 开头: " + folder);
        }
        Path dir = ManagedWorld.requireManagedFolder(mc.mcDataDir, folder, "folder");
        ManagedWorld.assertManaged(dir, folder, "world.snapshot");

        String id = ctx.optString("snapshotId", null);
        if (id == null || id.trim()
            .isEmpty()) {
            id = SnapshotStore.newId(folder);
        }
        if (!SnapshotStore.isSafeId(id)) {
            throw CpException.param("snapshotId 非法", "snapshotId", "只允许 [A-Za-z0-9_.-]，收到: " + id);
        }
        String idFolder = SnapshotStore.folderOf(id);
        if (idFolder != null && !idFolder.equals(folder)) {
            throw CpException
                .param("snapshotId 与 folder 不一致", "snapshotId", "id 内嵌目录 " + idFolder + "，与 " + folder + " 不符");
        }
        snapshotId = id;

        Path target = SnapshotStore.dir(mc.mcDataDir, snapshotId);
        if (Files.isDirectory(target) && !isEmptyDir(target)) {
            throw new CpException(
                ErrorCodes.STATE,
                "快照 id 已存在且非空（快照只增不改）: " + snapshotId,
                Json.object("snapshotId", snapshotId, "dir", target.toString()));
        }
        ctx.beginRun("world-snapshot");
        loader = new WorldLoader(folder, ManagedWorld.displayNameOf(mc.mcDataDir, folder), null, null);
        SceneSessionGuard.arm(mc);
        enterStage("snapshot");
        CpLog.info("world.snapshot 开始：folder=%s snapshotId=%s", folder, snapshotId);
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        switch (stage) {
            case LEAVE: {
                enterStage("snapshot.leave");
                progress(ctx, 0.05d, "leave-world");
                if (!loader.ensureLeft(mc)) {
                    return null;
                }
                stage = Stage.COPY;
                return null;
            }
            case COPY: {
                enterStage("snapshot.copy");
                progress(ctx, 0.2d, "copy-world");
                Path src = ManagedWorld.requireManagedFolder(mc.mcDataDir, folder, "folder");
                if (!Files.isDirectory(src)) {
                    throw new CpException(
                        ErrorCodes.STATE,
                        "托管世界目录不存在: " + folder,
                        Json.object("folder", folder, "dir", src.toString()));
                }
                Path dst = SnapshotStore.dir(mc.mcDataDir, snapshotId);
                copyStartedAt = System.currentTimeMillis();
                try {
                    FileTrees.deleteTree(dst);
                    FileTrees.copyTree(src, dst);
                } catch (Exception e) {
                    throw CpException.io("复制存档目录失败: " + src + " -> " + dst, e);
                }
                stage = Stage.METADATA;
                return null;
            }
            case METADATA: {
                enterStage("snapshot.metadata");
                progress(ctx, 0.6d, "hash-world");
                Path dst = SnapshotStore.dir(mc.mcDataDir, snapshotId);
                try {
                    manifest = FileTrees.manifest(dst);
                } catch (Exception e) {
                    throw CpException.io("计算快照目录哈希清单失败: " + dst, e);
                }
                JsonObject meta = new JsonObject();
                meta.addProperty("schema", SnapshotStore.SCHEMA);
                meta.addProperty("snapshotId", snapshotId);
                meta.addProperty("folder", folder);
                meta.addProperty(
                    "createdAt",
                    TimeSource.system()
                        .isoNow());
                meta.addProperty(
                    "sourceDir",
                    ManagedWorld.worldDir(mc.mcDataDir, folder)
                        .toString());
                meta.addProperty("snapshotDir", dst.toString());
                meta.addProperty("copyMs", Long.valueOf(System.currentTimeMillis() - copyStartedAt));
                meta.addProperty("treeSha256", manifest.treeSha256());
                meta.addProperty("fileCount", manifest.fileCount());
                meta.addProperty("bytes", manifest.bytes());
                meta.add(
                    "files",
                    manifest.toJson()
                        .getAsJsonArray("files"));
                SnapshotStore.writeMeta(mc.mcDataDir, meta);
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.WORLD_SNAPSHOT,
                    "世界快照完成: " + snapshotId,
                    Json.object(
                        "snapshotId",
                        snapshotId,
                        "folder",
                        folder,
                        "treeSha256",
                        manifest.treeSha256(),
                        "fileCount",
                        Integer.valueOf(manifest.fileCount()),
                        "bytes",
                        Long.valueOf(manifest.bytes())));
                stage = Stage.ENTER;
                return null;
            }
            case ENTER: {
                enterStage("snapshot.enter");
                progress(ctx, 0.8d, "re-enter-world");
                JsonObject desc = loader.ensureEntered(mc);
                if (desc == null) {
                    return null;
                }
                worldDescription = desc;
                stage = Stage.DONE;
                return result(ctx);
            }
            default:
                return result(ctx);
        }
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        SceneSessionGuard.release(mc);
    }

    private JsonObject result(ActionContext ctx) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SnapshotStore.SCHEMA);
        o.addProperty("snapshotId", snapshotId);
        o.addProperty("folder", folder);
        if (manifest != null) {
            o.addProperty("treeSha256", manifest.treeSha256());
            o.addProperty("fileCount", manifest.fileCount());
            o.addProperty("bytes", manifest.bytes());
            JsonArray files = new JsonArray();
            for (FileTrees.Entry e : manifest.files()) {
                files.add(e.toJson());
            }
            o.add("files", files);
        }
        o.addProperty(
            "snapshotDir",
            SnapshotStore.dir(mc.mcDataDir, snapshotId)
                .toString());
        if (ctx.run() != null) {
            o.addProperty(
                "runId",
                ctx.run()
                    .runId());
        }
        if (worldDescription != null) {
            o.add("world", worldDescription);
        }
        o.addProperty("reentered", true);
        progress(ctx, 1.0d, "done");
        return o;
    }

    private static boolean isEmptyDir(Path dir) {
        try {
            if (!Files.isDirectory(dir)) {
                return true;
            }
            java.util.stream.Stream<Path> s = Files.list(dir);
            try {
                return !s.findFirst()
                    .isPresent();
            } finally {
                s.close();
            }
        } catch (Exception e) {
            return false;
        }
    }
}
