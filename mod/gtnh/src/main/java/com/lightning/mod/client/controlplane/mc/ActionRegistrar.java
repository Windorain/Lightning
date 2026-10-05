package com.lightning.mod.client.controlplane.mc;

import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.capture.CaptureBeginAction;
import com.lightning.mod.client.controlplane.mc.capture.CaptureEndAction;
import com.lightning.mod.client.controlplane.mc.capture.ShotMultiAction;

/**
 * 动作注册表（contract.md §4 的 8 个动作）。
 *
 * <p>
 * 这里的自描述是验收锚之一（A9）：**无先验知识的调用方仅凭 {@code GET /cp/v1/actions} 就能完成调用**。
 * 因此每个动作都要写全：名称、权限级、逐参数（名称/类型/必填/默认/说明）、返回结构、可复制示例、
 * 引入版本 {@code since}。描述与行为必须同步更新——描述错了比没有描述更糟。
 *
 * <p>
 * 同步 vs 步进：{@code core.*} / {@code world.info} / {@code case.validate} 是同步动作
 * （单次 tick 内完成）；其余世界/用例动作跨 tick 执行，注册为步进动作。
 * 全部动作都由 {@code ActionSteppingExecutor} 执行（它同时兼容同步注册项）。
 */
public final class ActionRegistrar {

    /** 全部步进动作共有的两个超时参数说明。 */
    private static final String TIMEOUT_DOC = "总超时（毫秒，≤0 表示不限）；超时抛 CP-EXEC-002";

    /** 见 {@link #TIMEOUT_DOC}。 */
    private static final String STAGE_TIMEOUT_DOC = "单个阶段超时（毫秒，≤0 表示不限）；超时抛 CP-EXEC-002";

    private ActionRegistrar() {}

    /** 注册全部 8 个动作。 */
    public static void registerAll(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder("core.ping", Tier.OBSERVE)
                .description("存活回声：确认控制面在跑、版本是否匹配、既有探针是否占用本客户端。")
                .returns(
                    "{pong:true, contractVersion, prefix, versions{mod,minecraft,forge,modsTotal}, serverTime, "
                        + "uptimeMs, busy, probeActive, probe, capabilities[]}")
                .example("{}")
                .since("1.0")
                .build(),
            new PingAction(runtime));

        registry.register(
            ActionDescriptor.builder("core.status", Tier.OBSERVE)
                .description("现场总览：版本、世界加载态、忙闲、事件流水游标、最近作业、快照与路径。")
                .returns(
                    "{contractVersion, versions{...}, world{...}, server{running,port,bind,uptimeMs}, busy, "
                        + "currentJobId, currentAction, pending, probeActive, probe, managedWorld, "
                        + "events{lastSeq,buffered,capacity}, jobs{lastSeq,count,counts,recent[]}, "
                        + "snapshots{count,latest,root}, paths{dataDir,casesRoot,runsRoot}, recentRuns[]}")
                .example("{}")
                .since("1.0")
                .build(),
            new StatusAction(runtime));

        registry.register(
            ActionDescriptor.builder("world.info", Tier.OBSERVE)
                .description(
                    "当前世界描述；未在世界中时返回 loaded:false（不是错误）。"
                        + " folder/managed/marker/generatorOptions/seed/gameType 等元数据取服务端权威世界"
                        + "（集成服 WorldServer），客户端 WorldClient 的占位存档名不会出现在这里；"
                        + " playerPos/playerName 等客户端字段取客户端世界，来源见 metaSource。")
                .returns(
                    "{loaded, world{loaded,folder,displayName,dimension,managed,markerPresent,generatorOptions,"
                        + "terrainType,mapFeatures,seed,worldTime,void,spawn[],playerPos[],metaSource}}")
                .example("{}")
                .since("1.0")
                .build(),
            new WorldInfoAction());

