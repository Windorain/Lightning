package com.lightning.mod.client.controlplane.mc;

import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.capture.CaptureBeginAction;
import com.lightning.mod.client.controlplane.mc.capture.CaptureEndAction;
import com.lightning.mod.client.controlplane.mc.capture.ShotMultiAction;
import com.lightning.mod.client.controlplane.mc.read.ReadBlockInfoAction;
import com.lightning.mod.client.controlplane.mc.read.ReadBlocksAction;
import com.lightning.mod.client.controlplane.mc.read.ReadDiffAction;
import com.lightning.mod.client.controlplane.mc.read.ReadInventoryAction;
import com.lightning.mod.client.controlplane.mc.read.ReadOverviewAction;
import com.lightning.mod.client.controlplane.mc.read.ReadPlayerAction;
import com.lightning.mod.client.controlplane.mc.read.ReadRunAction;
import com.lightning.mod.client.controlplane.mc.read.ReadTeAction;

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
                    "执行用例（整跑或按段，同一实现）：world→capture→build→read→cameras→criteria→evidence，"
                        + "逐段落 segments/<name>.json，写 criteria.json / evidence.json / observation.json。"
                        + "capture 段建立捕获会话（期间世界写动作被拒 CP-STATE-001），cameras 段逐机位走 shot.multi 的"
                        + "同一实现；cameras 段非空时本动作按内容升格为 forensic（不足 CP-AUTH-002）。"
                        + "read 段（v1.3）逐条执行用例声明的 read.* 动作，读数落本 run 目录供 criteria 直接引用。")
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
        registerReadActions(runtime, registry);
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
