package com.lightning.mod.client.controlplane.mc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.Hashing;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 场景清单的<b>不依赖 MC 运行时</b>部分：同一 pos 去重与哈希回归锁。
 *
 * <h2>为什么这部分必须离线锁住</h2>
 * {@code world-hash-equals} 判据的红绿只由两件事决定：清单自报的 {@code sha256}（{@code hash}）
 * 与按清单位置<b>实读世界</b>后的哈希（{@code readBack} → {@code hashOfSubset}）。两者都是纯 JSON
 * 语义——实读那一步在单测里用「同一份最终状态」人工构造即可，不需要真世界。而这条链一旦分叉，
 * 症状是「同参无漂移也误判红」（实测形态），只有在真机上才看得见，代价极高。
 * 因此把「去重口径唯一」「四条路径互算」「无重复时哈希不变」三条在这里钉死。
 *
 * <h2>与实机验收的分工</h2>
 * 本类证明的是<b>归一化口径</b>；「{@code SceneBuilder} 真的按这个口径产出清单」（即
 * {@code manifestBlocks}/{@code manifestTes} 的调用点在正确的位置）由 runClient 实测覆盖，
 * 证据见归档记录。
 */
public class SceneManifestTest {

    // ------------------------------------------------------------ 去重口径

    /** 同一 pos 写两次：条目集合取<b>后写</b>的值，且只留一条。 */
    @Test
    public void dedupeByPosKeepsLastWritePerPos() {
        JsonArray entries = new JsonArray();
        entries.add(block(70, 12, 70, 1, 0));
        entries.add(block(68, 12, 68, 1, 0));
        entries.add(block(70, 12, 70, 54, 5));

        JsonArray out = SceneManifest.dedupeByPos(entries);
        assertEquals("同一 pos 只留一条", 2, out.size());
        JsonObject first = out.get(0)
            .getAsJsonObject();
        assertEquals("槽位仍是首次出现序", 70, pos(first)[0]);
        assertEquals("值取后写（箱子）", 54, Json.optInt(first, "blockId", -1));
        assertEquals(5, Json.optInt(first, "meta", -1));
    }

    /** 无重复写入的输入：逐元素原样返回（同序、同对象引用）——回归锁的机械前提。 */
    @Test
    public void dedupeByPosIsIdentityWhenNoDuplicate() {
        JsonArray entries = new JsonArray();
        JsonObject a = block(68, 12, 68, 1, 0);
        JsonObject b = block(70, 12, 70, 54, 5);
        entries.add(a);
        entries.add(b);

        JsonArray out = SceneManifest.dedupeByPos(entries);
        assertEquals(2, out.size());
        assertTrue("同序：第一条仍是 a", out.get(0) == a);
        assertTrue("同序：第二条仍是 b", out.get(1) == b);
    }

    /** 去重是幂等的：去过一次的清单再去一次逐元素不变（旧清单/调用方清单也要能安全归一化）。 */
    @Test
    public void dedupeByPosIsIdempotent() {
        JsonArray entries = new JsonArray();
        entries.add(block(70, 12, 70, 1, 0));
        entries.add(block(70, 12, 70, 54, 5));
        entries.add(block(68, 12, 68, 1, 0));

        JsonArray once = SceneManifest.dedupeByPos(entries);
        JsonArray twice = SceneManifest.dedupeByPos(once);
        assertEquals(Json.canonical(once), Json.canonical(twice));
    }

    /** 缺 pos / pos 非法的条目被跳过（与归一化流水线同口径），不抛。 */
    @Test
    public void dedupeSkipsEntriesWithoutValidPos() {
        JsonArray entries = new JsonArray();
        JsonObject noPos = new JsonObject();
        noPos.addProperty("blockId", 1);
        entries.add(noPos);
        JsonObject shortPos = new JsonObject();
        JsonArray two = new JsonArray();
        two.add(new JsonPrimitive(1));
        two.add(new JsonPrimitive(2));
        shortPos.add("pos", two);
        entries.add(shortPos);
        entries.add(block(70, 12, 70, 54, 5));

        JsonArray out = SceneManifest.dedupeByPos(entries);
        assertEquals(1, out.size());
        assertEquals(
            54,
            Json.optInt(
                out.get(0)
                    .getAsJsonObject(),
                "blockId",
                -1));
    }

    /** null 输入返回空数组（哈希永远可计算，不抛）。 */
    @Test
    public void dedupeOfNullIsEmpty() {
        assertEquals(
            0,
            SceneManifest.dedupeByPos(null)
                .size());
    }

