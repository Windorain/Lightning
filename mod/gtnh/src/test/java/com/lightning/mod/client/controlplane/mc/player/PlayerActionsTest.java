package com.lightning.mod.client.controlplane.mc.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;

/**
 * L1 玩家操作（issue #101）中<b>不依赖 MC 运行时</b>的那部分逻辑的单测。
 *
 * <h2>为什么只能测这部分</h2>
 * 与读面同一理由（{@code ReadSurfaceTest} 的类注释、contract.md §9 的分层）：L1 动作的执行体要碰
 * {@code Minecraft}/{@code EntityClientPlayerMP}/{@code PlayerControllerMP}/{@code NetHandlerPlayServer}，
 * 本仓 mod 无渲染/无世界环境的单测能力，因此<b>实机路径由 runClient 实测覆盖</b>
 * （证据见 {@code temp/cp-l1/evidence/}）。
 *
 * <p>
 * 但有三类东西恰恰必须离线锁住，否则实机验收会建在流沙上：
 * <ul>
 * <li><b>自描述完备性（D1/D3 的机读前提）</b>：自述端点从同一份 {@code ActionDescriptor} 渲染，
 * 这里绿而端点红是不可能的形态；</li>
 * <li><b>契约版本不变式</b>：{@code contractVersion ≥ max(since)}——版本比动作还旧的自述目录
 * 是自相矛盾的（D1/D3 判红）；</li>
 * <li><b>纯几何/查表逻辑</b>：放置的 side 偏移规则、面中心点、槽位归属分类——这些错了会表现成
 * 「实机跑不通但看不出为什么」，而它们本身是纯函数。</li>
 * </ul>
 */
public class PlayerActionsTest {

    /** 本组九个动作的名单（L1 的完整能力面，见 contract.md §4.6）。 */
    private static final String[] PLAYER_ACTIONS = { PlayerMoveAction.NAME, PlayerLookAction.NAME, UseItemAction.NAME,
        PlayerInteractAction.NAME, PlayerDigAction.NAME, PlaceBlockAction.NAME, PlayerPickupAction.NAME,
        SlotClickAction.NAME, PlayerGuiAction.NAME };

    // ------------------------------------------------------------ 注册与权限级

