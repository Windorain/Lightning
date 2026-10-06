package com.lightning.mod.client.controlplane.mc;

import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.capture.CaptureBeginAction;
import com.lightning.mod.client.controlplane.mc.capture.CaptureEndAction;
import com.lightning.mod.client.controlplane.mc.capture.ShotMultiAction;
import com.lightning.mod.client.controlplane.mc.scene.EntityClearAction;
import com.lightning.mod.client.controlplane.mc.scene.EntitySpawnAction;
import com.lightning.mod.client.controlplane.mc.scene.InventoryWriteAction;
import com.lightning.mod.client.controlplane.mc.scene.PlayerPoseAction;
import com.lightning.mod.client.controlplane.mc.scene.PlayerStateAction;
import com.lightning.mod.client.controlplane.mc.scene.WeatherTimeAction;

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
 * （{@link #registerForensicActions}）+ #99 的 6 个 L0 布景原语（{@link #registerSceneActions}）。
 *
 * <p>
 * 同步 vs 步进：{@code core.*} / {@code world.info} / {@code case.validate} 是同步动作
 * （单次 tick 内完成）；世界/用例/截图动作与 PR-2 的 {@code shot.multi} 跨 tick 执行，注册为步进动作。
 * L0 组（{@code scene.*}）是同步动作——只做一次性字段写入，无跨 tick 等待。
 * 全部动作都由 {@code ActionSteppingExecutor} 执行（它同时兼容同步注册项）。
 */
public final class ActionRegistrar {

    /** 全部步进动作共有的两个超时参数说明。 */
    private static final String TIMEOUT_DOC = "总超时（毫秒，≤0 表示不限）；超时抛 CP-EXEC-002";

    /** 见 {@link #TIMEOUT_DOC}。 */
    private static final String STAGE_TIMEOUT_DOC = "单个阶段超时（毫秒，≤0 表示不限）；超时抛 CP-EXEC-002";

    private ActionRegistrar() {}

    /** 注册全部动作。 */
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

        registerSceneActions(runtime, registry);
        registerForensicActions(runtime, registry);
    }

    /**
     * L0 布景原语（#99，contract.md §4.3）：实体 / 玩家状态 / 背包 / 天气时间 / 位置朝向。
     *
     * <p>
     * 六个动作全是 {@link Tier#SCENE} 同步动作——它们只在服务端权威世界上做一次性的字段写入
     * （无跨 tick 等待、无世界装卸），因此不按步进注册。<b>层归属</b>按 #96 §4.1：本组是
     * <b>L0</b>——直接设定状态、用于布景与构造输入；L0 的产物不能当作 L1（玩家操作）的证据
     * （#96 §4.2）。带「拿到物品」语义的 {@code scene.inventory.write} 与 #101 的 L1「拾取」
     * 是两义、两义都做、按层标注（裁决 4）；{@code scene.player.pose} 与 #101 的 L1 真实移动同理（裁决 3）。
     *
     * <p>
     * 共同口径（写在每个动作的类注释里，这里只列索引）：
     * <ul>
     * <li><b>只写服务端权威世界</b>（{@code MinecraftServer.worldServers[0]}）——客户端
     * {@code WorldClient} 是只读投影，写它会被原版同步覆写（见 {@code mc.scene.L0Session}）；</li>
     * <li><b>同步一律走原版出口</b>（S2B/S06/S1F/S1D/S08/S2F…），不自造同步、不静态回填（契约 §6.4）；</li>
     * <li><b>写入门控</b>：捕获会话期间被别的作业调用即 {@code CP-STATE-001}（契约 §4.1，既有口径）；</li>
     * <li><b>返回值自带读回</b>：{@code before}/{@code after} 或逐项 {@code readBack}，外加
     * {@code sceneReadback}（按世界内最新场景清单的位置集合实读回读的规范化哈希）。
     * 读面（#98）未落地时，调用方据此自证「这次写观察到了什么变化」。</li>
     * </ul>
     */
    private static void registerSceneActions(ControlPlaneRuntime runtime, ActionRegistry registry) {
        registry.register(
            ActionDescriptor.builder("scene.entity.spawn", Tier.SCENE)
                .description(
                    "L0：在托管世界生成实体（含掉落物）。只作用于服务端权威世界，随后经原版实体跟踪器同步给客户端。"
                        + "掉落物给 item（物品注册名）而不是 entity；一般实体给 entity（EntityList 注册名）。"
                        + "entity 与 item 互斥且必须给一个。层归属：本动作是布景原语（构造「拾取」的输入），"
                        + "不是「玩家扔出了物品」的证据——拾取属 L1（#101），两层结论不互替。")
                .optional("entities", ActionDescriptor.TYPE_ARRAY, "实体条目数组 [entry]，逐条生成")
                .optional("entity", ActionDescriptor.TYPE_OBJECT, "单个实体条目（与 entities 可同时给，追加在后）")
                .optional("pos", ActionDescriptor.TYPE_ARRAY, "默认坐标 [x,y,z]（条目自身没给 pos 时用）")
                .returns(
                    "{action, layer?, requested, spawnedCount, spawned[{ok,entityId,class,entityIdNum,pos,item?,nbtApplied}], "
                        + "failed[{index,error}], entityCounts[{key,count}], dimension, sceneReadback{present,sha256?,...}}")
                .example(
                    "{\"entities\":[{\"item\":\"minecraft:stone\",\"meta\":0,\"count\":3,\"pos\":[64.5,13,64.5]},"
                        + "{\"entity\":\"minecraft:zombie\",\"pos\":[66.5,13,64.5],\"yaw\":180}],\"confirm\":true}")
                .example(
                    "{\"entity\":{\"entity\":\"minecraft:pig\",\"pos\":[70.5,13,70.5],"
                        + "\"nbt\":\"{id:\\\"minecraft:pig\\\",CustomNameTag:test,NoAI:1b}\"},\"confirm\":true}")
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
                .optional("entity", ActionDescriptor.TYPE_STRING, "只清该 EntityList 注册名（如 minecraft:item）")
                .optional("item", ActionDescriptor.TYPE_STRING, "只清掉落物里物品为该项的（与 entity 互斥）")
                .optional("meta", ActionDescriptor.TYPE_INT, "与 item 搭配：只清该 meta（不给即不限 meta）")
                .optional("includePlayers", ActionDescriptor.TYPE_BOOL, Boolean.FALSE, "是否连玩家一起清（默认 false）")
                .returns(
                    "{action, removedCount, removed[{entityId,class,entityIdNum,pos,item?,meta?,count?,removed}], "
                        + "selector{box,entity,item,meta,includePlayers}, remainingEntities, sceneReadback{...}}")
                .example("{\"box\":[[63,12,63],[72,20,72]],\"entity\":\"minecraft:item\",\"confirm\":true}")
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
                    "药水效果 [{id,duration,amplifier,ambient}]；id 可为效果名或 1..31")
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
                        + "写入走 setInventorySlotContents + markDirty，并对玩家发一次 Container.detectAndSendChanges。")
                .optional("target", ActionDescriptor.TYPE_STRING, "player | container（默认 player）")
                .optional("at", ActionDescriptor.TYPE_ARRAY, "容器坐标 [x,y,z]（target=container 时必填）")
                .optional("slots", ActionDescriptor.TYPE_ARRAY, "槽位条目数组 [{slot,id,meta,count,nbt}]")
                .optional("slot", ActionDescriptor.TYPE_OBJECT, "单个槽位条目（与 slots 可同时给，追加在后）")
                .returns(
                    "{action, layer:\"L0\", semantics:\"give\", layerNote, target{kind,player?|at?,teClass?,size,inventoryName}, "
                        + "writtenCount, written[{slot,requested,actual,matches}|{slot,cleared}], readBack[{slot,stack|empty}], "
                        + "sceneReadback{...}}")
                .example(
                    "{\"target\":\"player\",\"slots\":[{\"slot\":0,\"id\":\"minecraft:stone\",\"count\":64},"
                        + "{\"slot\":9,\"id\":\"minecraft:diamond_pickaxe\",\"meta\":0,\"count\":1},"
                        + "{\"slot\":10,\"id\":\"air\"}],\"confirm\":true}")
                .example(
                    "{\"target\":\"container\",\"at\":[65,12,65],\"slots\":[{\"slot\":0,\"id\":\"minecraft:torch\",\"count\":16}],"
                        + "\"confirm\":true}")
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