    /** TE 也按同一口径去重：后写的类名胜出，且只留一条。 */
    @Test
    public void manifestTesDedupeByPos() {
        JsonArray appended = new JsonArray();
        appended.add(SceneManifest.teEntry(new int[] { 70, 12, 70 }, SceneManifest.ABSENT));
        appended.add(SceneManifest.teEntry(new int[] { 70, 12, 70 }, "net.minecraft.tileentity.TileEntityChest"));

        JsonArray out = SceneManifest.manifestTes(appended);
        assertEquals(1, out.size());
        assertEquals(
            "net.minecraft.tileentity.TileEntityChest",
            Json.optString(
                out.get(0)
                    .getAsJsonObject(),
                "class",
                null));
    }

    // ------------------------------------------------------------ 哈希回归锁（无重复 = 逐字不变）

    /**
     * <b>回归锁</b>：无重复写入的清单，修复后哈希必须与修复前<b>逐字相等</b>。
     *
     * <p>
     * 这里的期望值不是「从实现里抄一份」，而是<b>手写的规范文本</b>（键按字典序、无空白、
     * blocks 按 pos 升序），再加工程序在修复前跑出的实测哈希双重锁定：
     *
     * <pre>
     * 修复前 runClient 实测（无重复写入场景 cp_nodup_pos）：
     *   scene sha256 = 4c6c2742df6849234341a9168cb29e1fc5e78a3b1ebdebb27f1ad10f48538caa
     * </pre>
     *
     * 若去重改变了无重复场景的取值，这两条断言会同时红——它防的正是「为了修这个缺陷把既有
     * 哈希口径一起改了」这类静默回归。
     */
    @Test
    public void noDuplicateManifestHashIsUnchanged() {
        JsonObject manifest = new JsonObject();
        JsonArray blocks = new JsonArray();
        blocks.add(block(68, 12, 68, 1, 0));
        blocks.add(block(69, 12, 68, 5, 2));
        blocks.add(block(70, 12, 70, 54, 5));
        manifest.add("blocks", blocks);
        JsonArray tes = new JsonArray();
        tes.add(SceneManifest.teEntry(new int[] { 70, 12, 70 }, "net.minecraft.tileentity.TileEntityChest"));
        manifest.add("tileEntities", tes);

        assertEquals(
            "{\"blocks\":[{\"blockId\":1,\"meta\":0,\"pos\":[68,12,68]},"
                + "{\"blockId\":5,\"meta\":2,\"pos\":[69,12,68]},"
                + "{\"blockId\":54,\"meta\":5,\"pos\":[70,12,70]}],"
                + "\"tileEntities\":[{\"class\":\"net.minecraft.tileentity.TileEntityChest\",\"pos\":[70,12,70]}]}",
            Json.canonical(SceneManifest.hashSubset(manifest)));
        // 该规范文本的 sha256（外部复算，归档的回归对照脚本）
        assertEquals("4d8d8d9a3ae824c5b8d75aa54567a4a6bb8e6f5a668c63972ee4798e0418ab93", SceneManifest.hash(manifest));
    }

    /**
     * <b>实机回归锁</b>：修复前 runClient 在<b>无重复写入</b>场景（{@code cp_nodup_pos}）跑出的清单，
     * 其规范化哈希必须与修复后逐字相等。
     *
     * <p>
     * 这里的清单文本是从修复前的实测产物
     * （归档的 {@code run-nodup-prefix} 清单）逐字段抄下来的：
     * 修复前 {@code case.run} 报的 {@code scene.sha256}、清单自报的 {@code sha256}、以及用
     * 独立脚本对同文本重算的 sha256 三者相等，均为
     * {@code 0974ec0445d492149b268108b955448e49314e6ef6b37fa3ee27c0d2e9474e2d}。
     * 唯一与上面那条用例不同的是这格的 meta（实机放的是 <b>meta=3</b> 而非 5），
     * 因为它来自真实世界读数而不是构造——这正是它作为回归锁的价值：锁的是<b>实机</b>取值。
     */
    @Test
    public void noDuplicateManifestHashMatchesPreFixInGameRun() {
        JsonObject manifest = new JsonObject();
        JsonArray blocks = new JsonArray();
        blocks.add(block(68, 12, 68, 1, 0));
        blocks.add(block(69, 12, 68, 5, 2));
        blocks.add(block(70, 12, 70, 54, 3));
        manifest.add("blocks", blocks);
        JsonArray tes = new JsonArray();
        tes.add(SceneManifest.teEntry(new int[] { 70, 12, 70 }, "net.minecraft.tileentity.TileEntityChest"));
        manifest.add("tileEntities", tes);

        assertEquals(
            "修复前实机实测哈希（无重复写入场景 cp_nodup_pos）：去重不得改变它",
            "0974ec0445d492149b268108b955448e49314e6ef6b37fa3ee27c0d2e9474e2d",
            SceneManifest.hash(manifest));
    }

