package com.lightning.mod.client.controlplane.mc;

import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.capture.CaptureBeginAction;
import com.lightning.mod.client.controlplane.mc.capture.CaptureEndAction;
import com.lightning.mod.client.controlplane.mc.capture.ShotMultiAction;
import com.lightning.mod.client.controlplane.mc.cmd.CmdExecAction;
import com.lightning.mod.client.controlplane.mc.cmd.ExportSessionAction;
import com.lightning.mod.client.controlplane.mc.cmd.SdeCommandWhitelist;
import com.lightning.mod.client.controlplane.mc.export.ExportMultiblockAction;
import com.lightning.mod.client.controlplane.mc.export.ExportRegistryAction;
import com.lightning.mod.client.controlplane.mc.export.ExportSceneAction;
import com.lightning.mod.client.controlplane.mc.player.PlaceBlockAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerDigAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerGuiAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerInteractAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerLookAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerMoveAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerPickupAction;
import com.lightning.mod.client.controlplane.mc.player.PlayerSession;
import com.lightning.mod.client.controlplane.mc.player.SlotClickAction;
import com.lightning.mod.client.controlplane.mc.player.UseItemAction;
import com.lightning.mod.client.controlplane.mc.read.ReadBlockInfoAction;
import com.lightning.mod.client.controlplane.mc.read.ReadBlocksAction;
import com.lightning.mod.client.controlplane.mc.read.ReadDiffAction;
import com.lightning.mod.client.controlplane.mc.read.ReadInventoryAction;
import com.lightning.mod.client.controlplane.mc.read.ReadOverviewAction;
import com.lightning.mod.client.controlplane.mc.read.ReadPlayerAction;
import com.lightning.mod.client.controlplane.mc.read.ReadRunAction;
import com.lightning.mod.client.controlplane.mc.read.ReadTeAction;
import com.lightning.mod.client.controlplane.mc.scene.EntityClearAction;
import com.lightning.mod.client.controlplane.mc.scene.EntitySpawnAction;
import com.lightning.mod.client.controlplane.mc.scene.InventoryWriteAction;
import com.lightning.mod.client.controlplane.mc.scene.PlayerPoseAction;
import com.lightning.mod.client.controlplane.mc.scene.PlayerStateAction;
import com.lightning.mod.client.controlplane.mc.scene.TankFillAction;
import com.lightning.mod.client.controlplane.mc.scene.TankFillSpec;
import com.lightning.mod.client.controlplane.mc.scene.WeatherTimeAction;
import com.lightning.mod.config.SdeMultiblockConfig;
import com.lightning.mod.core.session.ExportSceneWriter;

/**
 * 动作注册表（自描述是验收锚之一，见 contract.md §2 的 {@code GET /cp/v1/actions}）。
 *
 * <p>
 * 这里的自描述是验收锚之一（A9）：**无先验知识的调用方仅凭 {@code GET /cp/v1/actions} 就能完成调用**。
 * 因此每个动作都要写全：名称、权限级、逐参数（名称/类型/必填/默认/说明）、返回结构、可复制示例、
 * 引入版本 {@code since}。描述与行为必须同步更新——描述错了比没有描述更糟。
 *
 * <p>
 * 分组：PR-1 的 11 个（{@code core.*}/{@code world.*}/{@code case.*}）+ PR-2 的 3 个取证级
 * （{@link #registerForensicActions}）+ #98 的 8 个观察面读面（{@link #registerReadActions}）
 * + #99 的 6 个 L0 布景原语（{@link #registerSceneActions}）+ #100 的 2 个命令通道
 * （{@link #registerCommandActions}）+ #101 的 9 个 L1 玩家操作（{@link #registerPlayerActions}，
 * {@code player.*}）+ #103 的 1 个收尾原语（{@link #registerShutdownAction}，{@code core.shutdown}）
 * + #102 的 3 个导出族（{@link #registerExportActions}，{@code export.scene} /
 * {@code export.registry} / {@code export.multiblock}）。
 *
 * <p>
 * 同步 vs 步进：{@code core.*} / {@code world.info} / {@code case.validate} 是同步动作
 * （单次 tick 内完成）；世界/用例/截图动作与 PR-2 的 {@code shot.multi} 跨 tick 执行，注册为步进动作。
 * L0 组（{@code scene.*}）是同步动作——只做一次性字段写入，无跨 tick 等待。
 * 全部动作都由 {@code ActionSteppingExecutor} 执行（它同时兼容同步注册项）。
 *
 * <h2>动作数与契约版本（D3 漂移防线）</h2>
 *
 * 动作面随 PR 追加而增长：PR-1 = 8 个（1.0）、PR-2 = +3 取证（1.1）、PR-3 判据（1.2）、
 * #98 = +8 读面（1.3）、#99 = +6 L0（1.3）、#100 = +2 命令通道（1.4）、#101 = +9 L1（1.5）、
 * #103 = +1 收尾原语（1.6）、#102 = +3 导出族（1.7）、#122 = +1 流体注入（1.7）——当前 41 个。
 * （#123 只改契约语义与响应字段，不新增动作。）<b>本注释里的数字必须与实际注册数一致</b>——历史上这里曾写「8 个」
 * 而实际 11 个（Gitea #97 §5-D3 判为文档漂移）。注册数可在实机经
 * {@code GET /cp/v1/actions} 的 {@code count} 字段一步核对，改动本文件后请顺手核一次。
 */
public final class ActionRegistrar {

    /** 全部步进动作共有的两个超时参数说明。 */
    private static final String TIMEOUT_DOC = "总超时（毫秒，≤0 表示不限）；超时抛 CP-EXEC-002";

    /** 见 {@link #TIMEOUT_DOC}。 */
    private static final String STAGE_TIMEOUT_DOC = "单个阶段超时（毫秒，≤0 表示不限）；超时抛 CP-EXEC-002";

    private ActionRegistrar() {}