        registry.registerStepping(
            ActionDescriptor.builder("world.rebuild", Tier.SCENE)
                .description(
                    "幂等重建托管世界：离开当前世界 → 删除托管存档目录 → 固定种子建虚空世界 → "
                        + "可选执行 build 段 → 静置 → 写 cp_world.json 与场景清单。同参数两次执行场景哈希相等。"
                        + " folder 与 seed 运行期必填（缺失报 CP-VALID-002）；自描述不标 required，"
                        + "以便「缺 confirm 一律先被 CP-CONFIRM-001 拒掉」在空参数负测试里可观测。")
                .optional("folder", ActionDescriptor.TYPE_STRING, "托管世界存档目录名（运行期必填），须以 cp_ 开头")
                .optional("seed", ActionDescriptor.TYPE_INT, "固定种子（运行期必填，64 位整数）")
                .optional("void", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "是否虚空世界；v1 只允许 true")
                .optional("base", ActionDescriptor.TYPE_ARRAY, "构建基点 [x,y,z]（相对坐标的基准，也用于玩家稳定化）")
                .optional("settleTicks", ActionDescriptor.TYPE_INT, Integer.valueOf(60), "构建后静置 tick 数")
                .optional("build", ActionDescriptor.TYPE_ARRAY, "场景构建步骤（与用例文件 build 段同格式：clear/block/te/wait）")
                .optional("displayName", ActionDescriptor.TYPE_STRING, "世界展示名（默认同 folder）")
                .optional(
                    SteppingActionBase.PARAM_TOTAL_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_TOTAL_TIMEOUT_MS),
                    TIMEOUT_DOC)
                .optional(
                    SteppingActionBase.PARAM_STAGE_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_STAGE_TIMEOUT_MS),
                    STAGE_TIMEOUT_DOC)
                .returns(
                    "{schema, folder, seed, void, generatorOptions, voidSpec, settleTicks, runId, world{...}, "
                        + "marker{...}, scene{sha256,stepCount,blockCount,teCount,mismatchCount,manifestPath,manifest}, "
                        + "sceneIdempotencyKey}")
                .example(
                    "{\"folder\":\"cp_demo\",\"seed\":20261006,\"void\":true,\"base\":[64,12,64],"
                        + "\"settleTicks\":60,\"build\":[{\"op\":\"clear\",\"from\":[64,11,64],\"to\":[70,14,64]},"
                        + "{\"op\":\"block\",\"at\":[65,12,64],\"id\":\"minecraft:stone\",\"meta\":0}],\"confirm\":true}")
                .since("1.0")
                .build(),
            // 工厂注册（不是实例）：步进动作带作业级状态，每个作业必须拿新实例——
            // 复用单例会让第二个 case.run/world.* 直接返回上一个作业的结果（实测事故）
            () -> new WorldRebuildAction(runtime));

        registry.registerStepping(
            ActionDescriptor.builder("world.snapshot", Tier.SCENE)
                .description("托管世界快照（v1 口径=整目录复制）：离开世界 → 复制存档目录到 controlplane/snapshots/<id>/ " + "→ 计算目录哈希清单 → 重进世界。")
                .optional("folder", ActionDescriptor.TYPE_STRING, "托管世界目录名；缺省用当前所在托管世界")
                .optional("snapshotId", ActionDescriptor.TYPE_STRING, "快照 id；缺省 <yyyyMMdd-HHmmss>-<folder>")
                .optional(
                    SteppingActionBase.PARAM_TOTAL_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_TOTAL_TIMEOUT_MS),
                    TIMEOUT_DOC)
                .optional(
                    SteppingActionBase.PARAM_STAGE_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_STAGE_TIMEOUT_MS),
                    STAGE_TIMEOUT_DOC)
                .returns(
                    "{schema, snapshotId, folder, treeSha256, fileCount, bytes, files[{path,bytes,sha256}], "
                        + "snapshotDir, runId, world{...}, reentered}")
                .example("{\"folder\":\"cp_demo\",\"confirm\":true}")
                .since("1.0")
                .build(),
            () -> new WorldSnapshotAction(runtime));

        registry.registerStepping(
            ActionDescriptor.builder("world.rollback", Tier.SCENE)
                .description("回滚到快照（默认最近）：离开世界 → 快照目录整体覆盖 saves/<folder> → 重算树哈希并与快照比对 " + "→ 重进世界。哈希不一致即 CP-EXEC-001。")
                .optional("snapshotId", ActionDescriptor.TYPE_STRING, "快照 id；缺省用最近一次快照")
                .optional(
                    SteppingActionBase.PARAM_TOTAL_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_TOTAL_TIMEOUT_MS),
                    TIMEOUT_DOC)
                .optional(
                    SteppingActionBase.PARAM_STAGE_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_STAGE_TIMEOUT_MS),
                    STAGE_TIMEOUT_DOC)
                .returns(
                    "{schema, snapshotId, folder, treeSha256, verified, snapshotCreatedAt, expectedTreeSha256, "
                        + "runId, world{...}, reentered}")
                .example("{\"snapshotId\":\"20261006-120000-cp_demo\",\"confirm\":true}")
                .since("1.0")
                .build(),
            () -> new WorldRollbackAction(runtime));

        registry.register(
            ActionDescriptor.builder("case.validate", Tier.OBSERVE)
                .description("解析用例文件并返回规范化执行计划（分段、展开后的判据、期望证据、警告）；不碰世界。")
                .optional("file", ActionDescriptor.TYPE_PATH, "用例文件：绝对路径，或相对 <mcDataDir>/controlplane/cases/")
                .optional("inline", ActionDescriptor.TYPE_OBJECT, "内联用例（JSON 对象或用例 JSON 文本）；与 file 互斥")
                .returns(
                    "{caseId, caseSha256, source, valid, validatedAt, plan{world,segments[],build[],criteria[],"
                        + "variants[],evidence,warnings[]}, deferred[]?}")
                .example("{\"file\":\"demo.json\"}")
                .since("1.0")
                .build(),
            new CaseValidateAction(runtime));

        registry.registerStepping(
            ActionDescriptor.builder("case.run", Tier.SCENE)
                .description(
                    "执行用例（整跑或按段，同一实现）：world→capture→build→cameras→criteria→evidence，"
                        + "逐段落 segments/<name>.json，写 criteria.json / evidence.json / observation.json。"
                        + "capture 段建立捕获会话（期间世界写动作被拒 CP-STATE-001），cameras 段逐机位走 shot.multi 的"
                        + "同一实现；cameras 段非空时本动作按内容升格为 forensic（不足 CP-AUTH-002）。")
                .optional("file", ActionDescriptor.TYPE_PATH, "用例文件：绝对路径，或相对 <mcDataDir>/controlplane/cases/")
                .optional("inline", ActionDescriptor.TYPE_OBJECT, "内联用例（JSON 对象或用例 JSON 文本）；与 file 互斥")
                .optional(
                    "segments",
                    ActionDescriptor.TYPE_ARRAY,
                    "只跑指定段：world/capture/build/cameras/criteria/evidence 的子集")
                .optional("variant", ActionDescriptor.TYPE_STRING, "负对照变体 id：先应用补丁再跑同一实现，断言 expectCriteriaRed 全变红")
                .optional(
                    SteppingActionBase.PARAM_TOTAL_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_TOTAL_TIMEOUT_MS),
                    TIMEOUT_DOC)
                .optional(
                    SteppingActionBase.PARAM_STAGE_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_STAGE_TIMEOUT_MS),
                    STAGE_TIMEOUT_DOC)
                .returns(
                    "{caseId, caseSha256, runId, variant, segmentsRun[], segmentsSkipped[], segments[{segment,status,"
                        + "durationMs,detail}], deferred[]?, world{...}, scene{sha256,blockCount,teCount,...}, "
                        + "shots{cameraCount,shotCount,failedCount,cameras[],artifacts[{name,ok,file,metaFile,"
                        + "renderMode,lighting,worldTime}]}?, capture{spec,lighting,renderMode,armed}?, "
                        + "criteria{path,executed,overall,counts}, evidence{path,executed,verdict,detail}, overall, "
                        + "observationPath, variantVerification?, artifacts[], artifactCount, failure?}")
                .example("{\"file\":\"demo.json\",\"segments\":[\"world\",\"build\",\"criteria\"],\"confirm\":true}")
                .example(
                    "{\"file\":\"lp-pipe-row.json\",\"segments\":[\"world\",\"capture\",\"build\",\"cameras\","
                        + "\"criteria\",\"evidence\"],\"confirm\":true}")
                .since("1.0")
                .build(),
            () -> new CaseRunAction(runtime));

        registerForensicActions(runtime, registry);
    }

    /**
     * PR-2 取证级动作（contract.md §4.1）：{@code shot.multi} / {@code capture.begin} / {@code capture.end}。
     *
     * <p>
     * 三个动作都是 {@link Tier#FORENSIC}：截图与捕获是取证材料，比场景操作敏感。
     * {@code shot.multi} 是步进动作（多机位 × 多 tile × 静置 tick 必然跨 tick），按工厂注册；
     * 两个 capture 动作只翻转一个内存标志，注册为同步动作。
     */
    private static void registerForensicActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.registerStepping(
            ActionDescriptor.builder("shot.multi", Tier.FORENSIC)
                .description(
                    "多机位取证截图：逐机位注入虚拟相机（不挪真实玩家）与投影（透视/正交）、按需覆写渲染分辨率、"
                        + "截帧后还原。机位带 tile 段时走投影偏移 tiling（禁止视口拼接），产物为 shots/<name>.png、"
                        + "shots/<name>.meta.json（lightning.shot-meta/1），拼接机位另产 shots/<name>.tiles/。"
                        + "世界时刻可选指定；TE 渲染距离门随相机位置生效。")
                .optional(
                    "cameras",
                    ActionDescriptor.TYPE_ARRAY,
                    "机位表 [CameraSpec]（或单个 CameraSpec 对象）；CameraSpec={name,pos[x,y,z],yaw,pitch,"
                        + "projection{type:perspective|ortho,fov|orthoHeight},resolution[w,h],tile?{cols,rows,overlap}}")
                .optional("target", ActionDescriptor.TYPE_ARRAY, "观察目标包围盒 [[minx,miny,minz],[maxx,maxy,maxz]]（仅留痕）")
                .optional(
                    "lighting",
                    ActionDescriptor.TYPE_STRING,
                    "会话默认光照口径：natural | neutral-flat（可被逐机位覆盖；v1 不注入光照通道，仅留痕）")
                .optional("renderMode", ActionDescriptor.TYPE_STRING, "会话默认渲染模式：本色 | 参与光照（可被逐机位覆盖）")
                .optional("worldTime", ActionDescriptor.TYPE_INT, "拍摄光照基准（1.7.10 一天 0..23999 tick）；缺省沿用当前时刻")
                .optional("capture", ActionDescriptor.TYPE_OBJECT, "等价于把 lighting/renderMode/worldTime 写在一个对象里")
                .optional(
                    SteppingActionBase.PARAM_TOTAL_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_TOTAL_TIMEOUT_MS),
                    TIMEOUT_DOC)
                .optional(
                    SteppingActionBase.PARAM_STAGE_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(SteppingActionBase.DEFAULT_STAGE_TIMEOUT_MS),
                    STAGE_TIMEOUT_DOC)
                .returns(
                    "{schema, action, runId, cameraCount, shotCount, failedCount, cameras[{name,spec,ok,file,metaFile,"
                        + "tilesDir,width,height,renderMode,lighting,lightingApplied,worldTime,tile,tileCols,tileRows,"
                        + "tileOverlap,error?}], artifactsByCamera[{name,ok,file,metaFile,renderMode,lighting,worldTime}], "
                        + "target?, capture?, captureSession{armed,by}, baseDisplayWidth, baseDisplayHeight, "
                        + "settingsRestored, elapsedMs, warnings?, artifacts[], contractVersion}")
                .example(
                    "{\"cameras\":[{\"name\":\"front-top\",\"pos\":[64.5,20.0,70.5],\"yaw\":180.0,\"pitch\":-45.0,"
                        + "\"projection\":{\"type\":\"perspective\",\"fov\":70},\"resolution\":[1920,1080]},"
                        + "{\"name\":\"hi-res\",\"pos\":[64.5,20.0,70.5],\"yaw\":180.0,\"pitch\":-30.0,"
                        + "\"projection\":{\"type\":\"ortho\",\"orthoHeight\":16.0},\"resolution\":[3840,2160],"
                        + "\"tile\":{\"cols\":2,\"rows\":2,\"overlap\":0.05}}],"
                        + "\"lighting\":\"neutral-flat\",\"renderMode\":\"本色\",\"worldTime\":6000,\"confirm\":true}")
                .since("1.1")
                .build(),
            () -> new ShotMultiAction(runtime));

        registry.register(
            ActionDescriptor.builder("capture.begin", Tier.FORENSIC)
                .description(
                    "开始捕获会话：此后一切世界写动作（world.rebuild/world.snapshot/world.rollback 与 case.run 的 build 段）"
                        + "被拒 CP-STATE-001，直到 capture.end。重复 begin 也是 CP-STATE-001（不做隐式续期）。")
                .returns("{schema, began, jobId, action, beganAt, armed, requiredTier, contractVersion}")
                .example("{\"confirm\":true}")
                .since("1.1")
                .build(),
            new CaptureBeginAction());

        registry.register(
            ActionDescriptor.builder("capture.end", Tier.FORENSIC)
                .description("结束捕获会话并恢复世界写动作；未 begin 时幂等成功（返回值 idempotent=true）。")
                .returns(
                    "{schema, ended, wasArmed, idempotent, requestedBy, action, armed, previous{session}, requiredTier}")
                .example("{\"confirm\":true}")
                .since("1.1")
                .build(),
            new CaptureEndAction());
    }
}