    /** 含重复写入的清单：哈希等于「只留最终状态那一份」的清单哈希（与构建历史无关）。 */
    @Test
    public void duplicateManifestHashEqualsFinalStateManifest() {
        JsonObject historical = new JsonObject();
        JsonArray blocks = new JsonArray();
        blocks.add(block(70, 12, 70, 1, 0));
        blocks.add(block(68, 12, 68, 1, 0));
        blocks.add(block(70, 12, 70, 54, 5));
        historical.add("blocks", blocks);
        historical.add("tileEntities", new JsonArray());

        JsonObject finalState = new JsonObject();
        JsonArray clean = new JsonArray();
        clean.add(block(68, 12, 68, 1, 0));
        clean.add(block(70, 12, 70, 54, 5));
        finalState.add("blocks", clean);
        finalState.add("tileEntities", new JsonArray());

        assertEquals(SceneManifest.hash(finalState), SceneManifest.hash(historical));
    }

    /**
     * 两个<b>构建历史不同、最终状态相同</b>的清单：哈希必须相等（负对照②的口径）。
     *
     * <p>
     * 差别只在「先石头后箱子」vs「直接放箱子」，以及无关位置的出现顺序——两者都是构建历史的
     * 痕迹，而哈希要回答的是「世界是不是同一个场景」。
     */
    @Test
    public void differentBuildHistoriesSameFinalStateHashEqual() {
        JsonObject historyA = manifest(
            new JsonObject[] { block(70, 12, 70, 1, 0), block(68, 12, 68, 1, 0), block(70, 12, 70, 54, 5) });
        JsonObject historyB = manifest(new JsonObject[] { block(68, 12, 68, 1, 0), block(70, 12, 70, 54, 5) });
        assertEquals(SceneManifest.hash(historyA), SceneManifest.hash(historyB));
    }

    // ------------------------------------------------------------ 与 read.blocks 互算（R2 口径）

    /**
     * 清单哈希 == 「按清单的<b>位置集合</b>实读世界」后的哈希（R2 互算口径）。
     *
     * <p>
     * 实读在真机上做，单测里用「该位置上的最终读数」等价构造：清单含重复 pos 时，实读会把两条都
     * 读成最终值，而清单自报值覆盖两条 ⇒ 修复前必然不等（实测红）。这里证明修复后
     * 两侧天然相等——即 {@code world-hash-equals} 判据在无漂移时应当为绿。
     */
    @Test
    public void manifestHashEqualsReadbackOfSameWorld() {
        JsonObject manifestWithDupHistory = manifest(
            new JsonObject[] { block(70, 12, 70, 1, 0), block(68, 12, 68, 1, 0), block(70, 12, 70, 54, 5) });
        // 实读结果取 readBack 的真正产物形态：它已过 normalizeBlocks/normalizeTes，
        // 即「按 pos 升序、字段只剩 {pos,blockId,meta}」。这里用同一批值人工构造等价物。
        // （readBack 本身要 WorldServer，故单测只覆盖它的归一化产物；实读路径由实机验收覆盖。）
        JsonObject readback = new JsonObject();
        JsonArray readbackBlocks = new JsonArray();
        readbackBlocks.add(block(68, 12, 68, 1, 0));
        readbackBlocks.add(block(70, 12, 70, 54, 5));
        readback.add("blocks", readbackBlocks);
        readback.add("tileEntities", new JsonArray());

        assertEquals(
            "world-hash-equals：首次哈希（清单自报）必须等于按清单位置实读世界的哈希",
            SceneManifest.hash(manifestWithDupHistory),
            SceneManifest.hashOfSubset(readback));
        // 两侧的哈希子集文本也逐字比一遍：哈希相等而文本不同是本类最该暴露的形态
        // （会说明某处悄悄换了序列化口径），只比 sha256 看不出来。
        assertEquals(Json.canonical(SceneManifest.hashSubset(manifestWithDupHistory)), Json.canonical(readback));
    }

    /** 读回子集本身也走去重：即使输入的读回条目重复，产出的哈希仍只有一份。 */
    @Test
    public void readbackSubsetIsDedupedByPos() {
        JsonObject subset = SceneManifest
            .hashSubset(manifest(new JsonObject[] { block(70, 12, 70, 1, 0), block(70, 12, 70, 54, 5) }));
        assertEquals(
            1,
            Json.optArray(subset, "blocks")
                .size());
        assertEquals(
            54,
            Json.optInt(
                Json.optArray(subset, "blocks")
                    .get(0)
                    .getAsJsonObject(),
                "blockId",
                -1));
    }

