package com.lightning.mod.client.controlplane.mc;

import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;

/**
 * {@code world.rollback}（scene，步进）：回滚到快照（默认最近）。
 *
 * <p>
 * 序：离开世界 → 用快照副本<b>整体覆盖</b> {@code saves/<folder>}（先删后拷，删除前过二次确认）
 * → 重算目录树哈希并与快照元数据比对（不一致即 {@code CP-EXEC-001}，因为「回滚后世界状态与快照时
 * 一致」是本动作的唯一承诺）→ 重进世界。
 *
 * <p>
 * 参数：{@code snapshotId}（可选，缺省最近）、两个超时参数。
 */
public final class WorldRollbackAction extends SteppingActionBase {

    /** 内部阶段。 */
    private enum Stage {
        /** 离开世界。 */
        LEAVE,
        /** 覆盖回存档目录。 */
        RESTORE,
        /** 校验树哈希。 */
        VERIFY,
        /** 重进世界。 */
        ENTER,
        /** 完成。 */
        DONE
    }

    private final ControlPlaneRuntime runtime;
    private Stage stage = Stage.LEAVE;
    private Minecraft mc;
    private String snapshotId;
    private String folder;
    private JsonObject meta;
    private String restoredTreeSha256;
    private boolean verified;
    private WorldLoader loader;
    private JsonObject worldDescription;

    public WorldRollbackAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        // 捕获会话门控（contract.md §7.3 与 §7.5 第 3 条）：begin 之后禁止一切世界写动作，违规 CP-STATE-001
        CaptureControl.assertWorldWriteAllowed(ctx);
        mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, "Minecraft 实例不可用");
        }
        String id = ctx.optString("snapshotId", null);
        if (id == null || id.trim()
            .isEmpty()) {
            id = SnapshotStore.latestId(mc.mcDataDir);
            if (id == null) {
                throw new CpException(
                    ErrorCodes.STATE,
                    "没有任何快照可回滚",
                    Json.object(
                        "snapshotsRoot",
                        runtime == null ? null
                            : runtime.snapshotsRoot()
                                .toString()));
            }
            CpLog.info("world.rollback 未指定 snapshotId，取最近快照 %s", id);
        }
        if (!SnapshotStore.isSafeId(id)) {
            throw CpException.param("snapshotId 非法", "snapshotId", "只允许 [A-Za-z0-9_.-]，收到: " + id);
        }
        snapshotId = id;
        Path dir = SnapshotStore.dir(mc.mcDataDir, snapshotId);
        if (!Files.isDirectory(dir)) {
            throw new CpException(
                ErrorCodes.STATE,
                "快照不存在: " + snapshotId,
                Json.object("snapshotId", snapshotId, "dir", dir.toString()),
                404);
        }
        meta = SnapshotStore.readMeta(mc.mcDataDir, snapshotId);
        folder = meta == null ? SnapshotStore.folderOf(snapshotId) : Json.optString(meta, "folder", null);
        if (folder == null || !ManagedWorld.isManagedFolderName(folder)) {
            throw new CpException(
                ErrorCodes.STATE,
                "快照元数据缺少可用的托管世界目录名: " + snapshotId,
                Json.object("snapshotId", snapshotId, "folder", String.valueOf(folder)));
        }
        ctx.beginRun("world-rollback");
        loader = new WorldLoader(folder, ManagedWorld.displayNameOf(mc.mcDataDir, folder), null, null);
        SceneSessionGuard.arm(mc);
        enterStage("rollback");
        CpLog.info("world.rollback 开始：snapshotId=%s folder=%s", snapshotId, folder);
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        switch (stage) {
            case LEAVE: {
                enterStage("rollback.leave");
                progress(ctx, 0.05d, "leave-world");
                if (!loader.ensureLeft(mc)) {
                    return null;
                }
                stage = Stage.RESTORE;
                return null;
            }
            case RESTORE: {
                enterStage("rollback.restore");
                progress(ctx, 0.3d, "restore-world");
                Path target = ManagedWorld.requireManagedFolder(mc.mcDataDir, folder, "folder");
                ManagedWorld.assertDeletable(target, folder, "world.rollback");
                Path src = SnapshotStore.dir(mc.mcDataDir, snapshotId);
                try {
                    FileTrees.deleteTree(target);
                    FileTrees.copyTree(src, target);
                } catch (Exception e) {
                    throw CpException.io("回滚覆盖存档目录失败: " + src + " -> " + target, e);
                }
                stage = Stage.VERIFY;
                return null;
            }
            case VERIFY: {
                enterStage("rollback.verify");
                progress(ctx, 0.6d, "verify-world");
                Path target = ManagedWorld.requireManagedFolder(mc.mcDataDir, folder, "folder");
                FileTrees.Manifest m;
                try {
                    m = FileTrees.manifest(target);
                } catch (Exception e) {
                    throw CpException.io("回滚后计算目录哈希清单失败: " + target, e);
                }
                restoredTreeSha256 = m.treeSha256();
                String expected = meta == null ? null : Json.optString(meta, "treeSha256", null);
                verified = expected != null && expected.equals(restoredTreeSha256);
                JsonObject data = Json.object(
                    "snapshotId",
                    snapshotId,
                    "folder",
                    folder,
                    "expectedTreeSha256",
                    expected,
                    "actualTreeSha256",
                    restoredTreeSha256,
                    "fileCount",
                    Integer.valueOf(m.fileCount()),
                    "bytes",
                    Long.valueOf(m.bytes()));
                ctx.emit(
                    verified ? EventStream.LEVEL_INFO : EventStream.LEVEL_ERROR,
                    EventStream.Kinds.WORLD_ROLLBACK,
                    "世界回滚" + (verified ? "校验通过" : "校验不一致") + ": " + snapshotId,
                    data);
                if (!verified) {
                    throw new CpException(
                        ErrorCodes.EXEC_FAILED,
                        "回滚后目录哈希与快照不一致（期望 " + expected + "，实际 " + restoredTreeSha256 + "）",
                        data);
                }
                stage = Stage.ENTER;
                return null;
            }
            case ENTER: {
                enterStage("rollback.enter");
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
        o.addProperty("treeSha256", restoredTreeSha256);
        o.addProperty("verified", verified);
        if (meta != null) {
            o.addProperty("snapshotCreatedAt", Json.optString(meta, "createdAt", null));
            o.addProperty("expectedTreeSha256", Json.optString(meta, "treeSha256", null));
        }
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
}