    /**
     * 注册全部动作（PR-1 的 8 个 + PR-2 的 3 个取证 + #98 的 8 个读面 + #99 的 6 个 L0
     * + 收口T3 的 2 个命令通道 + #101 的 9 个 L1 + #103 的 1 个收尾原语 + #102 的 3 个导出族 = 40 个）。
     *
     * <p>
     * 数字以实机 {@code GET /cp/v1/actions} 的 {@code count} 为权威（见类注释「动作数与契约版本」）。
     */
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
                    "{loaded, world{loaded,folder,displayName,dimension,managed,markerPresent,markerComplete,"
                        + "generatorOptions,terrainType,mapFeatures,seed,worldTime,void,spawn[],playerPos[],metaSource}}")
                .example("{}")
                .since("1.0")
                .build(),
            new WorldInfoAction());

        registry.registerStepping(
            ActionDescriptor.builder("world.rebuild", Tier.SCENE)
                .description(
                    "幂等重建托管世界：离开当前世界 → 删除托管存档目录 → 写标记（complete:false，标记前置）→ "
                        + "固定种子建虚空世界 → 可选执行 build 段 → 静置 → 标记收口（complete:true）并写场景清单。"
                        + "同参数两次执行场景哈希相等。标记前置的用意：构建中途失败只留下「带标记」的残留，"
                        + "可正常经 world.rebuild 删除重建（修复前标记只在最末阶段写，失败残留无标记、无 API 可清）。"
                        + "标记语义见契约 §6.1：有标记=可删可重建；complete:true=可当成品复用（world.snapshot 只收后者）。"
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
                        + "marker{schema,folder,seed,void,complete,createdBy,createdAt,completedAt?}, "
                        + "scene{sha256,stepCount,blockCount,teCount,mismatchCount,manifestPath,manifest}, "
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
                .description(
                    "托管世界快照（v1 口径=整目录复制）：离开世界 → 复制存档目录到 controlplane/snapshots/<id>/ " + "→ 计算目录哈希清单 → 重进世界。"
                        + "只接受**构建完成**的托管世界（cp_world.json 的 complete:true，契约 §6.1/§6.6）："
                        + "失败残留（complete:false）的场景可能只铺了一半，拍成快照会被 world.rollback 当作期望态扶正。"
                        + "无标记目录同样拒绝（非托管世界，CP-STATE-001）。")
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
                .description(
                    "解析用例文件并返回规范化执行计划（分段、展开后的判据、期望证据、警告）与判据类型自描述"
                        + "（criteriaTypes[{type,since,params}]，PR-3 的两条判据 since=1.2）；不碰世界。")
                .optional("file", ActionDescriptor.TYPE_PATH, "用例文件：绝对路径，或相对 <mcDataDir>/controlplane/cases/")
                .optional("inline", ActionDescriptor.TYPE_OBJECT, "内联用例（JSON 对象或用例 JSON 文本）；与 file 互斥")
                .returns(
                    "{caseId, caseSha256, source, valid, validatedAt, plan{world,segments[],build[],criteria[],"
                        + "variants[],evidence,warnings[]}, criteriaTypes[{type,since,params}], deferred[]?}")
                .example("{\"file\":\"demo.json\"}")
                .since("1.0")
                .build(),
            new CaseValidateAction(runtime));

        registry.registerStepping(
            ActionDescriptor.builder("case.run", Tier.SCENE)
                .description(
                    "执行用例（整跑或按段，同一实现）：" + "world→capture→build→read→action→export→cameras→criteria→evidence（9 段，"
                        + "权威段序 = {@code CaseValidator.SEGMENTS}），"
                        + "逐段落 segments/<name>.json，写 criteria.json / evidence.json / observation.json。"
                        + "capture 段建立捕获会话（期间世界写动作被拒 CP-STATE-001），cameras 段逐机位走 shot.multi 的"
                        + "同一实现；cameras 段非空时本动作按内容升格为 forensic（不足 CP-AUTH-002）。"
                        + "read 段（v1.3）逐条执行用例声明的 read.* 动作，读数落本 run 目录供 criteria 直接引用；"
                        + "action 段（v1.6）执行任意已注册同步动作并可逐步断言；"
                        + "export 段（v1.7）执行导出族动作，产物落本 run 的 export/ 下并登记（C4 同 run 纪律）。")
                .optional("file", ActionDescriptor.TYPE_PATH, "用例文件：绝对路径，或相对 <mcDataDir>/controlplane/cases/")
                .optional("inline", ActionDescriptor.TYPE_OBJECT, "内联用例（JSON 对象或用例 JSON 文本）；与 file 互斥")
                .optional(
                    "segments",
                    ActionDescriptor.TYPE_ARRAY,
                    "只跑指定段：world/capture/build/read/action/export/cameras/criteria/evidence 的子集"
                        + "（组名以 CaseValidator.SEGMENTS 为准）")
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

        registerPlayerActions(runtime, registry);
        registerSceneActions(runtime, registry);
        registerForensicActions(runtime, registry);
        registerReadActions(runtime, registry);
        registerCommandActions(runtime, registry);
        registerShutdownAction(runtime, registry);
        registerExportActions(runtime, registry);
    }

    /**
     * 导出族动作（Gitea #102 收口T5，契约 1.7）：{@code export.scene} / {@code export.registry} /
     * {@code export.multiblock}。
     *
     * <h2>这一组的共同口径（#96 §10 C 族）</h2>
     *
     * <ul>
     * <li><b>产物单一归属（裁决 6）</b>：每个动作的每份产物有且只有一个落点 = 该动作 run 目录内的相对路径，
     * 且登记进该 run 的 {@code manifest.json}（{@code writeArtifact}/{@code registerArtifact}）。
     * <b>不存在</b>「原地一份 + 清单引用一份」的双态；老路径 {@code structure_exports/} 在 cp 通道
     * <b>不再被写</b>（它只服务尚未搬迁的命令通道，#104 删）。</li>
     * <li><b>D2 双通道一致</b>：三条链路各自与命令孪生（{@code /sde export} / {@code dump} /
     * {@code multiblock}）共用<b>同一个执行体</b>——{@code export.scene} 与命令通道共用
     * {@code ExportSceneWriter}；{@code export.registry} 与 {@code /sde dump} 共用
     * {@code ExportBundleClient.writeFullRegistryDump}；{@code export.multiblock} 直接调
     * {@code MultiblockExportRunner.run}。因此一致性是机械成立的，不靠约定。</li>
     * <li><b>D2 适用范围（补充裁决 X-11）</b>：只有这三条有命令孪生，故只有它们适用 D2。
     * 其余动作（含 {@code export.session}）不适用——不要为它们强行造比对。</li>
     * <li><b>帧预算（C6）</b>：{@code export.scene} 的两档预算（{@code maxFrames}/{@code maxCells}）
     * 在<b>扫描之前</b>算，超限 {@code CP-VALID-002} + {@code context.fields}，<b>不写任何产物</b>。</li>
     * </ul>
     *
     * <h2>权限级</h2>
     *
     * 三个都是 {@link Tier#SCENE}：它们产出的不是取证材料而是<b>场景数据</b>（与
     * {@code SdeCommandWhitelist} 对 {@code export}/{@code multiblock}/{@code dump} 的定级一致），
     * 且按契约 §1.6 由权限级派生要求 {@code "confirm": true}。
     */
    private static void registerExportActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.registerStepping(
            ActionDescriptor.builder(ExportSceneAction.NAME, Tier.SCENE)
                .description(
                    "把 ExportSession 帧缓冲导出为一份场景文件并登记进 run 清单（/sde export 的 cp 等价动作）。"
                        + "**与命令通道共用唯一写入器**（ExportSceneWriter）⇒ D2 一致是机械成立的。"
                        + "**在客户端 tick 线程一次写完**：不经过网络包，因此没有「服务端写一份 scan 中间态、"
                        + "客户端 enrich 覆盖一份」的二义（#97 §5-D8 / R1-1 / R1-2 从根上消掉）。"
                        + "**形态统一（R1-3）**：默认 shape=world ⇒ **单帧即 N=1 的多帧文档**，"
                        + "C1（单场景文件）与 C2（多帧）因此是同一种文件、同一条消费方解析路径；"
                        + "需要裸 StructureData 时显式 shape=structure（仅允许单帧）。"
                        + "**帧预算**：maxFrames/maxCells 在扫描之前算，超限 CP-VALID-002 且不写任何产物。"
                        + "**产物归属**：只落本 run 目录的 export/ 下并登记 sha256（裁决 6 单一归属）——"
                        + "工作台 ExportsListPanel 读的 structure_exports/ 看不到它，"
                        + "请用结果的 downloadPath 下载后喂解析器（C1 口径）。"
                        + "**⚠ 烘焙前置（Gitea #127，必读）**：几何烘焙发生在**导出这一刻**，逐格回查"
                        + "**当前活动世界**（`MeshCaptureService.finalizeSingleStructure`），取到空气即静默丢块；"
                        + "而 `provenance.frameSha256` 是**缓冲内 scan 文本**的哈希 ⇒ **内容变了哈希也不变**。"
                        + "因此「录制后改动世界 / 跨世界导出 / 录制与导出之间世界漂移」会得到内容不忠实的产物，"
                        + "且 C2/C3 判据对该失真**全绿**。要求：**帧必须在录制时所在世界内、且世界未被改动时导出**"
                        + "（`case.run` 的 world/export 段同 run 即是这条纪律的载体）；"
                        + "详见 `docs/contracts/format-scene-file.md` §6.2。显式校验（记 world folder+维度并比对）"
                        + "与按帧快照烘焙由 #127 承接，落地前不得把导出件当作「录制时刻世界状态」的证据。")
                .optional(
                    "name",
                    ActionDescriptor.TYPE_STRING,
                    "输出文件名（无后缀，会净化为 [A-Za-z0-9._-]）；缺省用 ExportSession.outputName（即 /sde setname 设的值）")
                .optional(
                    "frames",
                    ActionDescriptor.TYPE_STRING,
                    "all",
                    "导出哪些帧：\"all\"（默认，缓冲内全部）| \"active\"（只导活动帧）| [int...]（显式帧号清单，须都在缓冲内）。"
                        + "注意：帧号非 0 的单帧在旧实现里会走多帧文档分支，本动作默认形态恒 world，故不存在该隐式分叉")
                .optional(
                    "shape",
                    ActionDescriptor.TYPE_STRING,
                    ExportSceneWriter.Shape.WORLD.id(),
                    "产物形态：" + ExportSceneWriter.Shape.choices()
                        + "。world（默认）= {id,mode,frames[],playback} 多帧文档（单帧即 N=1）；structure = 裸单结构文档（仅单帧，且**不做**跨帧调色板提升）；auto = 旧隐函数（仅命令通道用于逐字节兼容，cp 不建议用）")
                .optional(
                    "raw",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.FALSE,
                    "true = 写明文 documentFormat:Plain；false（默认）= gzip+base64 Envelope")
                .optional(
                    "includeFrames",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.TRUE,
                    "是否另落逐帧明细 export/frames/F<n>.json（role scene-export-frame）；默认 true")
                .optional(
                    "maxFrames",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(ExportSceneAction.DEFAULT_MAX_FRAMES),
                    "帧数预算（默认 " + ExportSceneAction.DEFAULT_MAX_FRAMES
                        + "，绝对上限 "
                        + ExportSceneAction.HARD_MAX_FRAMES
                        + "）；超限 CP-VALID-002 + context.fields，不静默截断、不写产物")
                .optional(
                    "maxCells",
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(ExportSceneAction.DEFAULT_MAX_CELLS),
                    "体素预算（默认 " + ExportSceneAction.DEFAULT_MAX_CELLS
                        + "，跨全部帧的格子总数；单帧也单独校验）。在扫描之前算（选区尺寸 × 帧数），超限 CP-VALID-002")
                .optional(
                    "expectFrames",
                    ActionDescriptor.TYPE_OBJECT,
                    "C3 判据：显式声明本次导出应包含哪些帧 {frames:[int...]}。不符即 CP-STATE-001（带 expected/actual/extra/missing）——"
                        + "它拦的正是跨会话拼接：动作 A 录了 F0..F2、动作 B 又录了 F9，B 导出时声明 [0,1,2] 会当场判红而不是静默产出拼接物")
                .optional(
                    "keepBuffer",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.TRUE,
                    "契约 1.6 不提供隐式清缓冲（裁决 3：只增不改）；本参数恒 true 语义，传 false 只记一条 WARN，缓冲保持原样")
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
                    "{schema, contractVersion, action, runId, exportId, name, shape, raw, frames, frameIndexes[], "
                        + "bytes, sha256, path, role, includeFrames, frameArtifacts[{index,path,bytes,sha256,sourceSha256}], "
                        + "frameArtifactCount, bufferGeneration, frameSha256{<index>:<sha256>}, selection{...}, "
                        + "volumePerFrame, volumeTotal, keepBuffer, envelope(Envelope|Plain), downloadPath}。"
                        + "失败时抛：帧缓冲为空/选区不完整 CP-STATE-001、expectFrames 不符 CP-STATE-001、"
                        + "预算超限 CP-VALID-002（context.fields + computed 口径）、无世界 CP-STATE-001")
                .example("{\"confirm\":true}")
                .example("{\"name\":\"demo\",\"shape\":\"world\",\"includeFrames\":true,\"confirm\":true}")
                .example("{\"frames\":[0,1,2],\"expectFrames\":{\"frames\":[0,1,2]},\"confirm\":true}")
                .example("{\"shape\":\"structure\",\"frames\":[0],\"raw\":true,\"confirm\":true}")
                .since("1.7")
                .build(),
            () -> new ExportSceneAction());

        registry.registerStepping(
            ActionDescriptor.builder(ExportRegistryAction.NAME, Tier.SCENE)
                .description(
                    "/sde dump 的 cp 等价动作：请求客户端生成三份注册表（block/material/model_registry.json）"
                        + "并落**本 run 目录**的 registry/ 下，逐份登记 sha256（C5）。"
                        + "**与命令通道共用同一个写出体**（ExportBundleClient.writeFullRegistryDump）⇒ D2 机械成立。"
                        + "**run 由发起方持有**（裁决 7）：本动作开 run，用**内存投递单**把 run 落点显式传给客户端 tick"
                        + "——不让客户端用 mcDataDir/CWD 重新推导。★不设计成「/sde dump 自己开 run」："
                        + "命令跑在服务端线程，没有 ActionContext，强行开 run 会产出不属于任何作业的孤儿 run。"
                        + "内部件 registry/dump-request.json 消费后删除且**从不登记**（避免自引用清单项）。"
                        + "三份注册表写出后经**可解析性校验**（JSON 可解析 + 有 schemaVersion）才登记，缺一份即 CP-EXEC-001。")
                .optional(
                    "waitTicks",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(ExportRegistryAction.DEFAULT_WAIT_TICKS),
                    "等待客户端消费投递单的上限（tick，默认 " + ExportRegistryAction.DEFAULT_WAIT_TICKS
                        + " ≈ 30 s，最少 "
                        + ExportRegistryAction.MIN_SETTLE_TICKS
                        + "）；超时 CP-EXEC-002 + 上下文（不返回空清单）")
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
                    "{schema, contractVersion, action, runId, exportRoot, artifacts[{file,path,bytes,sha256,role}], "
                        + "artifactCount, waitedTicks, requestSeq, requestFileRemoved}。"
                        + "失败时抛：无世界 CP-STATE-001、已有待消费投递单 CP-BUSY-001、"
                        + "等待超时 CP-EXEC-002、写出不完整/不可解析 CP-EXEC-001")
                .example("{\"confirm\":true}")
                .since("1.7")
                .build(),
            () -> new ExportRegistryAction());

        registry.registerStepping(
            ActionDescriptor.builder(ExportMultiblockAction.NAME, Tier.SCENE)
                .description(
                    "/sde multiblock 的 cp 等价动作：枚举（T1.2 事实层）→ 逐台变体构建+捕获（T1.3）→ "
                        + "因子化编码（T1.4）→ 逐台信封落盘；产物落**本 run 目录**并登记哈希清单（C5）。"
                        + "**直接调 MultiblockExportRunner.run**（与命令通道/触发文件同一执行体）⇒ D2 机械成立。"
                        + "**主菜单下也能跑**：捕获自带 ProbeDummyWorld，不进真实世界（与既有行为一致）。"
                        + "**前置条件**：需要 T1.2 的枚举事实 multiblock_scan/run-NNNN/machines.json（与 /sde multiblock "
                        + "完全同一前置——不是 cp 侧额外要求）。缺失时报 CP-STATE-001 并给出补法；本动作**不**代为发起"
                        + "扫描（那是遍历 221 台的分钟级长跑，应由调用方显式决定）。"
                        + "**machines 必填且不得为空**：不复刻「空 scope = 全量 221 台」这个危险默认（R3-3："
                        + "两个 runner 对「空」的解释不同，会造成「导出 221 台、捕获只跑 4 台」的白跑）；"
                        + "要全量请显式写 [\"all\"]。**limit 已修**（R3-1）：走 RunConfig 显式字段，"
                        + "不再走「先赋静态字段再被 load() 覆盖」那条路。"
                        + "**时间预算分工**：globalBudgetMs 是业务预算（超时剩余机器进 failures[]，不静默跳过）；"
                        + "totalTimeoutMs/stageTimeoutMs 是作业看门狗——本动作天然长跑，默认把看门狗关掉（0 = 不限）。"
                        + "**dryRun**：只做枚举+范围过滤+抽样规划+预算核算，不捕获不落盘（报告里 dryRun:true 显式标注）。")
                .required(
                    "machines",
                    ActionDescriptor.TYPE_ARRAY,
                    "机器清单（simpleName / fqcn / slug）；[\"all\"] = 全量（枚举 221 台，默认配置下小时级）。"
                        + "**不得为空**：空清单会让导出与捕获两个半环对「空」给出不同解释（R3-3）")
                .optional(
                    "limit",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(0),
                    "台数上限（0 = 不限制；>0 时截取前 N 台）。已修 R3-1：走 RunConfig 显式字段而非被 load() 覆盖的静态字段")
                .optional(
                    "maxVariantsPerMachine",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(20000),
                    "单台变体数上限（安全兜底，默认取配置文件值 " + SdeMultiblockConfig.maxVariantsPerMachine
                        + "）；超限时按契约 tierSample 抽样 + 必要时收窄通道域，产物 notes 如实记录")
                .optional(
                    "maxChannelValues",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(0),
                    "通道取值数上限（0 = 不限制，用 T1.2 事实层全量域）；收窄会牺牲忠实度，产物 notes 记录真实域")
                .optional("structuralOnly", ActionDescriptor.TYPE_BOOL, Boolean.FALSE, "只导出结构性组合（跳过 active 运行态，变体数减半）")
                .optional(
                    "globalBudgetMs",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(0),
                    "整轮业务预算（ms；0 = 用配置文件默认 4h）。超时后剩余机器进 failures[]（不静默跳过）")
                .optional("keepDataset", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "是否保留中间数据集（默认 true，供离线复算）")
                .optional(
                    "dataset",
                    ActionDescriptor.TYPE_STRING,
                    ExportMultiblockAction.DatasetMode.MANIFEST_ONLY.id(),
                    "数据集登记档位：" + ExportMultiblockAction.DatasetMode.choices()
                        + "。manifest-only（默认）= 只登记身份件（manifest/palette/report）——全量 221 台的 machines/*.json "
                        + "会产生数百条清单项，逐份下载价值低；all = 逐份登记（证据更硬、清单更长）；none = 只落磁盘不登记")
                .optional(
                    "dryRun",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.FALSE,
                    "true = 只做枚举+范围过滤+抽样规划+预算核算，不捕获不落盘（报告 dryRun:true）")
                .optional(
                    SteppingActionBase.PARAM_TOTAL_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(0L),
                    "作业看门狗总超时（毫秒，默认 **0 = 不限**——本动作天然长跑，由 globalBudgetMs 兜底）；超时抛 CP-EXEC-002")
                .optional(
                    SteppingActionBase.PARAM_STAGE_TIMEOUT,
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(0L),
                    "单个阶段超时（毫秒，默认 **0 = 不限**）；超时抛 CP-EXEC-002")
                .returns(
                    "{schema, contractVersion, action, runId, dryRun, datasetMode, outputRoot, datasetDir, "
                        + "requestedMachines, enumeratedTotal, exportedProducts, failureCount, elapsedMs, "
                        + "artifacts[{path,bytes,sha256,role,machine?}], artifactCount, config{...}, timing{...}, "
                        + "failures[{machine,stage,kind,message}], samplingPlan[], notes[], report}。"
                        + "失败时抛：machines 缺失/为空或 dataset 取值非法 CP-VALID-002、"
                        + "客户端不可用或无 T1.2 枚举事实（multiblock_scan/run-*/machines.json）CP-STATE-001"
                        + "（context.expected/scanDir/hint 给出补法）")
                .example("{\"machines\":[\"MTEElectricBlastFurnace\"],\"dryRun\":true,\"confirm\":true}")
                .example("{\"machines\":[\"all\"],\"limit\":5,\"dataset\":\"manifest-only\",\"confirm\":true}")
                .example(
                    "{\"machines\":[\"MTEElectricBlastFurnace\",\"MTEDistillationTower\"],\"structuralOnly\":true,\"confirm\":true}")
                .since("1.7")
                .build(),
            () -> new ExportMultiblockAction());
    }

    /**
     * 无人值守收尾原语（issue #103，V5 裁决）：{@code core.shutdown}。
     *
     * <h2>为什么它在 {@code core.*} 组而不是新开一族</h2>
     * 它管的是<b>进程</b>，与 {@code core.ping}/{@code core.status} 同域（进程级事实）；而
     * 「跑完就退出 + 退出码」是无人值守编排的收尾动作，不是场景能力。命名因此是 {@code core.shutdown}
     * 而不是 {@code world.}/{@code case.}/{@code scene.} 族。
     *
     * <h2>权限级</h2>
     * {@link Tier#SCENE}（可写级 ⇒ 框架自动要求 {@code "confirm": true}）。理由不是「它改了世界」
     * （它不改），而是「它结束进程」——比任何世界写都不可逆，必须过同一道确认门
     * （{@code CP-CONFIRM-001}）。这条也让「交互模式下误调」在参数层就被挡住。
     *
     * <h2>不注册为步进</h2>
     * 同步动作：定码是纯读盘 + 纯计算，退出排在守护线程里（见 {@link ShutdownAction}）。
     * 因此它也不会被 {@code case.run} 的 {@code action} 段接受——但那不是因为「步进」，
     * 而是它被 {@code CaseValidator.ACTION_FORBIDDEN} 明确挡在编排之外（收尾必须由驱动单独发起）。
     */
    private static void registerShutdownAction(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder(ShutdownAction.NAME, Tier.SCENE)
                .description(
                    "无人值守收尾原语：读 run 的**结论**（`criteria.json` 与 `evidence.json` ← 两份的 overall，任一非绿即红）"
                        + " → 按约定定退出码 →（默认）延迟后结束客户端进程。"
                        + "退出码约定 **0=判据全绿 / 2=有红 / 3=设施错误**，与 run 的合并结论对齐——"
                        + "这是外层无人值守脚本唯一的稳定进程级信号（老批处理设施删除后 cp 侧原本是真空，见 #103 V5 裁决）。"
                        + "**为什么读两份**：`criteria.json.overall` 是用例声明的**判据**结论，`evidence.json.overall` 是**期望证据核对**"
                        + "结论，两者语义不同、不可互替（实机实测存在 criteria=red 而 evidence=green 的 run）。只读其一会把一次红跑"
                        + "报成「判据全绿」——那正是本动作最不该犯的错。合并规则与 `case.run` 的 `overall` 逐字同源。"
                        + "**退出纪律**：0 走 Minecraft.shutdown() 正常收尾，非 0 走 FMLCommonHandler.exitJava(code,false)；"
                        + "两条路都先挂 120s 安全网（到点 exitJava(code,true) 硬退）。**绝不** Runtime.halt/System.exit——"
                        + "FML 的 FMLSecurityManager 会把非 cpw.mods.fml 发起的 exitVM 静默拦成 ExitTrappedException，"
                        + "进程仍以 0 退出（实测事故），外层脚本会把红跑读成绿跑。"
                        + "**为什么延迟**：本动作的结论要经 HTTP 响应回给调用方，而响应在动作返回之后才写；就地退出会把调用方"
                        + "吊死在一个永不来的响应上。故实际退出跑在延迟 "
                        + ShutdownAction.DEFAULT_DELAY_MS
                        + "ms 的守护线程里，结果里如实给 exitScheduledInMs。"
                        + "**可判定性**：dryRun:true 只定码不退出，用它可以在不杀进程的前提下逐条核对「码与 run 结论对齐」。"
                        + "**不许编入固定程序**：本动作会让本作业后续段不再执行，case.run 的 action 段一律拒绝它"
                        + "（CaseValidator.ACTION_FORBIDDEN）——收尾由驱动在整跑结束后单独发起。")
                .optional("runId", ActionDescriptor.TYPE_STRING, "要读结论的 run 目录名（缺省时按 caseId 找该用例最新的 run）")
                .optional(
                    "caseId",
                    ActionDescriptor.TYPE_STRING,
                    "按用例 id 找最新 run（与 runId 二选一；都没有且没给 code 即设施错误 code=3）")
                .optional("code", ActionDescriptor.TYPE_INT, "显式退出码：给出即不再读 run 结论（0/2/3 为约定码；其它值按调用方自己的口径，结果里会如实标注）")
                .optional("dryRun", ActionDescriptor.TYPE_BOOL, Boolean.FALSE, "只定码与报告，不排定退出（默认 false = 真的退）")
                .optional(
                    "delayMs",
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(ShutdownAction.DEFAULT_DELAY_MS),
                    "排定退出前的延迟（毫秒，默认 " + ShutdownAction.DEFAULT_DELAY_MS + "）——留足时间让 HTTP 响应写回调用方；0 = 尽快（仍经守护线程，不是就地退）")
                .optional("reason", ActionDescriptor.TYPE_STRING, "退出原因（写进结果与事件，便于审计）")
                .returns(
                    "{schema, action, contractVersion, code, codeMeaning, source, runOverall, criteriaOverall, "
                        + "evidenceOverall, runId, caseId, "
                        + "evidencePath, detail?, reason?, exitCodeConvention, dryRun, exitScheduled, "
                        + "exitScheduledInMs?, watchdogMs?, exitPath?}。"
                        + "source 取值：explicit（显式给码）/ run-overall（按 run 结论：criteria.json 与 evidence.json 合并）/ "
                        + "caseId-lookup | runs-root | none（读不出来 ⇒ code=3 设施错误）。"
                        + "失败时抛：run 读不出来不抛异常而是 code=3（本动作的职责就是如实报设施错误）；"
                        + "code 越界 CP-VALID-002")
                .example("{\"runId\":\"20261007-120000-cp-smoke-basic-12\",\"confirm\":true}")
                .example("{\"caseId\":\"read-surface\",\"dryRun\":true,\"confirm\":true}")
                .example("{\"code\":2,\"reason\":\"外部驱动已判定红\",\"confirm\":true}")
                .since("1.6")
                .build(),
            new ShutdownAction());
    }

    /**
     * 命令通道动作（Gitea #100 收口T3）：{@code cmd.exec} 与只读自查面 {@code export.session}。
     *
     * <p>
     * 两者的关系是本单的设计要点：<b>设状态走命令通道（{@code cmd.exec}），验状态走只读读面
     * （{@code export.session}）</b>。没有后者，AI 经前者设完选区/帧号之后无法自查（#97 §2.4-G2），
     * 也就无法满足 #96 §8.1「自描述即可调用」与 §10-D2「双通道一致可判定」。
     *
     * <p>
     * <b>权限级</b>：{@code cmd.exec} 注册为 {@link Tier#SCENE}（可写级 ⇒ 框架自动要求
     * {@code "confirm": true}）；它执行的白名单条目<b>逐条</b>登记了自己的级（见
     * {@link SdeCommandWhitelist}），动作在运行期按<b>内容</b>再做一次升格检查
     * （{@code CmdExecAction.requireTier}）——口径同 {@code case.run} 的 cameras 段（contract.md §4.2 第 9 条）。
     * {@code export.session} 是纯只读，注册为 {@link Tier#OBSERVE}（无 confirm、可自由轮询）。
     */
    private static void registerCommandActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder("export.session", Tier.OBSERVE)
                .description(
                    "只读：返回 ExportSession 单例态的一致性快照（会话开关/选区模式/pos1/pos2/规范化 min-max 与尺寸/"
                        + "活动帧/已录帧号/输出名/structureId/最近作者）。"
                        + "用途是「经 cmd.exec 设完状态后自查」——没有它就无法判定命令是否真的生效（#97 §2.4-G2）。"
                        + "唯一触碰的是 ExportSession.snapshot()（同一临界区取全部字段，避免逐调 getter 拿到互相矛盾的组合）；"
                        + "不写任何状态、不碰世界与文件、不建 run 目录，故世界清单哈希不变。"
                        + "与 /sde status 同源同形：结果的 statusLine 字段就是 /sde status 打印的那一行。")
                .returns(
                    "{schema, contractVersion, inSession, selectionMode, "
                        + "selection{complete,pos1[x,y,z]|null,pos2[x,y,z]|null,min,max,sizeX?,sizeY?,sizeZ?}, "
                        + "activeFrame, recordedFrames[], recordedFrameCount, frameSha256[], bufferGeneration, "
                        + "outputName, structureId, lastAuthor, lastGtnhVersion, statusLine}"
                        + "。frameSha256[] 与 recordedFrames[] **同序一一对应**（帧内容 sha256，"
                        + "口径 = 该帧进入缓冲时的 JSON 文本 UTF-8 字节），供 C3「同会话同缓冲」机械判据；"
                        + "bufferGeneration 是缓冲世代号（写入帧/清空即递增），用于廉价判断「缓冲有没有动过」。"
                        + "本动作不含备注内容与帧体，只有哈希与计数——需要帧体请走 export 产物。")
                .example("{}")
                .since("1.4")
                .build(),
            new ExportSessionAction());

        registry.register(
            ActionDescriptor.builder("cmd.exec", Tier.SCENE)
                .description(
                    "在服务端线程执行一条白名单内的 /sde 子命令，并返回该命令的真实回报文本（与游戏内手动执行同一命令" + "逐字相同）。白名单是显式枚举（见 choices 与 exclusions），共 "
                        + SdeCommandWhitelist.allowedSubcommands()
                            .size()
                        + " 条；"
                        + "**排除 web / webstop / hajimi / hjm**（理由见 exclusions）。白名单外一律显式拒绝："
                        + "错误码 CP-VALID-002 + 原因 + context.alternatives[] 可行替代。"
                        + "线程语义：命令在 1.7.10 集成服的 \"Server thread\" 上执行（与玩家聊天框敲命令同一路径、同一线程），"
                        + "cp 动作在 Client thread 提交并阻塞等待回包；两线程通过 ExportSession 的同一把私有锁互斥，"
                        + "等待方向单一（客户端等服务端），结构上不会死锁。"
                        + "**产物口径**：export/dump/multiblock 产生的文件落在 CWD 相对路径 structure_exports/ 下"
                        + "（runClient 下 CWD == mcDataDir），不在 cp 的 run 目录内，故只把路径与存在性写入结果 artifacts[] 与事件流水，"
                        + "不假造 run 清单条目；产物迁入 run 目录归 #102。"
                        + "**回报与审计**：每次调用（含拒绝）落一条 kind=cmd-exec 事件，data 含 commandText/command/sub/"
                        + "allowed/decision/status/reply/artifacts。")
                .required(
                    "command",
                    ActionDescriptor.TYPE_STRING,
                    "命令文本，形如 \"/sde status\" 或 \"sde pos1\"（前导 '/' 可省）。只允许 /sde 家族的白名单子命令；" + "长度上限 512 字符")
                .optional(
                    "timeoutMs",
                    ActionDescriptor.TYPE_INT,
                    Long.valueOf(CmdExecAction.DEFAULT_TIMEOUT_MS),
                    "等待服务端线程回包的上限（毫秒，≤0 用默认 " + CmdExecAction.DEFAULT_TIMEOUT_MS
                        + "）；超时抛 CP-EXEC-002 并带已耗时。注意本参数是动作自有参数，与控制面自己的 ?timeoutMs= 查询参数不同名不同义"
                        + "（后者是 ?sync=true 的等待上限）")
                .returns(
                    "{schema, contractVersion, command, sub, tier, status(ok|no-server|timeout|exception), reply, "
                        + "replies[], replyLineCount, executedOnThread, serverTick, elapsedMs, timeoutMs, senderName, "
                        + "sessionAfter{...同 export.session}, artifacts[{role,path,exists,note}]}。"
                        + "失败时抛：白名单外 CP-VALID-002（context.fields + context.alternatives[]）、"
                        + "无服务端玩家 CP-STATE-001、等待超时 CP-EXEC-002、命令内部异常 CP-EXEC-001")
                .example("{\"command\":\"/sde status\",\"confirm\":true}")
                .example("{\"command\":\"/sde pos1\",\"confirm\":true}")
                .example("{\"command\":\"/sde setframe 5\",\"confirm\":true}")
                .example("{\"command\":\"/sde record\",\"confirm\":true}")
                .example("{\"command\":\"/sde export\",\"confirm\":true}")
                .since("1.4")
                .build(),
            new CmdExecAction());
    }

    /**
     * L1 玩家操作（issue #101，「收口T4」）：{@code client/controlplane/mc/player/}，全部 {@link Tier#SCENE}。
     *
     * <h2>这一组与 {@code scene.*}（L0）的区别（#96 §4.1，裁决 3）</h2>
     * 不是「谁写的代码」，而是<b>请求从哪条路进入世界</b>：
     * <ul>
     * <li>{@code scene.*}（L0）：直接设定服务端权威世界的状态——{@code world.setBlock}、
     * 直接写 {@code InventoryPlayer}、{@code setPositionAndUpdate}。快、稳、少变量，<b>布景与构造输入</b>用它。</li>
     * <li>{@code player.*}（L1，本组）：把请求做成<b>原版客户端会发出的那个包</b>
     * （{@code PlayerControllerMP} 的 C02/C07/C08/C09/C0E/C16 与 {@code EntityClientPlayerMP} 的 C03），
     * 经集成服的 {@code NetHandlerPlayServer} 原样处理——距离校验、保护校验、Forge 事件、
     * 游戏模式分支、服务端 {@code ItemInWorldManager} 与 {@code Container.slotClick} 全部照常发生。
     * 验证「<b>玩家行为引发的行为</b>」与教程重建用它。</li>
     * </ul>
     * <b>两层结论不互替</b>（#96 §4.2）：{@code scene.player.pose} 的位移不是「走过去了」的证据，
     * {@code scene.inventory.write} 的写入不是「捡起来了」的证据。每个 {@code player.*} 动作的返回值
     * 都带 {@code layer:"L1"} 与 {@code semantics}，与 L0 的 {@code layer:"L0"} 成对。
     *
     * <h2>两义成对（裁决 3/4）</h2>
     * <ul>
     * <li><b>位置与朝向</b>：{@code scene.player.pose}（L0，{@code semantics:"teleport"}，瞬时）↔
     * {@code player.move}（L1，{@code "walk"}，逐 tick 过原版碰撞）+ {@code player.look}（L1，{@code "turn"}）；</li>
     * <li><b>拿到物品</b>：{@code scene.inventory.write}（L0，{@code "give"}，直接写槽）↔
     * {@code player.pickup}（L1，{@code "pickup"}，世界里已有掉落物 → 走过去碰它）。</li>
     * </ul>
     *
     * <h2>同步 vs 步进</h2>
     * 本组八个动作都是同步动作：一次调用内做有限步（移动/挖掘/拾取在 {@code maxTicks}/{@code holdTicks}
     * 上界内推进），不跨 tick 等待世界装卸。<b>不</b>注册为步进是有意的取舍——
     * 步进动作的实例活在整个作业期间，而 L1 的价值恰恰是「一次次试探、随时改主意」（#96 §3 探索模式）；
     * 一次调用内跑完一小步，调用方在两次调用之间可以自由读面、截图、回滚。
     *
     * <h2>探索模式纪律（#96 §3、§8.5）</h2>
     * 本组的失败<b>一律不导致进程重启或崩溃</b>：参数类 {@code CP-VALID-002}（带 {@code context.fields}）、
     * 前置状态类 {@code CP-STATE-001}（带「差什么、怎么补」）、原版抛出意外的
     * {@code CP-EXEC-001}（带 cause，栈不丢）。而「玩家路径执行了但世界没变」这类
     * <b>不是错误</b>——它返回 {@code observed:false} + {@code notObservedReason} + 逐格回读，
     * 让调用方自己判。这是「便宜试错」的物质基础：试错的结果必须可解释，而不是把进程带走。
     *
     * <h2>无隐藏通道（#96 §8.7 / D5）</h2>
     * 本组只调原版对象自己的方法——不自己拼 C0x 包、不直接写服务端世界或背包。
     * 抄一份「看起来一样」的服务端逻辑会立刻与真客户端行为分叉，而分叉正是 L1 要验证的东西；
     * 那也就是被禁止的第二条能力路径。
     */
    private static void registerPlayerActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder(PlayerMoveAction.NAME, Tier.SCENE)
                .description(
                    "L1：经玩家移动路径把玩家移到目标位置（<b>不是瞬移</b>）。逐 tick 走原版 AABB 碰撞推进，"
                        + "每步后调 EntityClientPlayerMP.sendMotionUpdates() 让原版客户端自己发 C03 位置包；"
                        + "服务端在 NetHandlerPlayServer.processPlayer 里照常校验（非法姿态 / moved too quickly / "
                        + "moved wrongly / floating），必要时把玩家拽回来——拽回是这条路径的真实后果，"
                        + "返回值如实给出 serverAfter/serverBefore 两侧读数，不掩盖。"
                        + "与 scene.player.pose（L0，瞬时传送 + S08）互补而不互替：要「玩家站在这里」用 L0，"
                        + "要验证「走过去这件事」用本动作（#96 §4.1 裁决 3）。"
                        + " to 与 distance 互斥必居其一；to 形态走到容差内或被方块挡住为止。"
                        + " 撞墙时如实停手（不硬穿墙），返回 blocked:true。")
                .optional("to", ActionDescriptor.TYPE_ARRAY, "目标位置 [x,y,z]（可为小数）；与 distance 互斥")
                .optional("distance", ActionDescriptor.TYPE_NUMBER, "沿 direction 走的距离（格）；与 to 互斥")
                .optional(
                    "direction",
                    ActionDescriptor.TYPE_STRING,
                    "forward",
                    "distance 形态的方向：forward | back | left | right | up | down（相对玩家当前 yaw；默认 forward）")
                .optional(
                    "maxTicks",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(PlayerMoveAction.DEFAULT_MAX_TICKS),
                    "最多推进的 tick 数（1..12000）；每 tick 走 ≤" + PlayerMoveAction.STEP_PER_TICK
                        + " 格，因此这是距离上限也是时间上限。到达容差 "
                        + PlayerMoveAction.ARRIVE_EPSILON
                        + " 格")
                .optional(
                    "allowFlying",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.FALSE,
                    "是否顺带开通创造飞行（默认 false）——虚空世界里要竖直移动时需要")
                .returns(
                    "{action, layer:\"L1\", semantics:\"walk\", mode, target[3], before[3], serverBefore[3], ticks, maxTicks, "
                        + "arrived, remaining, blocked, clientAfter[3], serverAfter[3], movedClientBlocks, "
                        + "movedServerBlocks, arrivedServer, serverRemaining, serverSyncWaitedMs, observed, "
                        + "notObservedReason?, pathNote, pose{pos,yaw,pitch,onGround,dimension}}；"
                        + " observed 只看服务端权威侧位移（客户端预测动了而服务端没动 = 被拽回，不算观察到）")
                .example("{\"to\":[70.5,13.0,64.5],\"maxTicks\":200,\"confirm\":true}")
                .example("{\"distance\":5,\"direction\":\"forward\",\"maxTicks\":100,\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlayerMoveAction());

        registry.register(
            ActionDescriptor.builder(PlayerLookAction.NAME, Tier.SCENE)
                .description(
                    "L1：经玩家转向路径改变朝向（含看向某个点/实体）。按原版鼠标输入的口径<b>分步</b>转动"
                        + "（每步 yaw/pitch 变化 + EntityClientPlayerMP.sendMotionUpdates() 发 C03/C05 朝向包），"
                        + "服务端在 processPlayer 里接收并写进权威玩家的 rotationYaw/Pitch。"
                        + "与 scene.player.pose（L0，直接写服务端朝向 + S08）互补而不互替（裁决 3）。"
                        + " 三种形态互斥必居其一：yaw（可配 pitch）/ lookAt / entityId。"
                        + " yaw：0=南/+Z、90=西/-X、180=北/-Z、270=东/+X；pitch：正=俯视、负=仰视（同 CameraSpec 口径）。")
                .optional("yaw", ActionDescriptor.TYPE_NUMBER, "绝对水平朝向（度）")
                .optional("pitch", ActionDescriptor.TYPE_NUMBER, "绝对俯仰角（度，钳到 -90..90）")
                .optional("lookAt", ActionDescriptor.TYPE_ARRAY, "看向世界坐标点 [x,y,z]（角度由眼睛→目标算出）")
                .optional("entityId", ActionDescriptor.TYPE_INT, "看向某个实体（眼睛→它的眼睛高度）")
                .optional(
                    "steps",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(1),
                    "分几步转到位（1..200）。1=一次到位（够用且最便宜）；要演示「真实转身」给 8..20")
                .returns(
                    "{action, layer:\"L1\", semantics:\"turn\", mode, target[2]{yaw,pitch}, before{pos,yaw,pitch,...}, "
                        + "after{...}, startYaw, startPitch, deltaYaw, deltaPitch, steps, achievedYawDelta, tolerance, "
                        + "serverSyncWaitedMs, observed, notObservedReason?, pathNote, pose{...}}")
                .example("{\"yaw\":90,\"pitch\":0,\"confirm\":true}")
                .example("{\"lookAt\":[70.5,13.5,64.5],\"steps\":10,\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlayerLookAction());

        registry.register(
            ActionDescriptor.builder(UseItemAction.NAME, Tier.SCENE)
                .description(
                    "L1：使用手持物品（右键使用）——玩家按右键用手里东西的等价物。" + "目标分支由原版自己选：对空气用走 PlayerControllerMP.sendUseItem"
                        + "（C08 的 (-1,-1,-1,255) sentinel，服务端进 ItemInWorldManager.tryUseItem）；"
                        + "对方块用走 onPlayerRightClick（C08 带真实坐标与命中偏移，服务端进 activateBlockOrUseItem）。"
                        + " 本动作的 L1 义是「玩家用了一次手里的东西」，因此<b>观察对象是手持物品自身的变化</b>"
                        + "（count/耐久/NBT）；世界方块变化由 player.place_block 断言、方块/实体交互产物由 "
                        + "player.interact 断言——三者不是同一动作的别名（D1：自述必须与行为一致）。"
                        + " 手上没东西时如实报告 used:false（原版在 air 分支前有 itemstack1 != null 的门，"
                        + "空手对空气右键不产生任何包与效果），不静默照发一个假包。")
                .optional("mode", ActionDescriptor.TYPE_STRING, "air | block；缺省按视线自动选（命中方块即 block）")
                .optional(
                    "reach",
                    ActionDescriptor.TYPE_NUMBER,
                    Double.valueOf(PlayerSession.SERVER_REACH),
                    "视线求交距离（格，(0,64]）；须与服务端 ItemInWorldManager.getBlockReachDistance() 口径相容"
                        + "（服务端判定用 reach+1，默认 5.0+1=6.0）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"use-item\", mode, branch, target{block?,side?}, sight{...}, "
                        + "before{currentItem,main,cursor}, after{...}, used, stackChange{before,after,countDelta,"
                        + "damageDelta,changed}, useState{before,after,changed,scope}, serverSyncWaitedMs, "
                        + "observed, notObservedReason?, handEmpty?, pathNote, pose{...}}")
                .example("{\"mode\":\"air\",\"confirm\":true}")
                .example("{\"mode\":\"block\",\"confirm\":true}")
                .since("1.5")
                .build(),
            new UseItemAction());

        registry.register(
            ActionDescriptor.builder(PlayerInteractAction.NAME, Tier.SCENE)
                .description(
                    "L1：右键交互——对方块或实体。方块分支走 PlayerControllerMP.onPlayerRightClick"
                        + "（C08 → 服务端 activateBlockOrUseItem：onItemUseFirst → onBlockActivated → "
                        + "tryPlaceItemIntoWorld）；实体分支走 interactWithEntitySendPacket"
                        + "（C02PacketUseEntity(INTERACT) → 服务端 processUseEntity 的 INTERACT 分支）。"
                        + " 与 player.use_item 共用原版出口但<b>断言不同</b>：本动作的观察量是交互产物——"
                        + "容器被打开（openContainer 的 windowId/类名变化）、方块被激活（onBlockActivated 返回 true）、"
                        + "实体被移除或背包总数变化。对着掉落物右键会经 EntityItem.interactFirst 把它捡起，"
                        + "那是「右键拿起」，与 player.pickup（走过去碰到）是同一件事的两条玩家入口，结论不互替。"
                        + " auto 形态按原版分支顺序：命中实体优先（同 Minecraft.func_147121_ag）。")
                .optional("target", ActionDescriptor.TYPE_STRING, "auto", "auto | block | entity（默认 auto 按视线判）")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "被右键的方块 [x,y,z]（不给则用真实视线命中）")
                .optional(
                    "reach",
                    ActionDescriptor.TYPE_NUMBER,
                    Double.valueOf(PlayerSession.SERVER_REACH),
                    "视线求交距离（格，(0,64]）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"interact-block\"|\"interact-entity\", target, at?, side?, "
                        + "before/after（方块分支，逐格读数）, activated, blockChanged, blockWasContainer, "
                        + "containerOpened, container{windowIdBefore,windowIdAfter,classBefore,classAfter}, "
                        + "entity/entityAfter（实体分支）, handled, removed, inventoryCountBefore/After, "
                        + "serverSyncWaitedMs, observed, notObservedReason?, sight{...}, pathNote, pose{...}}")
                .example("{\"at\":[65,12,64],\"confirm\":true}")
                .example("{\"target\":\"auto\",\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlayerInteractAction());

        registry.register(
            ActionDescriptor.builder(PlayerDigAction.NAME, Tier.SCENE)
                .description(
                    "L1：左键破坏——攻击与挖掘同一条玩家路径（原版鼠标左键的三条路各自走原版自己的方法）。"
                        + " 实体：（PlayerControllerMP.attackEntity，C02(ATTACK) → 服务端 processUseEntity 的 ATTACK 分支"
                        + "跑权威攻击）。方块：（PlayerControllerMP.clickBlock，C07(0) → 服务端 "
                        + "ItemInWorldManager.onBlockClicked——创造模式当场破坏，生存模式开始累计进度；"
                        + "holdTicks>1 时在后续 tick 调 onPlayerDamageBlock，即原版 Minecraft.func_147115_a 按住左键时"
                        + "每 tick 调的同一个方法，累计够了它会自己发 C07(2) 并跑 onPlayerDestroyBlock）。"
                        + " 「挖不动基岩」是正确行为不是失败：基岩的可破坏度 <0，服务端永远不满足完成条件，"
                        + "本动作返回 observed:false + blockUnbreakable:true + 未变化的逐格回读，"
                        + "进程不受影响（#96 §3 探索模式纪律）。"
                        + " 视线未命中时如实报告 miss:true（原版在 func_147116_af 里对此只置 leftClickCounter，"
                        + "不发包也不产生效果），不静默照发一个 C07。")
                .optional("target", ActionDescriptor.TYPE_STRING, "auto", "auto | block | entity（默认 auto 按视线判）")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "要挖的方块 [x,y,z]（不给则用真实视线命中）")
                .optional(
                    "holdTicks",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(PlayerDigAction.DEFAULT_HOLD_TICKS),
                    "按住左键的 tick 数（1..1200）；生存模式挖硬方块要加大")
                .optional(
                    "reach",
                    ActionDescriptor.TYPE_NUMBER,
                    Double.valueOf(PlayerSession.SERVER_REACH),
                    "视线求交距离（格，(0,64]）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"dig-block\"|\"dig-entity\", target, at?, side?, before/after（逐格）, "
                        + "destroyed, blockUnbreakable, relativeHardness, blockHardness, hardnessScope, distanceSquared, serverReachLimitSquared, "
                        + "inServerReach, gameMode{gameType,isCreative}, heldBefore/heldAfter/heldChange, "
                        + "victim/after/healthBefore/healthAfter/removed（实体分支）, hit?, miss?, "
                        + "serverSyncWaitedMs, observed, notObservedReason?, sight{...}, pathNote, pose{...}}")
                .example("{\"at\":[65,12,64],\"holdTicks\":1,\"confirm\":true}")
                .example("{\"at\":[65,12,64],\"holdTicks\":120,\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlayerDigAction());

        registry.register(
            ActionDescriptor.builder(PlaceBlockAction.NAME, Tier.SCENE)
                .description(
                    "L1：放置方块——玩家手持方块对着某面右键。走 PlayerControllerMP.onPlayerRightClick"
                        + "（C08PacketPlayerBlockPlacement → 服务端 processPlayerBlockPlacement 的 else 分支 "
                        + "→ ItemInWorldManager.activateBlockOrUseItem → ItemBlock.tryPlaceItemIntoWorld）；"
                        + "客户端本地预测与服务端权威放置两遍都由原版产生（含 canPlaceBlockAt、Forge 事件、"
                        + "创造模式不扣物品的原版分支），本动作一处都不复制。"
                        + " at 是<b>被右键的那个方块</b>（不是新方块的位置），side 是命中面；"
                        + "新方块出现在 at 沿 side 偏移一格处（原版规则：side 1=顶面 ⇒ (x,y+1,z)）。"
                        + " 不给 at 时用玩家脚下那一格的顶面（站着往脚下放）。"
                        + " 手上不是方块物品时 CP-STATE-001（放置的前提就是手持一个方块）。")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "被右键的方块 [x,y,z]（不给则用玩家脚下那一格的地板顶面）")
                .optional(
                    "side",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(1),
                    "命中的面：0=下 1=上 2=北 3=南 4=西 5=东（默认 1=顶面）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"place-block\", at[3], side, target[3]（新方块位置）, "
                        + "atBefore/atAfter, before/after（目标格逐格读数）, placed, blockAppeared, "
                        + "distanceSquared, serverReachLimitSquared, inServerReach, heldItemId, "
                        + "heldBefore/heldAfter/heldChange, heldCountBefore/After, gameMode{isCreative}, "
                        + "serverSyncWaitedMs, observed, notObservedReason?, pathNote, pose{...}}")
                .example("{\"confirm\":true}")
                .example("{\"at\":[64,12,64],\"side\":1,\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlaceBlockAction());

        registry.register(
            ActionDescriptor.builder(PlayerPickupAction.NAME, Tier.SCENE)
                .description(
                    "L1：拾取掉落物——「拿到物品」之 L1 义（裁决 4）。世界里已有掉落物实体，玩家" + "<b>走过去碰它</b>，由服务端 EntityItem.onCollideWithPlayer → "
                        + "EntityPlayer.inventory.addItemStackToInventory 收进背包。"
                        + " 本动作不调用 addItemStackToInventory、不直接改背包——那会把它降级成 L0。"
                        + " 它与 L0 的「给」（scene.inventory.write，layer:\"L0\" semantics:\"give\"，直接写槽位）"
                        + "是同一件事的两义，两义都做、按层标注，<b>结论不互替</b>（#96 §4.2）："
                        + "scene.inventory.write 的写入不是「捡起来了」的证据。"
                        + " 构造输入的方式：先 scene.entity.spawn {item:\"minecraft:stone\",count:1,pos:[…]}（L0 布景）"
                        + "造掉落物，再调本动作拾取——这正是「L0 构造输入、L1 验证行为」的用法（#96 §4.2）。"
                        + " approach:false 时只等不走（用于玩家已被 L0 摆到掉落物旁边的场景）。"
                        + " 没捡到时返回 observed:false + notObservedReason（拾取延迟未归零 / 背包满 / 走不过去 / 掉落物已消失）。")
                .optional("entityId", ActionDescriptor.TYPE_INT, "目标掉落物的实体 id（scene.entity.spawn 的返回值里有）；与 item 二选一")
                .optional("item", ActionDescriptor.TYPE_STRING, "按物品注册名找掉落物（如 minecraft:stone）；可配 meta")
                .optional("meta", ActionDescriptor.TYPE_INT, "与 item 搭配：只匹配该 meta（不给即不限）")
                .optional("approach", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "是否走过去（默认 true）；false 只等不走")
                .optional(
                    "maxTicks",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(PlayerPickupAction.DEFAULT_MAX_TICKS),
                    "最多等待/推进的 tick 数（1..12000）；掉落物有 delayBeforeCanPickup（原版扔出时 40 tick）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"pickup\", entityId, itemId, meta, stackCount, "
                        + "poseBefore/poseAfter, ticks, maxTicks, approach, inventoryCountBefore/After, inventoryDelta, "
                        + "itemEntityGone, picked（与 observed 同源：最终观察到拾取）, observed, inventoryBefore/inventoryAfter（逐槽非空读数）, "
                        + "remainingItemEntities, delayBeforeCanPickup?, notObservedReason?, layerNote, pathNote, pose{...}}")
                .example("{\"entityId\":123,\"confirm\":true}")
                .example("{\"item\":\"minecraft:stone\",\"meta\":0,\"maxTicks\":120,\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlayerPickupAction());

        registry.register(
            ActionDescriptor.builder(SlotClickAction.NAME, Tier.SCENE)
                .description(
                    "L1：容器与背包槽位收放——开着的那个界面里逐槽移动物品。走原版玩家的唯一出口 "
                        + "PlayerControllerMP.windowClick → 客户端本地 Container.slotClick + "
                        + "C0EPacketClickWindow；服务端在 NetHandlerPlayServer.processClickWindow 跑权威 "
                        + "Container.slotClick 并回 S2FPacketSetSlot/S32PacketConfirmTransaction。"
                        + " <b>含移位点击</b>：shift:true（等价 clickType:1）即快速移动，整摞转移到对侧容器、不经光标。"
                        + " clickType 取值（原版 Container.slotClick 的 mode）：0=pick 左键整摞交换、1=shift 快速移动、"
                        + "2=swap 数字键交换（button 0..8）、3=clone 创造模式复制、4=throw 丢弃（button 0/1）、"
                        + "5=drag 拖拽分发、6=pickup-all 双击合堆。"
                        + " slot 是<b>当前 openContainer 的界面槽号</b>（Container 的 slotNumber，即包里的那个），"
                        + "不是 InventoryPlayer 下标——两者不同（ContainerPlayer 含合成格且顺序错位、"
                        + "ContainerChest 前 27 格是箱子后 36 格是玩家背包）。用 player.gui {gui:\"open\"} 或 "
                        + "read.inventory 核对槽位语义；-999 是原版「容器外」的合法槽号。"
                        + " **作用对象是当前 openContainer（它永远不是 null：原版在玩家构造时就把它设成 inventoryContainer，即玩家自己的背包容器）。**"
                        + " 因此「没开容器」在原版里不存在——没开箱子时本动作就作用在玩家背包容器（ContainerPlayer）上。"
                        + " 返回值用 containerClass / windowId / slotMeaning / containerIsPlayerInventory 如实说清打在哪个容器上。")
                .optional(
                    "clicks",
                    ActionDescriptor.TYPE_ARRAY,
                    "点击步骤数组 [{slot,clickType?,button?,shift?}]，按序执行；条目内默认值："
                        + "clickType=0（给 shift:true 则为 1）、button=0、shift=false")
                .optional("click", ActionDescriptor.TYPE_OBJECT, "单个点击步骤（与 clicks 可同时给，追加在后）")
                .optional("slot", ActionDescriptor.TYPE_INT, "顶层简写：等价于 clicks:[{slot}]（一次左键点击）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"slot-move\", windowId, containerClass, slotCount, slotMeaning, "
                        + "containerIsPlayerInventory, clickCount, clicks[{slot,clickType,button,shift,slotKind,slotInventory,predicted,slotAfter,"
                        + "cursorAfter}], before/after{slots[{slot,id,meta,count,…}],slotCount,windowId}, "
                        + "cursor{before,after,changed}, slotsChanged, serverSyncWaitedMs, observed, notObservedReason?, pathNote, pose{...}}")
                .example("{\"clicks\":[{\"slot\":0,\"shift\":true}],\"confirm\":true}")
                .example("{\"clicks\":[{\"slot\":0,\"clickType\":0},{\"slot\":27,\"clickType\":0}],\"confirm\":true}")
                .since("1.5")
                .build(),
            new SlotClickAction());

        registry.register(
            ActionDescriptor.builder(PlayerGuiAction.NAME, Tier.SCENE)
                .description(
                    "L1：开关玩家界面（背包与机器 GUI）。 gui:inventory 复刻原版 Minecraft.runTick 的 "
                        + "keyBindInventory 分支（C16PacketClientStatus(OPEN_INVENTORY_ACHIEVEMENT) + "
                        + "displayGuiScreen(new GuiInventory(thePlayer))，界面根部把 openContainer 设成它的 inventorySlots）；"
                        + "**注意：创造模式下原版打开的是 GuiContainerCreative 而不是 GuiInventory**（实机实测），"
                        + "因此 observed 接受两者，返回值用 creatorModeInventory 如实给出是哪一个；"
                        + " gui:container 复用 player.interact 的方块右键路径（服务端 openGui → S2DPacketOpenWindow → "
                        + "客户端 displayGuiScreen），因此模组机器界面（GT/AE2…）同样可用，本动作不需要认识任何具体模组；"
                        + " gui:close 走 EntityClientPlayerMP.closeScreen()（C0DPacketCloseWindow + 关界面，原版 ESC 的处理）；"
                        + " gui:open 是只读报告（不改变任何状态），给出当前 screenClass 与 openContainer 的类名/槽数/槽位语义。"
                        + " GuiContainer.doesGuiPauseGame() 为 false，因此界面开着时集成服照常 tick，"
                        + "player.slot_click 可以继续工作。"
                        + " <b>范围外</b>（裁决 3）：GUI 内非槽位按钮点击（机器模式按钮、JEI 面板等）不在本动作内；"
                        + "若 F2 教程样本实际需要，当场切独立单子，不混入。")
                .optional(
                    "gui",
                    ActionDescriptor.TYPE_STRING,
                    "inventory | container | close | open（运行期必填；缺失报 CP-VALID-002）")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "gui:container 时必填：容器/机器方块坐标 [x,y,z]")
                .optional(
                    "reach",
                    ActionDescriptor.TYPE_NUMBER,
                    Double.valueOf(PlayerSession.SERVER_REACH),
                    "gui:container 的视线求交距离（格，(0,64]）")
                .returns(
                    "{action, layer:\"L1\", semantics:\"gui-*\", gui, actionTaken, screenBefore/screenAfter/screenClass, "
                        + "guiClass, guiIsContainer, guiPausesGame, creatorModeInventory, windowIdBefore/After, containerClassBefore/After, "
                        + "slotCount, slotMeaning, observed, notObservedReason?, interact?（gui:container 时嵌 player.interact 的结果）, "
                        + "pathNote, pose{...}}")
                .example("{\"gui\":\"inventory\",\"confirm\":true}")
                .example("{\"gui\":\"container\",\"at\":[65,12,64],\"confirm\":true}")
                .example("{\"gui\":\"close\",\"confirm\":true}")
                .since("1.5")
                .build(),
            new PlayerGuiAction());
    }

    /**
     * 观察面读面动作（issue #98，{@code client/controlplane/mc/read/}）：全部 {@link Tier#OBSERVE}。
     *
     * <h2>为什么全部是同步动作</h2>
     * 读面要求在<b>一次 tick 内</b>读完并返回：跨 tick 的读面会读到两个不同的世界状态
     * （中间别的动作改了世界），「调用前后世界哈希不变」（B1）就无从判定。八个动作都不做
     * 文件等待、不排队、不重试，故注册为同步。唯一例外是 {@code read.diff} 的
     * {@code expectManifestFile} 路径要读一次磁盘——那次读也在同一 tick 内完成。
     *
     * <h2>自描述纪律</h2>
     * 「没有自描述的动作视为不存在」（需求书 §8.1）：因此这八个的 {@code description}/
     * 逐参数 {@code description}/{@code returns}/{@code example}/{@code since} 一律写全，
     * 且默认值以 {@code default} 字段机读可见（D3）。
     *
     * <p>
     * 命名取 {@code read.*}：与既有的 {@code world.info}（世界身份）、{@code shot.multi}（视觉）
     * 分开——读面是「结构化读数」这一族，将来还会有同族动作，前缀即分组。
     */
    private static void registerReadActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder(ReadBlocksAction.NAME, Tier.OBSERVE)
                .description(
                    "区域方块读回：读闭区间区域内每一格的 {pos, id, blockId, meta, te}，"
                        + "并给出与 world.rebuild 场景清单同口径的规范化 sha256。只读，调用前后世界不变。"
                        + " from/to 运行期必填（缺失报 CP-VALID-002，context.fields 逐字段）——"
                        + "自描述不标 required，理由同 world.rebuild：让「服务端的参数校验」在负测试里可观测，"
                        + "而不是一律被调用方按自述提前拦掉；region 与 from/to 二选一，同给且不一致报 CP-VALID-002。")
                .optional("from", ActionDescriptor.TYPE_ARRAY, "区域起点 [x,y,z]（闭区间，含）；运行期必填，缺失报 CP-VALID-002")
                .optional("to", ActionDescriptor.TYPE_ARRAY, "区域终点 [x,y,z]（闭区间，含，须逐轴 ≥ from）；运行期必填，缺失报 CP-VALID-002")
                .optional(
                    "region",
                    ActionDescriptor.TYPE_OBJECT,
                    "等价写法 {from:[x,y,z], to:[x,y,z]}；与 from/to 二选一，同给且不一致报 CP-VALID-002")
                .optional(
                    "includeAir",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.TRUE,
                    "blocks 数组是否包含空气（blockId=0）；默认 true。注意：sha256 恒按含空气的完整区域算，不受本参数影响")
                .optional("hash", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "是否计算 sha256 与 hashInput；默认 true")
                .returns(
                    "{schema, action, region{from,to,volume}, volume, blockCount, airCount, airSkipped, includeAir, "
                        + "ordering, blocks[{pos,blockId,meta,id,te}], sha256, hashScope, "
                        + "hashInput{blocks:[{pos,blockId,meta}]}, readAt}；"
                        + "airCount = 区域里的空气块数（与 includeAir 无关）；airSkipped = 因 includeAir=false 被过滤掉的块数")
                .example("{\"from\":[64,11,64],\"to\":[70,14,70]}")
                .example("{\"region\":{\"from\":[64,12,64],\"to\":[64,12,64]},\"includeAir\":false}")
                .since("1.3")
                .build(),
            new ReadBlocksAction());

        registry.register(
            ActionDescriptor.builder(ReadOverviewAction.NAME, Tier.OBSERVE)
                .description("世界概览（服务端权威世界）：维度/时间/天气/已加载区块数/实体与方块实体计数（按类型分组）、" + "玩家清单，并附 world.info 同一份世界身份字段。只读。")
                .optional("entities", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "是否统计实体与方块实体（关掉可省一次全表遍历）")
                .optional(
                    "topEntityTypes",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(10),
                    "按类型分组返回前 N 名（降序，同数按键名升序）；0 表示不分类型")
                .optional(
                    "chunkRange",
                    ActionDescriptor.TYPE_ARRAY,
                    "[minX,maxX,minZ,maxZ] 区块坐标（闭区间）——显式给出时才逐块列举已加载区块。"
                        + "注意 provideChunk 对未加载区块会触发加载（读盘），故不做默认行为；区块数上限 4096")
                .returns(
                    "{schema, action, world{...（同 world.info）}, time{worldTime,totalWorldTime,day,timeOfDay}, "
                        + "weather{raining,thundering,rainStrength,thunderStrength,rainTime?,thunderTime?,rainingScheduled?,thunderingScheduled?}, "
                        + "chunks{loaded,source,listed,chunkRange?,chunkRangeNote?,chunks[]}, "
                        + "entities{count,typeCount,byType[{type,count}],truncatedTypes,source}, "
                        + "tileEntities{count,typeCount,byType,truncatedTypes,source}, "
                        + "players{count,names[]}, chunkProvider{class,serverWorldAvailable}, readAt}")
                .example("{}")
                .example("{\"entities\":false}")
                .since("1.3")
                .build(),
            new ReadOverviewAction());

        registry.register(
            ActionDescriptor.builder(ReadPlayerAction.NAME, Tier.OBSERVE)
                .description(
                    "玩家状态（服务端 EntityPlayerMP 权威侧）：位置（服务端与客户端各一份）、朝向与视线、生命/护甲/"
                        + "吸收/燃烧/氧气、饥饿、游戏模式与能力、经验、药水效果、手持与光标物品。只读。")
                .returns(
                    "{schema, action, name, uuid?, entityId, dimension, source, "
                        + "pos{server[3],eye[3],client?[3],clientName?}, "
                        + "rotation{yaw,pitch,headYaw,facing,look[3]}, "
                        + "health{health,maxHealth,absorption,armor,dead,alive,onGround,fallDistance,burning,wet,inWater,air,maxAir}, "
                        + "food{foodLevel,saturationLevel,needsFood}?, gameMode{gameType,gameTypeId,isCreative,isAdventure,"
                        + "allowFlying,isFlying,isCreativeMode,disableDamage,walkSpeed}, "
                        + "experience{level,total,progress}, effects[{id,name,amplifier,duration,ambient}], "
                        + "held{slot,main{...},cursor{item{...}}}, ping, readAt}")
                .example("{}")
                .since("1.3")
                .build(),
            new ReadPlayerAction());

        registry.register(
            ActionDescriptor.builder(ReadInventoryAction.NAME, Tier.OBSERVE)
                .description(
                    "背包与容器逐槽读回。source=player 读服务端玩家背包（主背包 36 + 护甲 4）；"
                        + "source=tile 读 at 处方块实体实现的 IInventory；source=ender 读玩家末影箱。只读。"
                        + "容器不存在报 CP-STATE-001（空容器与不存在的容器不是一回事，不返回空槽表）。")
                .optional(
                    "source",
                    ActionDescriptor.TYPE_STRING,
                    ReadInventoryAction.SOURCE_PLAYER,
                    "player | tile | ender")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "source=tile 时必填：容器坐标 [x,y,z]（也接受 {pos:[x,y,z]}）")
                .optional("includeEmpty", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "是否含空槽；false 只回非空槽（槽号仍是原编号，不留索引错觉）")
                .optional("nbtMaxEntries", ActionDescriptor.TYPE_INT, Integer.valueOf(24), "逐槽 NBT 摘要的成员数上限（正整数）")
                .returns(
                    "{schema, action, source, inventory?{size,mainSize,armorSize,currentItem,heldSlot,slotMeaning,slots[],cursor{item}}, "
                        + "container?{at,teClass,size,name,customName,stackLimit,slotMeaning,slots[]}, name?, owner?, readAt}；"
                        + "每槽 {slot,empty,id?,meta?,count?,maxStackSize?,damage?,maxDamage?,displayName?,nbt?}")
                .example("{\"source\":\"player\"}")
                .example("{\"source\":\"tile\",\"at\":[65,12,64]}")
                .since("1.3")
                .build(),
            new ReadInventoryAction());

        registry.register(
            ActionDescriptor.builder(ReadTeAction.NAME, Tier.OBSERVE)
                .description(
                    "方块实体状态：逐位置给「通用 TE 事实」（类名/是否在位/NBT 摘要）+「逐族描述器输出」"
                        + "（与 te-state-equals 判据、观测记录 runtimeReads 同一个读取口，不另起一套）。只读。"
                        + "已注册族与缺席族（模组未装）分别在 familiesRegistered / absentFamilies 里如实给出。")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "位置 [x,y,z] 或位置清单 [[x,y,z],…]；与 from/to 三选一")
                .optional("from", ActionDescriptor.TYPE_ARRAY, "区域普查起点 [x,y,z]（体积 ≤ 4096）")
                .optional("to", ActionDescriptor.TYPE_ARRAY, "区域普查终点 [x,y,z]")
                .optional(
                    "includeNbt",
                    ActionDescriptor.TYPE_BOOL,
                    Boolean.TRUE,
                    "是否读 TE 的 NBT 摘要（writeToNBT 的受限摘要；仅供留痕，判据该断言族状态）")
                .returns(
                    "{schema, action, count, familiesRegistered[], absentFamilies{族:缺席原因}, "
                        + "tiles[{pos, tile{present,blockId,meta,class?,superclass?,blockMetadata?,nbt?}, "
                        + "claimedFamily, claimedState, families[{family,state,sha256?,note?}]}], pointerHint, readAt}")
                .example("{\"at\":[65,12,64]}")
                .example("{\"at\":[[65,12,64],[66,12,64]],\"includeNbt\":false}")
                .since("1.3")
                .build(),
            new ReadTeAction());

        registry.register(
            ActionDescriptor.builder(ReadBlockInfoAction.NAME, Tier.OBSERVE)
                .description(
                    "方块与物品信息（注册名/渲染类型/是否 TESR/是否 ISBRH/所需工具与等级/材质/硬度抗爆/掉落物）。"
                        + "三选一：at 读世界里那一格（含 TESR 判定，问的是渲染器自己的注册表）；"
                        + "block 按注册名问方块表；item 按注册名问物品表。只读。")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "世界里的一格 [x,y,z]（读该格的方块与其实例的渲染信息）")
                .optional("block", ActionDescriptor.TYPE_STRING, "方块注册名 modid:name（裸名按 minecraft: 处理）")
                .optional("item", ActionDescriptor.TYPE_STRING, "物品注册名 modid:name")
                .optional(
                    "meta",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(0),
                    "item/block 查询时使用的 meta（影响 unlocalizedName/工具类/放置物）")
                .returns(
                    "{schema, action, queryKind, block?{at?,id,blockId,meta,air,class,unlocalizedName,localizedName,"
                        + "render{renderType,renderTypeName,renderTypeNameScope,isNormalCube,isOpaqueCube,renderBlockPass,"
                        + "isFullBlock,lightValue,hasTileEntity,tickRandomly,tileEntity{available,present,class?,"
                        + "hasSpecialRenderer,rendererClass?,rendererSource?},isTesr,isIsbrh,isIsbrhScope}, "
                        + "harvest{tool,level}, material{name,liquid,solid,opaque,blocksGrass,toolNotRequired}, "
                        + "hardness,resistance,slipperiness,lightOpacity,stepSound, drops{itemDroppedId,itemDropped,"
                        + "quantityDropped,scope}}, item?{id,queriedId,meta,class,unlocalizedName,maxStackSize,maxDamage,"
                        + "damageable,repairable,hasSubtypes,enchanted,toolClasses[],displayName,asBlockPlaced?}, readAt}")
                .example("{\"at\":[65,12,64]}")
                .example("{\"block\":\"minecraft:chest\"}")
                .example("{\"item\":\"minecraft:diamond_pickaxe\"}")
                .since("1.3")
                .build(),
            new ReadBlockInfoAction());

        registry.register(
            ActionDescriptor.builder(ReadDiffAction.NAME, Tier.OBSERVE)
                .description(
                    "状态差异：期望态（内联清单 / 场景清单对象 / 存档内最新场景清单）与服务端世界实读逐格 diff，"
                        + "逐格给出 kinds[blockId|meta] 与两侧读数，并给双侧规范化 sha256。只读（不开可写段）。"
                        + "expectManifestFile 路径会开 run 目录并把结果落 read/diff.json 登记进清单（产物显式）。")
                .optional(
                    "expectInline",
                    ActionDescriptor.TYPE_ARRAY,
                    "内联期望 [{at:[x,y,z],id:\"minecraft:stone\",meta:0},…]（与 build 段的 block 步同形）")
                .optional("expectManifest", ActionDescriptor.TYPE_OBJECT, "场景清单对象（与 world/scene-manifest.json 同形）")
                .optional(
                    "expectManifestFile",
                    ActionDescriptor.TYPE_STRING,
                    "托管世界目录名（cp_ 前缀）：读 saves/<folder>/scene-manifest.json")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "只比这一格 [x,y,z]（给出时忽略其余位置）")
                .optional(
                    "maxChanges",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(4096),
                    "changes 数组的输出上限（超出记 truncatedChanges，不静默截断）")
                .returns(
                    "{schema, action, expectSource, checked, same, different, truncatedChanges, maxChanges, "
                        + "changes[{pos,kinds[blockId|meta],expect,actual}], "
                        + "hashes{actual,expected,equal,scope}, scope, resultPath?, resultSha256?, resultBytes?, readAt}")
                .example(
                    "{\"expectInline\":[{\"at\":[65,12,64],\"id\":\"minecraft:stone\",\"meta\":0}],\"expectManifestFile\":\"cp_demo\"}")
                .example("{\"expectManifestFile\":\"cp_demo\"}")
                .since("1.3")
                .build(),
            new ReadDiffAction());

        registry.register(
            ActionDescriptor.builder(ReadRunAction.NAME, Tier.OBSERVE)
                .description(
                    "run 产物清单读回：枚举 run 目录并逐 run 实读磁盘 manifest.json，给出产物 path/bytes/sha256/role、"
                        + "磁盘存在性与大小一致性（missingFiles/sizeMismatch），并单独归组 shots/ 下的截图产物"
                        + "（用于确认 shot.multi 等取证动作的产物确实进了 run 清单）。只读，不下载产物内容。")
                .optional(
                    "limit",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(ReadRunAction.DEFAULT_LIMIT),
                    "返回的 run 条数上限（最新的在前）")
                .optional("runId", ActionDescriptor.TYPE_STRING, "只读这一个 run（给出时忽略 limit）")
                .optional(
                    "role",
                    ActionDescriptor.TYPE_STRING,
                    "只保留该 role 的产物（如 shot / shot-meta / read-diff）；不影响 run 是否入选")
                .optional("caseId", ActionDescriptor.TYPE_STRING, "只保留该 caseId 的 run")
                .returns(
                    "{schema, action, runsRoot, count, visited, available, limit, artifactCount, note, "
                        + "runs[{runId,caseId,jobSeq,createdAt,dir,manifestPresent,artifacts[{path,bytes,sha256,role,"
                        + "exists,diskBytes?,diskMismatch?}],artifactCount,missingFiles,sizeMismatch,"
                        + "shotArtifacts[{path,role,sha256,bytes}],shotArtifactCount}], readAt}")
                .example("{}")
                .example("{\"role\":\"shot\",\"limit\":5}")
                .since("1.3")
                .build(),
            new ReadRunAction());
    }

    /**
     * L0 布景原语（#99，contract.md §4.4）：实体 / 玩家状态 / 背包 / 天气时间 / 位置朝向 / 流体注入。
     *
     * <p>
     * 七个动作全是 {@link Tier#SCENE} 同步动作——它们只在服务端权威世界上做一次性的字段写入
     * （无跨 tick 等待、无世界装卸），因此不按步进注册。<b>层归属</b>按 #96 §4.1：本组是
     * <b>L0</b>——直接设定状态、用于布景与构造输入；L0 的产物不能当作 L1（玩家操作）的证据
     * （#96 §4.2）。带「拿到物品」语义的 {@code scene.inventory.write} 与 #101 的 L1「拾取」
     * 是两义、两义都做、按层标注（裁决 4）；{@code scene.player.pose} 与 #101 的 L1 真实移动同理（裁决 3）。
     * {@code scene.tank.fill}（#122）补的是同一族的<b>流体</b>一侧：背包写入碰不到 {@code IFluidHandler}。
     *
     * <p>
     * 共同口径（写在每个动作的类注释里，这里只列索引）：
     * <ul>
     * <li><b>只写服务端权威世界</b>（{@code MinecraftServer.worldServers[0]}）——客户端
     * {@code WorldClient} 是只读投影，写它会被原版同步覆写（见 {@code mc.scene.L0Session}）；</li>
     * <li><b>同步一律走原版出口</b>（S2B/S06/S1F/S1D/S08/S2F…），不自造同步、不静态回填（契约 §6.4）；</li>
     * <li><b>写入门控</b>：捕获会话期间被别的作业调用即 {@code CP-STATE-001}（契约 §4.2，既有口径）；</li>
     * <li><b>返回值自带读回</b>：{@code before}/{@code after} 或逐项 {@code readBack}，外加
     * {@code sceneReadback}（按世界内最新场景清单的位置集合实读回读的规范化哈希）。
     * 读面（#98）未落地时，调用方据此自证「这次写观察到了什么变化」。</li>
     * </ul>
     */
    private static void registerSceneActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder("scene.entity.spawn", Tier.SCENE)
                .description(
                    "L0：在托管世界生成实体（含掉落物）。只作用于服务端权威世界，随后经原版实体跟踪器同步给客户端。" + "掉落物给 item（物品注册名）而不是 entity；一般实体给 entity。"
                        + "entity 与 item 互斥且必须给一个。"
                        + "实体名口径（1.7.10 实测）：EntityList 的原生键不带 minecraft: 前缀（Zombie / Item / XPOrb；"
                        + "FML 模组实体是 <modId>.<name>）。现代写法 minecraft:zombie 也接受——解析会规范化后匹配，"
                        + "查不到时错误上下文里带已注册名样本。"
                        + "层归属：本动作是布景原语（构造「拾取」的输入），不是「玩家扔出了物品」的证据"
                        + "——拾取属 L1（#101），两层结论不互替。")
                .optional(
                    "entities",
                    ActionDescriptor.TYPE_ARRAY,
                    "实体条目数组 [entry]，逐条生成。entry={entity?|item?, pos?, meta?, count?, nbt?, yaw?, pitch?}；"
                        + "entity 与 item 互斥必居其一（item=掉落物简写）。条目内默认值："
                        + "meta=0、count=1（域 1..64）、yaw=0、pitch=0；pos 缺省用顶层 pos。"
                        + "nbt 为 SNBT 文本：掉落物按 /give 口径（Count/Damage/tag），实体按 /summon 口径（须含 id）")
                .optional("entity", ActionDescriptor.TYPE_OBJECT, "单个实体条目（与 entities 可同时给，追加在后）")
                .optional("pos", ActionDescriptor.TYPE_ARRAY, "默认坐标 [x,y,z]（条目自身没给 pos 时用；顶层与条目都没给 = CP-VALID-002）")
                .returns(
                    "{action, requested, spawnedCount, spawned[{ok,entityId,class,entityIdNum,pos,item?,nbtApplied}], "
                        + "failed[{index,error}], entityCounts[{key,count}], dimension, sceneReadback{present,sha256?,...}}")
                .example(
                    "{\"entities\":[{\"item\":\"minecraft:stone\",\"meta\":0,\"count\":3,\"pos\":[64.5,13,64.5]},"
                        + "{\"entity\":\"Zombie\",\"pos\":[66.5,13,64.5],\"yaw\":180}],\"confirm\":true}")
                .example(
                    "{\"entity\":{\"entity\":\"minecraft:pig\",\"pos\":[70.5,13,70.5],"
                        + "\"nbt\":\"{id:\\\"Pig\\\",CustomNameTag:test,NoAI:1b}\"},\"confirm\":true}")
                .since("1.3")
                .build(),
            new EntitySpawnAction());

        registry.register(
            ActionDescriptor.builder("scene.entity.clear", Tier.SCENE)
                .description(
                    "L0：清除托管世界范围内的实体（含掉落物）。选择条件 box/entity/item 可组合取交集，"
                        + "全不给即「除玩家外全清」。用原版 removeEntity（当场离场，不是打 setDead 标记）。"
                        + "includePlayers 默认 false：清掉自己会让无人值守流程卡在无玩家状态，必须是显式选择。"
                        + "注：这是轮内清场原语，不构成 hermetic 保证（不清方块/背包/天气）——验收类固定程序的"
                        + "起世界手段仍是 world.rebuild（case-file.md §8.8）。")
                .optional("box", ActionDescriptor.TYPE_ARRAY, "范围 [[minx,miny,minz],[maxx,maxy,maxz]]（按实体包围盒中心判定）")
                .optional(
                    "entity",
                    ActionDescriptor.TYPE_STRING,
                    "只清该 EntityList 注册名（1.7.10 原生键如 Item/Zombie；minecraft:item 也接受）")
                .optional("item", ActionDescriptor.TYPE_STRING, "只清掉落物里物品为该项的（与 entity 互斥）")
                .optional("meta", ActionDescriptor.TYPE_INT, "与 item 搭配：只清该 meta（不给即不限 meta）")
                .optional("includePlayers", ActionDescriptor.TYPE_BOOL, Boolean.FALSE, "是否连玩家一起清（默认 false）")
                .returns(
                    "{action, removedCount, removed[{entityId,class,entityIdNum,pos,item?,meta?,count?,removed}], "
                        + "selector{box,entity,item,meta,includePlayers}, remainingEntities, sceneReadback{...}}")
                .example("{\"box\":[[63,12,63],[72,20,72]],\"entity\":\"Item\",\"confirm\":true}")
                .example("{\"item\":\"minecraft:stone\",\"meta\":0,\"confirm\":true}")
                .since("1.3")
                .build(),
            new EntityClearAction());

        registry.register(
            ActionDescriptor.builder("scene.player.state", Tier.SCENE)
                .description(
                    "L0：设定服务端权威玩家的游戏模式 / 生命 / 经验 / 药水效果。只改服务端 EntityPlayerMP，"
                        + "然后走原版同步出口（S2BPacketChangeGameState(3) / S06PacketUpdateHealth / "
                        + "S1FPacketSetExperience / S1DPacketEntityEffect），不自造同步。"
                        + "生命下限 1.0（0 会触发死亡流程，无人值守会卡在死亡界面，故不提供）；"
                        + "上界钳到玩家自身 getMaxHealth()。返回值带 before/after 两份实读快照。")
                .optional("gameType", ActionDescriptor.TYPE_STRING, "survival | creative | adventure（或 0|1|2）")
                .optional("health", ActionDescriptor.TYPE_NUMBER, "生命值（≥1.0，自动钳到 maxHealth）")
                .optional("experienceLevel", ActionDescriptor.TYPE_INT, "经验等级（0..21863）")
                .optional("experienceTotal", ActionDescriptor.TYPE_INT, "经验总量（≥0）")
                .optional("experience", ActionDescriptor.TYPE_NUMBER, "经验条进度（[0,1)）")
                .optional(
                    "effects",
                    ActionDescriptor.TYPE_ARRAY,
                    "药水效果 [{id,duration,amplifier,ambient}]；条目内默认值：duration=600（tick，域 ≥1）、"
                        + "amplifier=0（域 0..255）、ambient=false。id 可为数字 id（上限 = 运行期 "
                        + "Potion.potionTypes 长度：原版 32、GTNH 实测 256），或效果名"
                        + "（稳定名为 Potion.getName()，如 potion.nightVision；night_vision / nightVision / "
                        + "minecraft:night_vision 都接受）。查不到时错误上下文里带已注册名样本（含 id）")
                .optional("clearExisting", ActionDescriptor.TYPE_BOOL, Boolean.FALSE, "先清空既有药水效果（默认 false）")
                .returns(
                    "{action, applied[{field,...readBack}], before{...}, after{...}, playerName, dimension, sceneReadback{...}}")
                .example(
                    "{\"gameType\":\"creative\",\"health\":20,\"experienceLevel\":30,\"experienceTotal\":1395,"
                        + "\"effects\":[{\"id\":\"night_vision\",\"duration\":6000,\"amplifier\":0}],\"confirm\":true}")
                .since("1.3")
                .build(),
            new PlayerStateAction());

        registry.register(
            ActionDescriptor.builder("scene.inventory.write", Tier.SCENE)
                .description(
                    "L0：逐槽写入玩家背包或世界里某容器。即「拿到物品」之「给」（裁决 4）：直接写 {id,meta,count,nbt}，"
                        + "用于布景与构造输入；另一义「拾取」属 L1（#101），两义都做、按层标注，结论不互替。"
                        + "target=player 用 InventoryPlayer 下标：0..8 快捷栏（0 是手持）、9..35 主背包、36..39 盔甲"
                        + "（36 靴/37 护腿/38 胸甲/39 头盔）——不是 ContainerPlayer 的界面槽号。"
                        + "target=container 用 at:[x,y,z] 指向的 IInventory 下标。id 给 air 即清空该槽。"
                        + "写入走 setInventorySlotContents + markDirty，并对玩家发一次 Container.detectAndSendChanges。"
                        + "条目另支持两种模组权威取物/充电写法（#117）：battery 给 GT 的 ItemList 常量名"
                        + "（如 Battery_RE_LV_Lithium，物品与 meta 由 GT 自己的清单决定，不硬编码数字），"
                        + "charge 给 \"full\"/\"empty\"/EU 整数并按物品自己的电力 API（IC2 IElectricItemManager）充放电"
                        + "——把满充 GT 电池写进机器充电槽即 #117 的供电布景。"
                        + "charge 与 nbt 互斥：充电状态必须经模组自身的电力 API 写入，手写 GT.ItemCharge 那种 NBT 键"
                        + "属于契约 §6.4 禁止的逐字段回填；charge 还要求 count=1（GT 的电力物品在 stackSize != 1 时拒绝充放）。"
                        + "条目另支持第三种模组权威写法（#122，配方输入）：material 给 GT 材料名"
                        + "（如 Silicon / HydrochloricAcid），prefix 给 GT 的形态名（OrePrefixes 字段名，如 dust / cell），"
                        + "物品与 meta 由 GT 自己的 ore dict 统一化路径产出——配方输入绝大多数是材料形态，"
                        + "而 ItemList 里没有 Silicon 这类常量，写 id+meta 就得自己算 meta 编码。"
                        + "material 与 id/battery 互斥，且与 meta 互斥。")
                .optional("target", ActionDescriptor.TYPE_STRING, "player", "player | container（默认 player）")
                .optional(
                    "at",
                    ActionDescriptor.TYPE_ARRAY,
                    "容器坐标 [x,y,z]（target=container 时必填；接受 GT 机器方块实体这类 IInventory）")
                .optional(
                    "slots",
                    ActionDescriptor.TYPE_ARRAY,
                    "槽位条目数组 [{slot,id,meta,count,nbt}] / [{slot,battery,charge}] / [{slot,material,prefix,count}]；"
                        + "slot 必填，条目内默认值：meta=0、count=1（域 1..64，清空请用 id=air；用 charge 时须为 1）、"
                        + "nbt 缺省即不带 NBT。battery 与 id 互斥；material 与 id/battery/meta 互斥且必配 prefix；"
                        + "charge 与 nbt 互斥")
                .optional("slot", ActionDescriptor.TYPE_OBJECT, "单个槽位条目（与 slots 可同时给，追加在后）")
                .returns(
                    "{action, layer:\"L0\", semantics:\"give\", layerNote, target{kind,player?|at?,teClass?,size,inventoryName}, "
                        + "writtenCount, written[{slot,requested,actual,matches}|{slot,cleared}], readBack[{slot,stack|empty}], "
                        + "sceneReadback{...}}；条目带 battery/charge 时 requested/actual 另含 "
                        + "chargeRequested/charge/maxCharge/electricTier（电池真的充上了没有，读回可见）")
                .example(
                    "{\"target\":\"player\",\"slots\":[{\"slot\":0,\"id\":\"minecraft:stone\",\"count\":64},"
                        + "{\"slot\":9,\"id\":\"minecraft:diamond_pickaxe\",\"meta\":0,\"count\":1},"
                        + "{\"slot\":10,\"id\":\"air\"}],\"confirm\":true}")
                .example(
                    "{\"target\":\"container\",\"at\":[65,12,65],\"slots\":[{\"slot\":0,\"id\":\"minecraft:torch\",\"count\":16}],"
                        + "\"confirm\":true}")
                .example(
                    "{\"target\":\"container\",\"at\":[65,12,65],\"slots\":[{\"slot\":1,"
                        + "\"battery\":\"Battery_RE_LV_Lithium\",\"charge\":\"full\"}],\"confirm\":true}")
                .example(
                    "{\"target\":\"container\",\"at\":[65,12,65],\"slots\":["
                        + "{\"slot\":5,\"material\":\"Silicon\",\"prefix\":\"dust\",\"count\":1},"
                        + "{\"slot\":6,\"material\":\"Empty\",\"prefix\":\"cell\",\"count\":2}],\"confirm\":true}")
                .since("1.3")
                .build(),
            new InventoryWriteAction());

        registry.register(
            ActionDescriptor.builder("scene.weather.time", Tier.SCENE)
                .description(
                    "L0：设定世界的权威时刻与天气（改世界状态本身，持续生效）。" + "与 shot.multi 的 worldTime 是两义：后者是「这一次拍摄的光照基准」，本动作改的是世界，"
                        + "会被 S03 广播给客户端并在后续任何读面/拍摄中可见。"
                        + "设天气时同时重置 rainTime/thunderTime（1.7.10 天气是倒计时驱动的，只设 raining 会在"
                        + "原倒计时到点时自己翻回去）；只写服务端，客户端由 S2BPacketChangeGameState(7/8) 渐入。")
                .optional("worldTime", ActionDescriptor.TYPE_STRING, "0..23999 tick，或别名 day|noon|sunset|night|midnight")
                .optional("weather", ActionDescriptor.TYPE_STRING, "clear | rain | thunder")
                .optional(
                    "duration",
                    ActionDescriptor.TYPE_INT,
                    Integer.valueOf(WeatherTimeAction.DEFAULT_DURATION_TICKS),
                    "天气持续时间（tick，默认 12000 = 10 分钟）")
                .optional("doDaylightCycle", ActionDescriptor.TYPE_BOOL, "是否让时间自然流逝（游戏规则，不传即不改）")
                .returns(
                    "{action, layer:\"L0\", semanticsNote, applied{worldTime?,weather?,duration?,raining?,thundering?,rainTime?,"
                        + "thunderTime?,doDaylightCycle?}, before{...}, after{...}, clientView{...}, sceneReadback{...}}")
                .example("{\"worldTime\":6000,\"weather\":\"clear\",\"duration\":24000,\"confirm\":true}")
                .example("{\"worldTime\":\"midnight\",\"weather\":\"thunder\",\"duration\":6000,\"confirm\":true}")
                .since("1.3")
                .build(),
            new WeatherTimeAction());

        registry.register(
            ActionDescriptor.builder("scene.player.pose", Tier.SCENE)
                .description(
                    "L0：瞬时设定玩家位置与朝向（布景原语，不产生位移过程）。" + "与 #101 的 L1 真实移动/转向互补而不互替（裁决 3）：要「玩家站在这里看那边」用本动作；"
                        + "要验证「走过去这件事本身」用 L1；L0 的产物不能当 L1 的证据。"
                        + "走原版传送出口 EntityPlayerMP.setPositionAndUpdate（S08PacketPlayerPosLook）——直接改 posX 会被"
                        + "客户端权威的位置包覆写回。yaw：0=南/+Z、90=西/-X、180=北/-Z、270=东/+X；"
                        + "pitch：正=俯视、负=仰视（与 shot.multi 的 CameraSpec 同口径）。"
                        + "allowFlying 默认 true：托管世界是全虚空，顺带开通创造飞行防坠亡。")
                .optional("pos", ActionDescriptor.TYPE_ARRAY, "目标坐标 [x,y,z]（可为小数）")
                .optional("yaw", ActionDescriptor.TYPE_NUMBER, "水平朝向（度）")
                .optional("pitch", ActionDescriptor.TYPE_NUMBER, "俯仰角（度，-90..90；正=俯视）")
                .optional("allowFlying", ActionDescriptor.TYPE_BOOL, Boolean.TRUE, "顺带开通创造飞行并清零坠落距离（默认 true）")
                .returns(
                    "{action, layer:\"L0\", semantics:\"teleport\", layerNote, before{pos,yaw,pitch}, "
                        + "after{pos,yaw,pitch,allowFlying,isFlying}, playerName, clientView{pos,yaw,pitch}, sceneReadback{...}}")
                .example("{\"pos\":[64.5,13,64.5],\"yaw\":180,\"pitch\":30,\"allowFlying\":true,\"confirm\":true}")
                .example("{\"yaw\":90,\"confirm\":true}")
                .since("1.3")
                .build(),
            new PlayerPoseAction());

        registry.register(
            ActionDescriptor.builder(TankFillAction.NAME, Tier.SCENE)
                .description(
                    "L0：向指定位置的机器/储罐注入流体（经 net.minecraftforge.fluids.IFluidHandler.fill，"
                        + "1.7.10 流体交互的标准入口，GT 的 BaseMetaTileEntity 自己实现它）。"
                        + "补的是「拿到物品」碰不到的那一半：scene.inventory.write 只碰 IInventory，"
                        + "而 GT 机器的流体口是内部储罐（MTEBasicTank.mFluid），槽位表里没有流体槽——"
                        + "三氯硅烷配方（Si dust + 2 Empty Cell + HCl 3000 mB）缺本动作时无法端到端跑通。"
                        + "走 fill 的额外好处是 GT 自己的门槛全部照常生效（机器是否已 tick 起、该面是否可注入、"
                        + "该流体是否被这台机器的配方表接受、容量与既有流体是否同种），本动作只如实报告它返回的数字。"
                        + "层归属：本动作是 L0 布景原语（semantics:\"fill\"），是「机器里有没有这个流体」的证据，"
                        + "不是「玩家/管道把流体运进来了」的证据（后者属 L1/L2，两层结论不互替）。"
                        + "读回走 read.te 的 tanks 字段（与 te-state-equals 判据同一棵树）。")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "目标坐标 [x,y,z]（机器/储罐所在格）；运行期必填")
                .optional(
                    "fluid",
                    ActionDescriptor.TYPE_STRING,
                    "流体名（必填）：Forge 流体注册名（权威身份，如 hydrochloricacid_gt5u）或 GT 材料名"
                        + "（如 HydrochloricAcid）——两条都接受。GT 的材料流体按材料名小写注册，"
                        + "带 _GT5U 后缀的材料（避开与别模组撞名的那些）会差一个后缀，故解析时剥掉后缀做匹配。"
                        + "查不到报 CP-VALID-002 并附已注册名样本，不静默回落到水/空气")
                .optional(
                    "amount",
                    ActionDescriptor.TYPE_INT,
                    "注入量 mB（必填，1.." + TankFillSpec.MAX_AMOUNT + "）。不给默认值：漏写量必须显式失败，" + "否则「漏写」会静默变成一次真实注入")
                .optional(
                    "side",
                    ActionDescriptor.TYPE_STRING,
                    TankFillSpec.DEFAULT_SIDE,
                    "注入面 DOWN|UP|NORTH|SOUTH|WEST|EAST（默认 UP，与 gt-machine 的放置面同口径）。" + "带盖的机器只有特定面能进流体，那种场景必须显式给面")
                .returns(
                    "{action, layer:\"L0\", semantics:\"fill\", layerNote, "
                        + "target{at,teClass,block,fluidHandler,gtMachine,side}, "
                        + "requested{fluid,fluidRequested,amount,localizedName}, "
                        + "filled, dryRunFillable, notFilled, complete, partial, before{...}, after{...}, sceneReadback{...}}。"
                        + "filled = IFluidHandler.fill 的实际返回值（部分注入如实报告，partial:true）；"
                        + "dryRunFillable = 一次 fill(...,false) 干跑的结果（不改状态），用来把「返回 0」的两种原因分开"
                        + "（干跑>0 而实注 0 ⇒ GT 的运行期门；干跑 0 ⇒ 容量/流体种类）。"
                        + "before/after 含逐罐 {index,present,capacity,fluid,amount,empty}（**输入侧的权威读数**，"
                        + "断言注入量请用它）与 GT 侧单值读数（drainableFluid/drainableFluidAmount 是"
                        + "**输出/可排出**那一侧——MTEBasicMachine 的 getFluid 就是 getDrainableStack，"
                        + "入口注 HCl 时它是 null/0，配方跑完后才变成产物；metaTileCapacity 是真正的储罐容量）。"
                        + "注入量为 0 报 CP-EXEC-001（附候选原因与前后读数）；"
                        + "非流体处理器/无方块实体报 CP-STATE-001；未知流体报 CP-VALID-002")
                .example("{\"at\":[65,12,65],\"fluid\":\"HydrochloricAcid\",\"amount\":3000,\"confirm\":true}")
                .example(
                    "{\"at\":[65,12,65],\"fluid\":\"hydrochloricacid_gt5u\",\"amount\":3000,\"side\":\"UP\","
                        + "\"confirm\":true}")
                .since("1.7")
                .build(),
            new TankFillAction());
    }

    /**
     * PR-2 取证级动作（contract.md §4.2）：{@code shot.multi} / {@code capture.begin} / {@code capture.end}。
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
                    "{\"cameras\":[{\"name\":\"front-top\",\"pos\":[64.5,20.0,70.5],\"yaw\":180.0,\"pitch\":45.0,"
                        + "\"projection\":{\"type\":\"perspective\",\"fov\":70},\"resolution\":[1920,1080]},"
                        + "{\"name\":\"hi-res\",\"pos\":[64.5,20.0,70.5],\"yaw\":180.0,\"pitch\":30.0,"
                        + "\"projection\":{\"type\":\"ortho\",\"orthoHeight\":16.0},\"resolution\":[3840,2160],"
                        + "\"tile\":{\"cols\":2,\"rows\":2,\"overlap\":0.05}}],"
                        + "\"lighting\":\"neutral-flat\",\"renderMode\":\"本色\",\"worldTime\":6000,\"confirm\":true}")
                .since("1.1")
                .build(),
            () -> new ShotMultiAction(runtime));

        registry.register(
            ActionDescriptor.builder("capture.begin", Tier.FORENSIC)
                .description(
                    "开始捕获会话：此后一切世界写动作（world.rebuild/world.snapshot/world.rollback、"
                        + "case.run 的 build 段，以及 #99 的六个 scene.* L0 原语）"
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