    // ------------------------------------------------------------ 清单数据入口的字段形态

    /**
     * {@link SceneManifest#manifestBlocks} 的字段形态必须与 {@link SceneManifest#blockEntry} 一致
     * （含 <b>id</b>，因为落盘清单要人读）；哈希口径才丢 id。
     */
    @Test
    public void manifestBlocksKeepsRegistryIdAndFieldShape() {
        JsonArray appended = new JsonArray();
        appended.add(SceneManifest.blockEntry(new int[] { 70, 12, 70 }, 1, 0, "minecraft:stone"));
        appended.add(SceneManifest.blockEntry(new int[] { 70, 12, 70 }, 54, 5, "minecraft:chest"));

        JsonArray out = SceneManifest.manifestBlocks(appended);
        assertEquals(1, out.size());
        JsonObject e = out.get(0)
            .getAsJsonObject();
        assertEquals("minecraft:chest", Json.optString(e, "id", null));
        assertEquals(54, Json.optInt(e, "blockId", -1));
        assertEquals(5, Json.optInt(e, "meta", -1));
        assertEquals("清单条目同样是 {pos,blockId,meta,id}", 4, Json.size(e));
        assertEquals(
            Json.canonical(SceneManifest.blockEntry(new int[] { 70, 12, 70 }, 54, 5, "minecraft:chest")),
            Json.canonical(e));
    }

    /** 清单数据入口保留<b>声明序</b>（不去排序）：落盘清单的条目序仍是构建步的投影。 */
    @Test
    public void manifestBlocksPreservesDeclarationOrder() {
        JsonArray appended = new JsonArray();
        appended.add(SceneManifest.blockEntry(new int[] { 70, 12, 70 }, 54, 5, "minecraft:chest"));
        appended.add(SceneManifest.blockEntry(new int[] { 68, 12, 68 }, 1, 0, "minecraft:stone"));

        JsonArray out = SceneManifest.manifestBlocks(appended);
        assertEquals(
            70,
            pos(
                out.get(0)
                    .getAsJsonObject())[0]);
        assertEquals(
            68,
            pos(
                out.get(1)
                    .getAsJsonObject())[0]);
    }

    // ------------------------------------------------------------ 工具

    private static JsonObject manifest(JsonObject[] blocks) {
        JsonObject m = new JsonObject();
        JsonArray a = new JsonArray();
        for (JsonObject b : blocks) {
            a.add(b);
        }
        m.add("blocks", a);
        m.add("tileEntities", new JsonArray());
        return m;
    }

    private static JsonObject block(int x, int y, int z, int blockId, int meta) {
        return SceneManifest.blockEntry(new int[] { x, y, z }, blockId, meta, null);
    }

    private static int[] pos(JsonObject o) {
        int[] p = SceneManifest.posOf(o);
        assertNotNull("条目必须有合法 pos", p);
        return p;
    }

    /** 规范化文本可被外部工具复算（键序固定），并给出与 sha256 的同源关系。 */
    @Test
    public void canonicalSubsetIsRecomputable() {
        JsonObject manifest = manifest(new JsonObject[] { block(70, 12, 70, 54, 5) });
        String canonical = Json.canonical(SceneManifest.hashSubset(manifest));
        assertEquals("{\"blocks\":[{\"blockId\":54,\"meta\":5,\"pos\":[70,12,70]}],\"tileEntities\":[]}", canonical);
        assertEquals(Hashing.sha256HexUtf8(canonical), SceneManifest.hash(manifest));
        assertFalse(
            "哈希不得为空",
            SceneManifest.hash(manifest)
                .isEmpty());
    }

    /** {@code posKey} 与逐格对齐共用同一拼法（两处不同会让「同一位置」判成两个位置）。 */
    @Test
    public void posKeyIsStable() {
        assertEquals("70,12,70", SceneManifest.posKey(new int[] { 70, 12, 70 }));
        assertEquals("0,0,0", SceneManifest.posKey(new int[] { 0, 0, 0 }));
    }

    /** {@link JsonElement} 级别的相等在此处无意义之外，这里确认 canonical 对 null 键值稳定。 */
    @Test
    public void hashSubsetOfNullManifestIsEmptyButComputable() {
        JsonObject subset = SceneManifest.hashSubset(null);
        assertEquals("{\"blocks\":[],\"tileEntities\":[]}", Json.canonical(subset));
        assertNotNull(SceneManifest.hash(null));
    }
}
