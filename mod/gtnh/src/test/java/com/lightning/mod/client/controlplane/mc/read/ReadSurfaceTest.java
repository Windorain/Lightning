package com.lightning.mod.client.controlplane.mc.read;

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
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 读面（issue #98）中<b>不依赖 MC 运行时</b>的那部分逻辑的单测。
 *
 * <h2>为什么只能测这部分</h2>
 * 读面的执行体要碰 {@code WorldServer}/{@code EntityPlayerMP}/{@code TileEntity}，
 * 本仓 mod 无渲染/无世界环境的单测能力（contract.md §9 的分层理由），因此实读路径
 * 由 runClient 实测覆盖（见 {@code temp/cp-read/evidence/}）。
 * 但读面里有一批<b>纯 JSON 语义</b>的东西，它们是「两次读面能不能互算」的地基，
 * 恰恰必须离线锁住：
 * <ul>
 * <li>区域哈希子集的形态与排序（{@link ReadSupport#hashSubsetOf}）——错一位就整条互算链断；</li>
 * <li>NBT 摘要的形态（类型名表、截断可见、哈希恒在）；</li>
 * <li>{@link ReadDiffAction#diffKinds} 的差异种类判定；</li>
 * <li>自描述完备性（D1/D3 的机读前提：参数名/类型/必填/默认/说明/示例/since 一个都不能少）。</li>
 * </ul>
 */
public class ReadSurfaceTest {

    // ------------------------------------------------------------ 哈希子集

    /** 哈希子集只含 {pos,blockId,meta}：多余的 id/te 字段必须被丢掉。 */
    @Test
    public void hashSubsetDropsIdentityFields() {
        JsonArray blocks = new JsonArray();
        JsonObject b = new JsonObject();
        b.add("pos", pos(65, 12, 64));
        b.addProperty("blockId", 1);
        b.addProperty("meta", 3);
        b.addProperty("id", "minecraft:stone");
        b.addProperty("te", "net.minecraft.tileentity.TileEntityChest");
        blocks.add(b);

        JsonObject subset = ReadSupport.hashSubsetOf(blocks);
        JsonArray out = Json.optArray(subset, "blocks");
        assertNotNull(out);
        assertEquals(1, out.size());
        JsonObject o = out.get(0)
            .getAsJsonObject();
        assertEquals(3, Json.size(o));
        assertTrue(o.has("pos"));
        assertTrue(o.has("blockId"));
        assertTrue(o.has("meta"));
        assertFalse("id 不入哈希", o.has("id"));
        assertFalse("te 不入哈希", o.has("te"));
        assertNull("不含 tileEntities 键（与场景清单的关系是可互算，见 ReadSupport 注释）", subset.get("tileEntities"));
    }

    /** 哈希子集按 (x,y,z) 升序：与输入顺序无关（否则两次读面算不出同一个哈希）。 */
    @Test
    public void hashSubsetIsSortedByPosRegardlessOfInputOrder() {
        JsonArray forward = new JsonArray();
        forward.add(block(64, 12, 64, 1, 0));
        forward.add(block(65, 12, 64, 1, 0));
        forward.add(block(65, 13, 64, 2, 0));

        JsonArray shuffled = new JsonArray();
        shuffled.add(block(65, 13, 64, 2, 0));
        shuffled.add(block(64, 12, 64, 1, 0));
        shuffled.add(block(65, 12, 64, 1, 0));

        assertEquals(ReadSupport.regionHash(forward), ReadSupport.regionHash(shuffled));
        assertEquals(ReadSupport.canonicalHashInput(forward), ReadSupport.canonicalHashInput(shuffled));
    }

    /** 哈希子集的规范化文本形状固定（键序、无空白），因此哈希可被外部工具复算。 */
    @Test
    public void canonicalHashInputIsStable() {
        JsonArray blocks = new JsonArray();
        blocks.add(block(64, 12, 64, 1, 0));
        String canonical = ReadSupport.canonicalHashInput(blocks);
        assertEquals("{\"blocks\":[{\"blockId\":1,\"meta\":0,\"pos\":[64,12,64]}]}", canonical);
        assertEquals(
            com.lightning.mod.client.controlplane.core.Hashing.sha256HexUtf8(canonical),
            ReadSupport.regionHash(blocks));
    }

    /** 内容不同则哈希不同（防「恒等哈希」这类假判据）。 */
    @Test
    public void differentContentYieldsDifferentHash() {
        JsonArray a = new JsonArray();
        a.add(block(64, 12, 64, 1, 0));
        JsonArray b = new JsonArray();
        b.add(block(64, 12, 64, 1, 1));
        assertFalse(
            ReadSupport.regionHash(a)
                .equals(ReadSupport.regionHash(b)));
        JsonArray c = new JsonArray();
        c.add(block(65, 12, 64, 1, 0));
        assertFalse(
            ReadSupport.regionHash(a)
                .equals(ReadSupport.regionHash(c)));
    }

    /** 空区域也是合法输入（哈希恒可算，不抛）。 */
    @Test
    public void emptyRegionHashes() {
        assertEquals(
            com.lightning.mod.client.controlplane.core.Hashing.sha256HexUtf8("{\"blocks\":[]}"),
            ReadSupport.regionHash(new JsonArray()));
    }

    /** posOf 对畸形输入返回全 0 而不是抛（读面不该因为一条脏数据整次失败）。 */
    @Test
    public void posOfIsTotal() {
        JsonObject noPos = new JsonObject();
        int[] r = ReadSupport.posOf(noPos);
        assertEquals(3, r.length);
        assertEquals(0, r[0]);
        JsonObject shortPos = new JsonObject();
        JsonArray two = new JsonArray();
        two.add(new JsonPrimitive(1));
        two.add(new JsonPrimitive(2));
        shortPos.add("pos", two);
        assertEquals(0, ReadSupport.posOf(shortPos)[0]);
    }

    // ------------------------------------------------------------ 区域参数

    /** 自描述的类型名覆盖到「参数声明用了哪些 TYPE_*」——用反射对齐，防手写参数表漏声明类型。 */
    @Test
    public void regionJsonCarriesVolume() {
        ReadSupport.Region region = new ReadSupport.Region(new int[] { 64, 12, 64 }, new int[] { 65, 12, 64 }, 2L);
        JsonObject o = ReadBlocksAction.regionJson(region);
        assertEquals(2, Json.optInt(o, "volume", -1));
        assertEquals(
            3,
            Json.optArray(o, "from")
                .size());
    }

    /** 坐标解析：非整数分量必须报 CP-VALID-002 并指出是哪一个分量。 */
    @Test
    public void coordsRejectNonIntegralComponent() {
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(1));
        a.add(new JsonPrimitive(1.5d));
        a.add(new JsonPrimitive(3));
        try {
            ReadSupport.coords(a, "at");
            fail("应报 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertNotNull("必须指明是哪一个分量", e.context());
            assertTrue(
                Json.toJson(e.context())
                    .contains("at[1]"));
        }
    }

    /** 坐标解析：分量个数不对必须报错，不静默补 0。 */
    @Test
    public void coordsRejectWrongArity() {
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(1));
        try {
            ReadSupport.coords(a, "at");
            fail("应报 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
        }
    }

    // ------------------------------------------------------------ NBT 类型名

    /** NBT 类型名表覆盖 1.7.10 的全部 11 种取值 + 未知回落。 */
    @Test
    public void nbtTypeNamesCoverVanillaTable() {
        assertEquals("end", ReadSupport.nbtTypeName(0));
        assertEquals("byte", ReadSupport.nbtTypeName(1));
        assertEquals("short", ReadSupport.nbtTypeName(2));
        assertEquals("int", ReadSupport.nbtTypeName(3));
        assertEquals("long", ReadSupport.nbtTypeName(4));
        assertEquals("float", ReadSupport.nbtTypeName(5));
        assertEquals("double", ReadSupport.nbtTypeName(6));
        assertEquals("byteArray", ReadSupport.nbtTypeName(7));
        assertEquals("string", ReadSupport.nbtTypeName(8));
        assertEquals("list", ReadSupport.nbtTypeName(9));
        assertEquals("compound", ReadSupport.nbtTypeName(10));
        assertEquals("intArray", ReadSupport.nbtTypeName(11));
        assertEquals("unknown(12)", ReadSupport.nbtTypeName(12));
        assertEquals("unknown(-1)", ReadSupport.nbtTypeName(-1));
    }

    /** 无 NBT 时摘要为 null（不制造空壳摘要——「没有 NBT」与「空 NBT」要分得开）。 */
    @Test
    public void nbtSummaryOfNullIsNull() {
        assertNull(ReadSupport.nbtSummary(null));
    }

    // ------------------------------------------------------------ diff 种类

    /** 完全一致时报空 kinds。 */
    @Test
    public void diffKindsEmptyWhenEqual() {
        JsonObject want = wanted(1, 0);
        JsonObject actual = actual(1, 0);
        assertEquals(
            0,
            ReadDiffAction.diffKinds(want, actual)
                .size());
    }

    /** blockId 不同与 meta 不同必须能分开报（两类根因不同）。 */
    @Test
    public void diffKindsDistinguishBlockIdFromMeta() {
        JsonArray idOnly = ReadDiffAction.diffKinds(wanted(1, 0), actual(2, 0));
        assertEquals(1, idOnly.size());
        assertEquals(
            "blockId",
            idOnly.get(0)
                .getAsString());

        JsonArray metaOnly = ReadDiffAction.diffKinds(wanted(1, 0), actual(1, 7));
        assertEquals(1, metaOnly.size());
        assertEquals(
            "meta",
            metaOnly.get(0)
                .getAsString());

        JsonArray both = ReadDiffAction.diffKinds(wanted(1, 0), actual(2, 7));
        assertEquals(2, both.size());
    }

    // ------------------------------------------------------------ 自描述完备性（D1/D3 的机读前提）

    /**
     * 每个读面动作的自描述必须六要素齐备：名称、权限级、逐参数（名/类型/必填/说明）、
     * 返回结构、可复制示例、since。
     *
     * <p>
     * 这是 D1/D3 的<b>离线可判定</b>那一半：自述端点（{@code GET /cp/v1/actions}）从同一份
     * {@code ActionDescriptor} 渲染，因此这里绿而端点红是不可能的形态。
     * 端点上再逐动作比一遍是实机验收的事（见证据里的自述 dump）。
     */
    @Test
    public void readActionDescriptorsAreComplete() {
        com.lightning.mod.client.controlplane.core.ActionRegistry registry = new com.lightning.mod.client.controlplane.core.ActionRegistry();
        com.lightning.mod.client.controlplane.mc.ActionRegistrar.registerAll(null, registry);

        String[] readActions = { ReadBlocksAction.NAME, ReadOverviewAction.NAME, ReadPlayerAction.NAME,
            ReadInventoryAction.NAME, ReadTeAction.NAME, ReadBlockInfoAction.NAME, ReadDiffAction.NAME,
            ReadRunAction.NAME };
        for (String name : readActions) {
            com.lightning.mod.client.controlplane.core.ActionDescriptor d = registry.descriptor(name);
            assertNotNull("读面动作必须已注册: " + name, d);
            assertEquals(
                "读面动作必须是 observe 级: " + name,
                com.lightning.mod.client.controlplane.core.Tier.OBSERVE,
                d.tier());
            assertFalse("observe 级不该要求 confirm: " + name, d.writable());
            assertNotNull(name + " 缺 description", d.description());
            assertFalse(
                name + " description 为空",
                d.description()
                    .trim()
                    .isEmpty());
            // 描述要说出「只读」——这是调用方判断能不能在捕获会话里调它的依据
            assertTrue(
                name + " description 未声明只读语义",
                d.description()
                    .contains("只读"));
            assertNotNull(name + " 缺 returns", d.returns());
            assertFalse(
                name + " returns 为空",
                d.returns()
                    .trim()
                    .isEmpty());
            assertNotNull(name + " 缺 since", d.since());
            assertEquals(name + " since 应为 1.3（读面引入版本）", "1.3", d.since());
            assertNotNull(name + " 缺 examples", d.examples());
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
            }
            for (com.lightning.mod.client.controlplane.core.ActionDescriptor.Param p : d.params()) {
                assertNotNull(name + "." + p.name() + " 缺参数名", p.name());
                assertNotNull(name + "." + p.name() + " 缺参数类型", p.type());
                assertNotNull(name + "." + p.name() + " 缺参数说明", p.description());
                assertFalse(
                    name + "." + p.name() + " 参数说明为空",
                    p.description()
                        .trim()
                        .isEmpty());
            }
        }
        // 逐动作都有示例 JSON 可解析（示例是「无先验知识调用方」的唯一素材，写错等于没有）
        for (String name : readActions) {
            com.lightning.mod.client.controlplane.core.ActionDescriptor d = registry.descriptor(name);
            for (int i = 0; i < d.examples()
                .size(); i++) {
                String text = Json.toJson(
                    d.examples()
                        .get(i));
                Json.parseStrictObject(text);
            }
        }
    }

    /** D3：默认值必须以机读的 default 字段出现（不是只写在说明文字里）。 */
    @Test
    public void readActionDefaultsAreMachineReadable() {
        com.lightning.mod.client.controlplane.core.ActionRegistry registry = new com.lightning.mod.client.controlplane.core.ActionRegistry();
        com.lightning.mod.client.controlplane.mc.ActionRegistrar.registerAll(null, registry);

        // 逐个核对读面里「有默认行为」的参数：自述必须写 default，且值与实现取的一致
        assertDefault(registry, ReadBlocksAction.NAME, "includeAir", Boolean.TRUE);
        assertDefault(registry, ReadBlocksAction.NAME, "hash", Boolean.TRUE);
        assertDefault(registry, ReadOverviewAction.NAME, "entities", Boolean.TRUE);
        assertDefault(registry, ReadOverviewAction.NAME, "topEntityTypes", Integer.valueOf(10));
        assertDefault(registry, ReadInventoryAction.NAME, "source", ReadInventoryAction.SOURCE_PLAYER);
        assertDefault(registry, ReadInventoryAction.NAME, "includeEmpty", Boolean.TRUE);
        assertDefault(registry, ReadInventoryAction.NAME, "nbtMaxEntries", Integer.valueOf(24));
        assertDefault(registry, ReadTeAction.NAME, "includeNbt", Boolean.TRUE);
        // 读面完备性（2026-10-09 实机）：默认限深 3 时 EIO 的逐面状态（第 4 层）读不到 ⇒ 加了这两个参数；
        // 自述里的默认值必须与 ReadSupport 的常量一致，否则「默认值」这层承诺就是假的
        assertDefault(registry, ReadTeAction.NAME, "nbtDepth", Integer.valueOf(ReadSupport.NBT_MAX_DEPTH));
        assertDefault(registry, ReadTeAction.NAME, "nbtMaxEntries", Integer.valueOf(ReadSupport.NBT_MAX_ENTRIES));
        assertDefault(registry, ReadBlockInfoAction.NAME, "meta", Integer.valueOf(0));
        assertDefault(registry, ReadDiffAction.NAME, "maxChanges", Integer.valueOf(4096));
        assertDefault(registry, ReadRunAction.NAME, "limit", Integer.valueOf(ReadRunAction.DEFAULT_LIMIT));
    }

    /** 无默认值的参数不得凭空写 default（写了就是骗调用方）。 */
    @Test
    public void readActionRequiredParamsHaveNoDefault() {
        com.lightning.mod.client.controlplane.core.ActionRegistry registry = new com.lightning.mod.client.controlplane.core.ActionRegistry();
        com.lightning.mod.client.controlplane.mc.ActionRegistrar.registerAll(null, registry);
        for (String action : new String[] { ReadBlocksAction.NAME }) {
            for (com.lightning.mod.client.controlplane.core.ActionDescriptor.Param p : registry.descriptor(action)
                .params()) {
                if (p.required()) {
                    assertNull(action + "." + p.name() + " 是必填，不该有 default", p.defaultValue());
                }
            }
        }
    }

    // ------------------------------------------------------------ 常量口径

    /** 区域上限与既有校验器的世界边界同口径（两处写死不同值会让「合法请求被拒」变成随机行为）。 */
    @Test
    public void regionLimitsMatchValidatorConventions() {
        assertEquals(com.lightning.mod.client.controlplane.core.CaseValidator.MIN_Y, ReadSupport.MIN_Y);
        assertEquals(com.lightning.mod.client.controlplane.core.CaseValidator.MAX_Y, ReadSupport.MAX_Y);
        assertEquals(
            com.lightning.mod.client.controlplane.core.CaseValidator.MAX_HORIZONTAL,
            ReadSupport.MAX_HORIZONTAL);
        assertEquals(com.lightning.mod.client.controlplane.core.CaseValidator.MAX_META, ReadSupport.MAX_META);
    }

    /** 方位表与 MC 的 yaw→方位映射同口径（yaw=0 朝 +Z = south）。 */
    @Test
    public void facingTableMatchesMinecraftConvention() {
        assertEquals("south", ReadSupport.FACINGS[0]);
        assertEquals("west", ReadSupport.FACINGS[1]);
        assertEquals("north", ReadSupport.FACINGS[2]);
        assertEquals("east", ReadSupport.FACINGS[3]);
    }

    // ------------------------------------------------------------ 工具

    private static void assertDefault(com.lightning.mod.client.controlplane.core.ActionRegistry registry, String action,
        String param, Object expected) {
        com.lightning.mod.client.controlplane.core.ActionDescriptor d = registry.descriptor(action);
        assertNotNull("动作未注册: " + action, d);
        com.lightning.mod.client.controlplane.core.ActionDescriptor.Param found = null;
        for (com.lightning.mod.client.controlplane.core.ActionDescriptor.Param p : d.params()) {
            if (param.equals(p.name())) {
                found = p;
                break;
            }
        }
        assertNotNull(action + " 缺参数 " + param, found);
        assertNotNull(action + "." + param + " 缺 default（D3：默认值必须可见）", found.defaultValue());
        // 比 JsonElement 而不是 toString()：字符串默认值在 JSON 里带引号，字符串比较会假红
        com.google.gson.JsonElement want;
        if (expected instanceof Boolean) {
            want = new com.google.gson.JsonPrimitive((Boolean) expected);
        } else if (expected instanceof Number) {
            want = new com.google.gson.JsonPrimitive((Number) expected);
        } else {
            want = new com.google.gson.JsonPrimitive(String.valueOf(expected));
        }
        assertEquals(
            action + "." + param + " 的 default 与实现取值不一致（期望 " + Json.toJson(want) + "）",
            want,
            found.defaultValue());
    }

    private static JsonArray pos(int x, int y, int z) {
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(x));
        a.add(new JsonPrimitive(y));
        a.add(new JsonPrimitive(z));
        return a;
    }

    private static JsonObject block(int x, int y, int z, int blockId, int meta) {
        JsonObject o = new JsonObject();
        o.add("pos", pos(x, y, z));
        o.addProperty("blockId", blockId);
        o.addProperty("meta", meta);
        return o;
    }

    private static JsonObject wanted(int blockId, int meta) {
        JsonObject o = new JsonObject();
        o.addProperty("blockId", blockId);
        o.addProperty("meta", meta);
        return o;
    }

    private static JsonObject actual(int blockId, int meta) {
        JsonObject o = new JsonObject();
        o.addProperty("blockId", blockId);
        o.addProperty("meta", meta);
        return o;
    }
}