    /** 九个动作全部注册、全部 scene 级（可写 ⇒ 一律要求 confirm）。 */
    @Test
    public void playerActionsAreRegisteredAtSceneTier() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (String name : PLAYER_ACTIONS) {
            ActionDescriptor d = registry.descriptor(name);
            assertNotNull("L1 动作必须已注册: " + name, d);
            assertEquals(name + " 必须是 scene 级（L1 是改变世界的操作）", Tier.SCENE, d.tier());
            assertTrue(name + " 是可写动作，必须要求 confirm", d.writable());
        }
    }

    /**
     * 契约版本不变式：{@code Contract.VERSION ≥ 每个动作的 since}。
     *
     * <p>
     * 这是 §5 版本化规则的可判定形态，也是 D1/D3 的前提：「服务契约版本比某个动作的引入版本还旧」
     * 的自述目录会让调用方按旧版本去理解新字段。
     */
    @Test
    public void contractVersionCoversEveryActionSince() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        double contract = Double.parseDouble(Contract.VERSION);
        for (String name : registry.names()) {
            ActionDescriptor d = registry.descriptor(name);
            double since = Double.parseDouble(d.since());
            assertTrue(
                "动作 " + name + " 的 since=" + d.since() + " 高于契约版本 " + Contract.VERSION + "（自述目录会自相矛盾）",
                since <= contract);
        }
    }

    /** L1 的引入版本是 1.5（契约 §5：新增动作带 since；分支自报 1.4 与 #100 撞号，调度者合流裁决为 1.5）。 */
    @Test
    public void playerActionsAreSince15() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (String name : PLAYER_ACTIONS) {
            assertEquals(
                name + " since 应为 1.5（#101 引入）",
                "1.5",
                registry.descriptor(name)
                    .since());
        }
        assertEquals("契约版本应升到 1.5", "1.5", Contract.VERSION);
    }

    /** 动作名以 {@code player.} 开头——前缀即分组（与 read./scene. 同约定）。 */
    @Test
    public void playerActionNamesUsePlayerPrefix() {
        for (String name : PLAYER_ACTIONS) {
            assertTrue("L1 动作名应以 player. 开头: " + name, name.startsWith("player."));
        }
    }

    // ------------------------------------------------------------ 自描述完备性（D1/D3）

    /**
     * 逐动作自描述六要素齐备：名称、权限级、逐参数（名/类型/必填/说明）、返回结构、可复制示例、since，
     * 且描述里写明层归属（{@code L1}）——那是调用方判断「这条结论算哪一层」的唯一依据（#96 §4.2）。
     */
    @Test
    public void playerActionDescriptorsAreComplete() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (String name : PLAYER_ACTIONS) {
            ActionDescriptor d = registry.descriptor(name);
            assertNotNull(name + " 缺 description", d.description());
            assertFalse(
                name + " description 为空",
                d.description()
                    .trim()
                    .isEmpty());
            assertTrue(
                name + " description 未声明 L1 层归属",
                d.description()
                    .contains("L1："));
            assertNotNull(name + " returns", d.returns());
            assertFalse(
                name + " returns 为空",
                d.returns()
                    .trim()
                    .isEmpty());
            // returns 必须写出 layer 字段：两义标注要靠它机读（#96 裁决 3/4）
            assertTrue(
                name + " returns 未声明 layer 字段",
                d.returns()
                    .contains("layer"));
            assertNotNull(name + " since", d.since());
            assertNotNull(name + " examples", d.examples());
            assertTrue(
                name + " 至少给一条可复制示例",
                d.examples()
                    .size() > 0);
            for (int i = 0; i < d.examples()
                .size(); i++) {
                assertTrue(
                    name + " 示例 " + i + " 必须是 JSON 对象（可复制粘贴）",
                    d.examples()
                        .get(i)
                        .isJsonObject());
                // 可写动作的示例必须自带 confirm，否则照抄示例会被 CP-CONFIRM-001 拒
                assertTrue(
                    name + " 示例 " + i + " 缺 confirm:true（照抄示例会被 CP-CONFIRM-001 拒）",
                    d.examples()
                        .get(i)
                        .getAsJsonObject()
                        .has("confirm"));
            }
            for (ActionDescriptor.Param p : d.params()) {
                assertNotNull(name + " 参数缺名", p.name());
                assertNotNull(name + "." + p.name() + " 缺类型", p.type());
                assertNotNull(name + "." + p.name() + " 缺说明", p.description());
                assertFalse(
                    name + "." + p.name() + " 说明为空",
                    p.description()
                        .trim()
                        .isEmpty());
            }
        }
    }

    /** 示例 JSON 必须可严格解析（示例是「无先验知识调用方」的唯一素材，写错等于没有）。 */
    @Test
    public void playerActionExamplesAreParseable() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (String name : PLAYER_ACTIONS) {
            ActionDescriptor d = registry.descriptor(name);
            for (int i = 0; i < d.examples()
                .size(); i++) {
                String text = Json.toJson(
                    d.examples()
                        .get(i));
                Json.parseStrictObject(text);
            }
        }
    }

    /** D3：实现了默认行为的参数必须以机读的 {@code default} 出现，且与实现取值一致。 */
    @Test
    public void playerActionDefaultsAreMachineReadable() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        assertDefault(registry, PlayerMoveAction.NAME, "direction", "forward");
        assertDefault(registry, PlayerMoveAction.NAME, "maxTicks", Integer.valueOf(PlayerMoveAction.DEFAULT_MAX_TICKS));
        assertDefault(registry, PlayerMoveAction.NAME, "allowFlying", Boolean.FALSE);
        assertDefault(registry, PlayerLookAction.NAME, "steps", Integer.valueOf(1));
        assertDefault(registry, PlayerInteractAction.NAME, "target", "auto");
        assertDefault(registry, PlayerInteractAction.NAME, "reach", Double.valueOf(PlayerSession.SERVER_REACH));
        assertDefault(registry, PlayerDigAction.NAME, "target", "auto");
        assertDefault(registry, PlayerDigAction.NAME, "holdTicks", Integer.valueOf(PlayerDigAction.DEFAULT_HOLD_TICKS));
        assertDefault(registry, PlaceBlockAction.NAME, "side", Integer.valueOf(1));
        assertDefault(registry, PlayerPickupAction.NAME, "approach", Boolean.TRUE);
        assertDefault(
            registry,
            PlayerPickupAction.NAME,
            "maxTicks",
            Integer.valueOf(PlayerPickupAction.DEFAULT_MAX_TICKS));
        // player.gui 的 gui 是运行期必填，因此不得有 default（D3 的另一半：没默认值就别写）
        assertNoDefault(registry, PlayerGuiAction.NAME, "gui");
        assertNoDefault(registry, PlayerMoveAction.NAME, "to");
        assertNoDefault(registry, PlayerLookAction.NAME, "yaw");
        assertNoDefault(registry, SlotClickAction.NAME, "clicks");
    }

    // ------------------------------------------------------------ 纯逻辑：放置的 side 偏移

    /**
     * {@code side} 偏移规则与原版 {@code NetHandlerPlayServer.processPlayerBlockPlacement} 逐字一致。
     *
     * <p>
     * 这是「{@code at} 是<b>被右键的方块</b>而不是新方块位置」这条自述的可判定依据——
     * 偏移写反了，自述与行为就分叉了（D1 判红），而实机上只表现为「放到别处了」。
     */
    @Test
    public void placeBlockSideOffsetMatchesVanilla() {
        int x = 10;
        int y = 20;
        int z = 30;
        assertArrayEqualsInt(new int[] { x, y - 1, z }, PlaceBlockAction.offset(x, y, z, 0)); // 下
        assertArrayEqualsInt(new int[] { x, y + 1, z }, PlaceBlockAction.offset(x, y, z, 1)); // 上
        assertArrayEqualsInt(new int[] { x, y, z - 1 }, PlaceBlockAction.offset(x, y, z, 2)); // 北
        assertArrayEqualsInt(new int[] { x, y, z + 1 }, PlaceBlockAction.offset(x, y, z, 3)); // 南
        assertArrayEqualsInt(new int[] { x - 1, y, z }, PlaceBlockAction.offset(x, y, z, 4)); // 西
        assertArrayEqualsInt(new int[] { x + 1, y, z }, PlaceBlockAction.offset(x, y, z, 5)); // 东
    }

    /** 面中心点落在对应面上（命中点必须在该面上，否则原版会算错放置方向）。 */
    @Test
    public void placeBlockFaceCentersLieOnTheFace() {
        net.minecraft.util.Vec3 top = PlaceBlockAction.faceCenter(10, 20, 30, 1);
        assertEquals(10.5D, top.xCoord, 1.0E-9D);
        assertEquals(21.0D, top.yCoord, 1.0E-9D);
        assertEquals(30.5D, top.zCoord, 1.0E-9D);
        net.minecraft.util.Vec3 bottom = PlaceBlockAction.faceCenter(10, 20, 30, 0);
        assertEquals(20.0D, bottom.yCoord, 1.0E-9D);
        net.minecraft.util.Vec3 north = PlaceBlockAction.faceCenter(10, 20, 30, 2);
        assertEquals(30.0D, north.zCoord, 1.0E-9D);
        net.minecraft.util.Vec3 east = PlaceBlockAction.faceCenter(10, 20, 30, 5);
        assertEquals(11.0D, east.xCoord, 1.0E-9D);
    }

    // ------------------------------------------------------------ 纯逻辑：参数校验

    /**
     * 无世界时九个动作的前置检查必须是<b>契约错误</b>而不是裸异常。
     *
     * <p>
     * 这是「探索模式纪律」（#96 §3）里<b>离线可判定</b>的那一半：动作在没有世界的环境下被调用，
     * 必须走契约错误码这条可控路径，而不是抛 {@code NPE} 之类让调用方只能靠翻日志猜的异常。
     *
     * <p>
     * 实现方式说明：{@code ActionContext} 的构造器是包私有的（core 的分层设计），本测试无法伪造
     * 上下文去真调 {@code execute}。因此改用<b>结构可判定性</b>：
     * <ul>
     * <li>九个实现类都能无参构造（注册表按实例注册同步动作）；</li>
     * <li>都实现了 {@code ControlAction}（即有 {@code execute(ActionContext)}）；</li>
     * <li>都依赖 {@link PlayerSession#requireClientPlayer} 这条公共前置——它无世界即
     * {@code CP-STATE-001}（见 {@link #playerSessionRequireClientPlayerIsTheSingleEntryPoint}）。</li>
     * </ul>
     * 运行级断言由 runClient 的负场景脚本覆盖（证据见 {@code temp/cp-l1/evidence/}）。
     */
    @Test
    public void playerActionsAreConstructibleControlActions() throws Exception {
        for (String name : PLAYER_ACTIONS) {
            Class<?> cls = actionFor(name).getClass();
            com.lightning.mod.client.controlplane.core.ControlAction a = (com.lightning.mod.client.controlplane.core.ControlAction) cls
                .getDeclaredConstructor()
                .newInstance();
            assertNotNull(name + " 必须可无参构造（注册表按实例注册同步动作）", a);
            assertNotNull(
                name + " 缺 execute(ActionContext)",
                cls.getMethod("execute", com.lightning.mod.client.controlplane.core.ActionContext.class));
        }
    }

    /**
     * 公共前置只有一处实现：{@link PlayerSession}。九个动作都必须经它拿玩家——
     * 散落的前置检查会让「无世界时报什么」逐动作分叉，而调用方只认一种。
     */
    @Test
    public void playerSessionRequireClientPlayerIsTheSingleEntryPoint() throws Exception {
        java.lang.reflect.Method m = PlayerSession.class.getMethod(
            "requireClientPlayer",
            com.lightning.mod.client.controlplane.core.ActionContext.class,
            String.class);
        assertNotNull("PlayerSession.requireClientPlayer 必须存在（L1 的公共前置）", m);
        assertTrue(
            "requireClientPlayer 必须声明抛/产生 CP-STATE-001 语义（返回值声明里没有异常，" + "该契约由 javadoc 与实现共同承担，见 PlayerSession 类注释）",
            m.getReturnType() == net.minecraft.client.entity.EntityClientPlayerMP.class);
        // capture 门控（写入门控）也在这一层：L1 与 L0 同口径
        assertNotNull(
            "PlayerSession 必须提供写入门控入口（捕获会话期间拒绝别的作业）",
            PlayerSession.class.getMethod(
                "requireClientPlayer",
                com.lightning.mod.client.controlplane.core.ActionContext.class,
                String.class));
    }

    // ------------------------------------------------------------ 纯逻辑：槽位归属

    /**
     * 槽位归属分类：玩家背包 / 合成格 / 其它容器（槽位语义说明靠它，错了会误导调用方）。
     *
     * <p>
     * 契约：<b>恒有返回值，绝不返回 null</b>——{@code slotMeaning} 会遍历容器全部槽位来统计归属，
     * 任何一环拿到 null 槽位都不得让整次调用炸掉（那会把「开着的容器有点怪」升级成一次失败）。
     * 认不出的归 {@code "unknown"}（可见的兜底，而不是静默当玩家背包）。
     */
    @Test
    public void slotKindClassifiesInventories() {
        assertEquals("null 槽位归 unknown（不炸、不静默当玩家背包）", "unknown", SlotClickAction.slotKind(null));
        net.minecraft.inventory.Slot noInventory = new net.minecraft.inventory.Slot(null, 0, 0, 0);
        assertEquals("inventory 为 null 时归 unknown", "unknown", SlotClickAction.slotKind(noInventory));
    }

    /** 按槽号取 Slot：越界返回 null（不抛），便于动作自己报 CP-VALID-002 而不是 500。 */
    @Test
    public void slotAtReturnsNullWhenAbsent() {
        assertNull(SlotClickAction.slotAt(null, 0));
    }

    /** 槽位语义说明恒非空且点明「与 InventoryPlayer 下标不同」——两条路径的槽号口径必须分开。 */
    @Test
    public void slotMeaningNamesTheDifferenceFromInventoryPlayerIndex() {
        String meaning = SlotClickAction.slotMeaning(null, 0);
        assertNotNull(meaning);
        assertTrue("槽位语义必须点明与 InventoryPlayer 下标不同", meaning.contains("InventoryPlayer"));
    }

    // ------------------------------------------------------------ JSON 合法性（协议级）

    /**
     * 非有限浮点必须被挡在响应体之外。
     *
     * <h2>这条为什么是协议级而不是风格问题（实测事故）</h2>
     * 首轮实机验证里 {@code player.dig} 的 {@code relativeHardness} 写成了 {@code Infinity}
     * （方块已被挖掉后再读硬度，原版返回 {@code 1.0F/0.0F}）。JSON 规范<b>没有</b> Infinity 字面量，
     * 于是整份响应体变成非法 JSON：{@code caller.mjs} 报 {@code error.code = "HTTP-200"}，
     * 排查方向被带偏到鉴权/路由，真正的原因要 dump 原始字节才看得到。因此这里把它锁进单测。
     */
    @Test
    public void nonFiniteNumbersAreRejectedByJsonSafetyGuard() {
        // 有限值：放行
        JsonObject good = new JsonObject();
        good.addProperty("h", Double.valueOf(1.5D));
        good.addProperty("n", Integer.valueOf(3));
        good.addProperty("s", "x");
        PlayerSession.assertJsonSafe(good, "t"); // 不抛即通过

        // Infinity：必须被指名报出
        JsonObject bad = new JsonObject();
        bad.addProperty("relativeHardness", Double.valueOf(Double.POSITIVE_INFINITY));
        try {
            PlayerSession.assertJsonSafe(bad, "t");
            fail("Infinity 必须被拒绝（它会毒掉整份响应体）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
            assertNotNull("必须带 context", e.context());
            assertTrue(
                "必须指名到字段路径",
                Json.toJson(e.context())
                    .contains("relativeHardness"));
        }

        // NaN 同理
        JsonObject nan = new JsonObject();
        nan.addProperty("healthBefore", Double.valueOf(Double.NaN));
        try {
            PlayerSession.assertJsonSafe(nan, "t");
            fail("NaN 必须被拒绝");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
        }

        // 嵌在数组/对象里也要查得到（不能只查顶层）
        JsonObject nested = new JsonObject();
        JsonArray arr = new JsonArray();
        JsonObject deep = new JsonObject();
        deep.addProperty("v", Double.valueOf(Double.NEGATIVE_INFINITY));
        arr.add(deep);
        nested.add("items", arr);
        try {
            PlayerSession.assertJsonSafe(nested, "t");
            fail("嵌套的 Infinity 也必须被发现");
        } catch (CpException e) {
            assertTrue(
                "路径应指出嵌套位置",
                Json.toJson(e.context())
                    .contains("/items/0/v"));
        }
    }

    /** {@code finiteOrNull}：有限值原样返回，非有限值给 null（而不是字面量）。 */
    @Test
    public void finiteOrNullMapsNonFiniteToNull() {
        assertEquals(Double.valueOf(2.5D), PlayerSession.finiteOrNull(2.5D));
        assertNull(PlayerSession.finiteOrNull(Double.NaN));
        assertNull(PlayerSession.finiteOrNull(Double.POSITIVE_INFINITY));
        assertNull(PlayerSession.finiteOrNull(Double.NEGATIVE_INFINITY));
        assertEquals(Double.valueOf(-1.0D), PlayerSession.finiteOrNull(-1.0D));
    }

    // ------------------------------------------------------------ 客户端/服务端 y 空间换算

    /**
     * 1.7.10 的 S08 y 约定：客户端 {@code posY} = 服务端 {@code posY} + 1.62。
     *
     * <h2>为什么锁这一条（实测事故）</h2>
     * {@code NetHandlerPlayServer.setPlayerLocation} 发 S08 时写的是眼睛高度（{@code y + 1.62}），
     * 而 {@code NetHandlerPlayClient.handlePlayerPosLook} 直接 {@code setPositionAndRotation} 而不减回去。
     * 移动原语在客户端玩家身上算步长，若把服务端空间的 y 直接当客户端目标 y，
     * 就凭空多出 −1.62 的向下分量：{@code player.pickup} 的「同层」判断被误判，
     * 玩家斜着走、卡在地板边缘并漂出平台（实测终点 x=62.69，平台 63..70）；
     * {@code player.move} 的客户端 {@code arrived} 也因此永远到不了容差。
     *
     * <p>
     * 本用例锁住闸门那一半（纯函数）：合法偏移原样采纳、异常值退化为 0。
     * 真机读数（client=14.62 / server=13.0 ⇒ 偏移 1.62）在证据文件里。
     */
    @Test
    public void yOffsetGateAcceptsSaneValuesAndDegradesOthers() {
        // 1.7.10 实测值必须被采纳（否则等于没建模）
        assertEquals(1.62D, PlayerSession.saneYOffset(1.62D), 1.0E-9D);
        assertEquals(-1.62D, PlayerSession.saneYOffset(-1.62D), 1.0E-9D);
        assertEquals(0.0D, PlayerSession.saneYOffset(0.0D), 0.0D);
        assertEquals(7.9D, PlayerSession.saneYOffset(7.9D), 1.0E-9D);
        // 越界/非有限 ⇒ 退化为 0（宁可当同空间，也不让 NaN 传进 moveEntity）
        assertEquals(0.0D, PlayerSession.saneYOffset(8.0D), 0.0D);
        assertEquals(0.0D, PlayerSession.saneYOffset(-100.0D), 0.0D);
        assertEquals(0.0D, PlayerSession.saneYOffset(Double.NaN), 0.0D);
        assertEquals(0.0D, PlayerSession.saneYOffset(Double.POSITIVE_INFINITY), 0.0D);
    }

    // ------------------------------------------------------------ 两义标注的可判定形态

    /**
     * 「给」（L0）与「拾取」（L1）在同一场景分别演示的前提，是两边的返回值都带机读的层标记。
     *
     * <p>
     * 本用例锁住 L1 侧的形态：{@code player.pickup} 的 {@code returns} 必须写明
     * {@code layer:"L1"} 与 {@code semantics:"pickup"}，且描述里点名它与
     * {@code scene.inventory.write}（L0 give）是两义、不互替（#96 裁决 4 / §4.2）。
     */
    @Test
    public void pickupDescriptorDeclaresLayerAndCrossReference() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor pickup = registry.descriptor(PlayerPickupAction.NAME);
        assertTrue(
            "pickup 的 returns 必须写明 layer:\"L1\"",
            pickup.returns()
                .contains("layer:\"L1\""));
        assertTrue(
            "pickup 的 returns 必须写明 semantics:\"pickup\"",
            pickup.returns()
                .contains("semantics:\"pickup\""));
        assertTrue(
            "pickup 的描述必须点名与 scene.inventory.write（L0 的「给」）是两义",
            pickup.description()
                .contains("scene.inventory.write"));
        assertTrue(
            "pickup 的描述必须写明结论不互替",
            pickup.description()
                .contains("不互替"));
        // 反向：L0 的 scene.inventory.write 也要存在且自述里点名它属 L0（对照的另一半）
        ActionDescriptor give = registry.descriptor("scene.inventory.write");
        assertNotNull("scene.inventory.write 必须已注册（两义的另一半）", give);
        assertTrue(
            "L0 的 give 自述应已声明 layer:\"L0\"",
            give.returns()
                .contains("layer:\"L0\""));
    }

    /** 真实移动（L1）与瞬时传送（L0）的两义：两边的自述必须互相点名。 */
    @Test
    public void moveAndLookDescriptorsCrossReferencePose() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (String name : new String[] { PlayerMoveAction.NAME, PlayerLookAction.NAME }) {
            assertTrue(
                name + " 的描述必须点名与 scene.player.pose（L0 瞬时传送/转向）的区别",
                registry.descriptor(name)
                    .description()
                    .contains("scene.player.pose"));
        }
        ActionDescriptor pose = registry.descriptor("scene.player.pose");
        assertNotNull(pose);
        assertTrue(
            "L0 的 pose 自述应已声明 layer:\"L0\"",
            pose.returns()
                .contains("layer:\"L0\""));
    }

    // ------------------------------------------------------------ 工具

    private static com.lightning.mod.client.controlplane.core.ControlAction actionFor(String name) {
        if (PlayerMoveAction.NAME.equals(name)) {
            return new PlayerMoveAction();
        }
        if (PlayerLookAction.NAME.equals(name)) {
            return new PlayerLookAction();
        }
        if (UseItemAction.NAME.equals(name)) {
            return new UseItemAction();
        }
        if (PlayerInteractAction.NAME.equals(name)) {
            return new PlayerInteractAction();
        }
        if (PlayerDigAction.NAME.equals(name)) {
            return new PlayerDigAction();
        }
        if (PlaceBlockAction.NAME.equals(name)) {
            return new PlaceBlockAction();
        }
        if (PlayerPickupAction.NAME.equals(name)) {
            return new PlayerPickupAction();
        }
        if (SlotClickAction.NAME.equals(name)) {
            return new SlotClickAction();
        }
        if (PlayerGuiAction.NAME.equals(name)) {
            return new PlayerGuiAction();
        }
        throw new IllegalArgumentException("未知动作: " + name);
    }

    private static void assertDefault(ActionRegistry registry, String action, String param, Object expected) {
        ActionDescriptor.Param found = findParam(registry, action, param);
        assertNotNull(action + "." + param + " 缺 default（D3：默认值必须可见）", found.defaultValue());
        com.google.gson.JsonElement want;
        if (expected instanceof Boolean) {
            want = new JsonPrimitive((Boolean) expected);
        } else if (expected instanceof Number) {
            want = new JsonPrimitive((Number) expected);
        } else {
            want = new JsonPrimitive(String.valueOf(expected));
        }
        assertEquals(
            action + "." + param + " 的 default 与实现取值不一致（期望 " + Json.toJson(want) + "）",
            want,
            found.defaultValue());
    }

    private static void assertNoDefault(ActionRegistry registry, String action, String param) {
        ActionDescriptor.Param found = findParam(registry, action, param);
        assertNull(action + "." + param + " 没有默认行为，不该有 default（写了就是骗调用方）", found.defaultValue());
    }

    private static ActionDescriptor.Param findParam(ActionRegistry registry, String action, String param) {
        ActionDescriptor d = registry.descriptor(action);
        assertNotNull("动作未注册: " + action, d);
        for (ActionDescriptor.Param p : d.params()) {
            if (param.equals(p.name())) {
                return p;
            }
        }
        fail(action + " 缺参数 " + param);
        return null;
    }

    private static void assertArrayEqualsInt(int[] want, int[] got) {
        assertEquals("长度", want.length, got.length);
        for (int i = 0; i < want.length; i++) {
            assertEquals("第 " + i + " 个分量", want[i], got[i]);
        }
    }

    private static JsonArray pos(int x, int y, int z) {
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(x));
        a.add(new JsonPrimitive(y));
        a.add(new JsonPrimitive(z));
        return a;
    }
}
