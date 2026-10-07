package com.lightning.mod.client.controlplane.mc.scene;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;
import com.lightning.mod.client.controlplane.mc.GtFluids;

/**
 * #122（L0 流体注入原语 {@code scene.tank.fill}）中<b>不依赖 MC/GT 运行时</b>的那部分逻辑的单测。
 *
 * <h2>为什么只能测这部分</h2>
 * 注入本体要碰 {@code WorldServer}/{@code IFluidHandler}/{@code FluidStack}，本仓 mod 无世界环境的
 * 单测能力（contract.md §9 的分层理由），因此实注路径由实机覆盖。但三件事必须离线锁死，
 * 否则实机轮只会把参数笔误当成「GT 坏了」：
 * <ul>
 * <li><b>参数解析与全部错误路径</b>（{@link TankFillSpec}）——未知面、越界量、缺 fluid/amount、
 * 非整数，逐条显式失败（契约 §1.5「失败显式」）；</li>
 * <li><b>流体名规范化</b>（{@link GtFluids#normalize}）——{@code HydrochloricAcid} /
 * {@code hydrochloricacid_gt5u} / {@code Hydrochloric Acid} 必须归一到同一个键。
 * 这条是「用例写自然名也能命中 GT 的注册名」的<b>唯一</b>依据：GT 给撞名材料加了 {@code _GT5U}
 * 后缀（{@code MaterialsInit.java:8215}），不剥后缀就永远差一个后缀；</li>
 * <li><b>槽位条目的 material+prefix 口径</b>（{@link SlotSpec}）——#122 联证要往机器里投
 * {@code dust × Silicon} 与 {@code cell × Empty}，而 {@code ItemList} 里没有这些常量。
 * 它与 id/battery/meta 的互斥是「不许自算 meta」这条纪律的可执行形式。</li>
 * </ul>
 *
 * <h2>为什么自描述也要断言</h2>
 * 「没有自描述的动作视为不存在」（需求书 §8.1）：{@code since}/{@code returns}/示例缺一项，
 * 无先验知识的调用方就调不出来。{@code since} 必须是 <b>1.6</b>（本动作的引入版本），
 * 且契约版本必须 ≥ 它——否则目录自相矛盾（D1/D3 判红）。
 */
public class TankFillFamilyTest {

    // ------------------------------------------------------------ 参数解析：正常路径

    /** 最小可用输入：at + fluid + amount（side 有默认值 UP）。 */
    @Test
    public void minimalInputParsesWithDefaultSide() {
        TankFillSpec.Spec s = TankFillSpec.parse(params("HydrochloricAcid", 3000, null));
        assertEquals("HydrochloricAcid", s.fluid);
        assertEquals(3000, s.amount);
        assertEquals("缺省注入面是 UP", 1, s.sideOrdinal);
        assertTrue(
            s.describe(),
            s.describe()
                .contains("HydrochloricAcid"));
    }

    /** 显式注入面：大小写不敏感，ordinal 与 ForgeDirection 同序。 */
    @Test
    public void explicitSideIsCaseInsensitive() {
        assertEquals(0, TankFillSpec.parse(params("F", 1, "down")).sideOrdinal);
        assertEquals(5, TankFillSpec.parse(params("F", 1, "EAST")).sideOrdinal);
        assertEquals(2, TankFillSpec.parse(params("F", 1, "north")).sideOrdinal);
    }

    /** 面表下标必须与 {@code ForgeDirection} 的 ordinal 同序（0=DOWN、1=UP…）。 */
    @Test
    public void sideTableMatchesForgeDirectionOrdinals() {
        assertEquals("DOWN", TankFillSpec.SIDE_NAMES[0]);
        assertEquals("UP", TankFillSpec.SIDE_NAMES[1]);
        assertEquals("NORTH", TankFillSpec.SIDE_NAMES[2]);
        assertEquals("SOUTH", TankFillSpec.SIDE_NAMES[3]);
        assertEquals("WEST", TankFillSpec.SIDE_NAMES[4]);
        assertEquals("EAST", TankFillSpec.SIDE_NAMES[5]);
        assertEquals(-1, TankFillSpec.sideOrdinal("SIDEWAYS"));
        assertEquals(-1, TankFillSpec.sideOrdinal(null));
        assertEquals("UP", TankFillSpec.sideName(99));
    }

    // ------------------------------------------------------------ 参数解析：错误路径（逐条显式）

    /**
     * {@code amount} 无默认值：缺失必须显式失败。
     *
     * <p>
     * 这条是「失败显式」的核心一条：给个默认量会让「漏写」静默变成一次真实注入，
     * 而读回看起来完全正常——假绿。
     */
    @Test
    public void missingAmountFailsExplicitly() {
        CpException e = expectParam(() -> TankFillSpec.parse(params("HydrochloricAcid", null, null)));
        assertTrue("未说清为什么没有默认值: " + e.getMessage(), ctxText(e).contains("默认"));
    }

    /** {@code fluid} 缺失必须显式失败（默认成水/空气会污染机器状态且不可逆）。 */
    @Test
    public void missingFluidFailsExplicitly() {
        CpException e = expectParam(() -> TankFillSpec.parse(params(null, 1000, null)));
        assertTrue(ctxText(e).contains("fluid"));
    }

    /** 空参数：两条必填都要报出来（不逐个试错）。 */
    @Test
    public void emptyParamsReportBothRequiredFields() {
        CpException e = expectParam(() -> TankFillSpec.parse(new JsonObject()));
        String all = ctxText(e);
        assertTrue("未报 fluid: " + all, all.contains("fluid"));
        assertTrue("未报 amount: " + all, all.contains("amount"));
    }

    /** null 参数走同一条显式失败（不是 NPE）。 */
    @Test
    public void nullParamsFailExplicitly() {
        expectParam(() -> TankFillSpec.parse(null));
    }

    /** 量越界 / 非整数 / 非数字 / 字符串：四种都显式失败，不静默取默认值。 */
    @Test
    public void illegalAmountFailsExplicitly() {
        expectParam(() -> TankFillSpec.parse(params("F", 0, null)));
        expectParam(() -> TankFillSpec.parse(params("F", -1, null)));
        expectParam(() -> TankFillSpec.parse(params("F", TankFillSpec.MAX_AMOUNT + 1, null)));
        expectParam(() -> TankFillSpec.parse(params("F", 1.5d, null)));
        JsonObject p = params("F", null, null);
        p.addProperty("amount", "3000");
        expectParam(() -> TankFillSpec.parse(p));
    }

    /** 未知注入面：显式失败并列出可用取值。 */
    @Test
    public void unknownSideFailsExplicitly() {
        CpException e = expectParam(() -> TankFillSpec.parse(params("F", 1, "SIDEWAYS")));
        assertTrue(ctxText(e).contains("DOWN"));
        assertTrue(ctxText(e).contains("EAST"));
    }

    /** 量上界在自述里机读可见（D3：默认/边界值可见），且与实现常量同源。 */
    @Test
    public void amountBoundIsVisibleInSelfDescription() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor(TankFillAction.NAME);
        assertNotNull(d);
        ActionDescriptor.Param amount = param(d, TankFillSpec.PARAM_AMOUNT);
        assertNotNull("自述里没有 amount 参数", amount);
        assertTrue(
            "amount 说明里未写出上界 " + TankFillSpec.MAX_AMOUNT,
            amount.description()
                .contains(String.valueOf(TankFillSpec.MAX_AMOUNT)));
        ActionDescriptor.Param side = param(d, TankFillSpec.PARAM_SIDE);
        assertNotNull("自述里没有 side 参数", side);
        assertNotNull("side 缺省值未在自述里机读可见", side.defaultValue());
        assertEquals(
            "UP",
            side.defaultValue()
                .getAsString());
    }

    // ------------------------------------------------------------ 流体名规范化（GtFluids）

    /**
     * 三种写法归一：GT 注册名（带 {@code _gt5u} 后缀）、GT 材料名、带空格的本地化名。
     *
     * <p>
     * 这是「用例写 {@code HydrochloricAcid} 也能命中 {@code hydrochloricacid_gt5u}」的唯一依据。
     */
    @Test
    public void fluidNamesNormalizeToTheSameKey() {
        String want = GtFluids.normalize("HydrochloricAcid");
        assertEquals(want, GtFluids.normalize("hydrochloricacid_gt5u"));
        assertEquals(want, GtFluids.normalize("hydrochloric acid"));
        assertEquals(want, GtFluids.normalize("HydrochloricAcid_GT5U"));
        assertEquals("hydrochloricacid", want);
    }

    /**
     * 剥 {@code _GT5U} 后缀只剥「带下划线的那个字面量」，不碰裸 {@code gt5u} 结尾。
     *
     * <p>
     * GT 的后缀是 {@code _GT5U}（含下划线，{@code MaterialsInit.java:8215}）。
     * 若实现写成「剥末尾的 {@code gt5u}」，{@code xgt5u} 会被削成 {@code x}——
     * 削多了会让两个本来不同的流体撞成一个键（虽然后续报歧义，但那已是误报）。
     */
    @Test
    public void suffixStrippingRequiresTheUnderscore() {
        assertEquals("xgt5u", GtFluids.normalize("xgt5u"));
        assertEquals("gt5u", GtFluids.normalize("gt5u"));
        assertEquals("x", GtFluids.normalize("x_GT5U"));
        // 恰好等于后缀本身时剥成空串（不是合法的流体名，故不会命中任何注册项）
        assertEquals("", GtFluids.normalize("_GT5U"));
    }

    /** 分隔符与大小写一并归一（{@code minecraft:water} 与 {@code Water} 同键）。 */
    @Test
    public void separatorsAndCaseAreIgnored() {
        assertEquals(GtFluids.normalize("water"), GtFluids.normalize("minecraft:water"));
        assertEquals(GtFluids.normalize("water"), GtFluids.normalize("  WATER  "));
        assertEquals("water", GtFluids.normalize("minecraft:water"));
    }

    /** null / 空串归一为空键（调用方据此报「流体名为空」）。 */
    @Test
    public void nullAndEmptyNormalizeToEmptyKey() {
        assertEquals("", GtFluids.normalize(null));
        assertEquals("", GtFluids.normalize("   "));
    }

    /**
     * 空流体名报 {@code CP-VALID-002}，且<b>不</b>去碰注册表。
     *
     * <p>
     * 本仓离线单测没有 Forge 注册表环境，因此这里只断言错误形态（参数类 + 逐字段 context）——
     * 恰好也证明「空名的判定在查表之前」。
     */
    @Test
    public void emptyFluidNameFailsBeforeRegistryLookup() {
        CpException e = expectParam(() -> GtFluids.resolve("", "fluid"));
        assertTrue(ctxText(e).contains("fluid"));
        CpException e2 = expectParam(() -> GtFluids.resolve(null, "fluid"));
        assertNotNull(e2.context());
    }

    // ------------------------------------------------------------ 槽位条目：material + prefix（#122）

    /** material+prefix 解析：clear=false、id/battery 为空、material/prefix 就位。 */
    @Test
    public void materialEntryParses() {
        SlotSpec s = SlotSpec.parse(material(5, "Silicon", "dust", 1), "slots[0]");
        assertEquals(5, s.slot);
        assertFalse(s.clear);
        assertNull(s.id);
        assertNull(s.battery);
        assertEquals("Silicon", s.material);
        assertEquals("dust", s.prefix);
        assertEquals(1, s.count);
    }

    /** material ⟂ id：两者都自己决定物品。 */
    @Test
    public void materialConflictsWithId() {
        JsonObject e = material(5, "Silicon", "dust", 1);
        e.addProperty("id", "minecraft:stone");
        CpException ex = expectParam(() -> SlotSpec.parse(e, "slots[0]"));
        assertTrue(ctxText(ex).contains("material"));
    }

    /** material ⟂ battery：两者都自己决定物品。 */
    @Test
    public void materialConflictsWithBattery() {
        JsonObject e = material(5, "Silicon", "dust", 1);
        e.addProperty("battery", "Battery_RE_LV_Lithium");
        expectParam(() -> SlotSpec.parse(e, "slots[0]"));
    }

    /**
     * material ⟂ meta：meta 是「材料 + 形态」编码出来的 GT 实现细节，手写它等于绕过模组路径。
     *
     * <p>
     * 这条与 {@code charge ⟂ nbt} 同族：都是「不许逐字段拼模组状态」（契约 §6.4）。
     */
    @Test
    public void materialConflictsWithMeta() {
        JsonObject e = material(5, "Silicon", "dust", 1);
        e.addProperty("meta", 1234);
        CpException ex = expectParam(() -> SlotSpec.parse(e, "slots[0]"));
        assertTrue(ctxText(ex).contains("meta"));
    }

    /** material 缺 prefix：显式失败（形态是必填的一半）。 */
    @Test
    public void materialWithoutPrefixFailsExplicitly() {
        JsonObject e = material(5, "Silicon", null, 1);
        CpException ex = expectParam(() -> SlotSpec.parse(e, "slots[0]"));
        assertTrue(ctxText(ex).contains("prefix"));
    }

    /** prefix 缺 material：显式失败（形态必须配一个材料）。 */
    @Test
    public void prefixWithoutMaterialFailsExplicitly() {
        JsonObject e = new JsonObject();
        e.addProperty("slot", 5);
        e.addProperty("prefix", "dust");
        CpException ex = expectParam(() -> SlotSpec.parse(e, "slots[0]"));
        assertTrue(ctxText(ex).contains("material"));
    }

    /** material 条目仍走 count 域校验（与既有口径一致）。 */
    @Test
    public void materialEntryStillChecksCountRange() {
        expectParam(() -> SlotSpec.parse(material(5, "Silicon", "dust", 65), "slots[0]"));
        expectParam(() -> SlotSpec.parse(material(5, "Silicon", "dust", 0), "slots[0]"));
    }

    /** material 条目不是「清空」——没有 id 也不清空（否则配方输入会被静默清掉）。 */
    @Test
    public void materialEntryIsNotTreatedAsClear() {
        assertFalse(SlotSpec.parse(material(5, "Silicon", "dust", 1), "slots[0]").clear);
    }

    // ------------------------------------------------------------ 既有口径不收紧（回归）

    /** 既有口径不变：id 给 air 即清空；缺 id 且无 battery/material 也清空（与 #99 语义一致）。 */
    @Test
    public void clearSemanticsUnchanged() {
        JsonObject air = new JsonObject();
        air.addProperty("slot", 3);
        air.addProperty("id", "air");
        assertTrue(SlotSpec.parse(air, "s").clear);
        JsonObject noId = new JsonObject();
        noId.addProperty("slot", 3);
        assertTrue(SlotSpec.parse(noId, "s").clear);
    }

    /**
     * 既有口径不收紧：清空条目历来忽略 meta 的范围校验（旧实现直接返回 null、不做范围校验）。
     *
     * <p>
     * <b>#122 注意</b>：本单把 meta 的校验改成「只有显式给了 meta 才校验」，对<b>非清空</b>条目
     * 是行为收紧（原先 {@code meta} 缺省为 0 也会被校验一次，但 0 恒在域内，故实际等价）。
     * 这条测试锁住「清空条目给越界 meta 仍然合法」这一兼容性。
     */
    @Test
    public void clearEntryStillIgnoresMeta() {
        JsonObject e = new JsonObject();
        e.addProperty("slot", 3);
        e.addProperty("id", "air");
        e.addProperty("meta", 40000);
        assertTrue(SlotSpec.parse(e, "s").clear);
    }

    /** 既有口径不变：id+meta 越界仍报 CP-VALID-002。 */
    @Test
    public void idEntryMetaRangeStillChecked() {
        JsonObject bad = new JsonObject();
        bad.addProperty("slot", 0);
        bad.addProperty("id", "minecraft:torch");
        bad.addProperty("meta", 40000);
        expectParam(() -> SlotSpec.parse(bad, "s"));
    }

    /** battery ⟂ id 与 charge ⟂ nbt 两条 #117 纪律不受本单影响。 */
    @Test
    public void existingBatteryDisciplineUnchanged() {
        JsonObject b = new JsonObject();
        b.addProperty("slot", 1);
        b.addProperty("battery", "Battery_RE_LV_Lithium");
        b.addProperty("charge", "full");
        b.addProperty("id", "minecraft:stone");
        expectParam(() -> SlotSpec.parse(b, "s"));

        JsonObject c = new JsonObject();
        c.addProperty("slot", 1);
        c.addProperty("battery", "Battery_RE_LV_Lithium");
        c.addProperty("charge", "full");
        c.addProperty("nbt", "{GT.ItemCharge:1L}");
        CpException e = expectParam(() -> SlotSpec.parse(c, "s"));
        assertTrue(ctxText(e).contains("6.4") || ctxText(e).contains("回填"));
    }

    // ------------------------------------------------------------ 自描述与版本口径

    /** 动作名与权限级：{@code scene.tank.fill} 是 scene 级可写动作（必须带 confirm）。 */
    @Test
    public void tankFillIsRegisteredAtSceneTier() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor(TankFillAction.NAME);
        assertNotNull("scene.tank.fill 必须已注册", d);
        assertEquals("1.6", d.since());
        assertTrue("是 scene 级可写动作", d.writable());
        assertTrue(
            d.description(),
            d.description()
                .contains("L0"));
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
        assertTrue("契约版本 " + Contract.VERSION + " 必须 ≥ 本动作 since 1.6", Contract.VERSION.compareTo("1.6") >= 0);
    }

    /**
     * 自描述六要素齐备：名称、权限级、逐参数（名/类型/必填/说明）、返回结构、可复制示例、since。
     *
     * <p>
     * 另外断言 {@code returns} 里点出了 {@code partial} 与 {@code dryRunFillable}——
     * 这两个字段是「部分注入如实报告」与「零注入的原因区分」的机读落点，
     * 不写进自述，调用方就不知道该怎么读。
     */
    @Test
    public void tankFillDescriptorIsComplete() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor(TankFillAction.NAME);
        assertNotNull(d.description());
        assertFalse(
            d.description()
                .trim()
                .isEmpty());
        assertFalse(
            d.returns()
                .trim()
                .isEmpty());
        assertTrue(
            "returns 未声明 filled",
            d.returns()
                .contains("filled"));
        assertTrue(
            "returns 未声明 partial（部分注入如实报告）",
            d.returns()
                .contains("partial"));
        assertTrue(
            "returns 未声明 dryRunFillable",
            d.returns()
                .contains("dryRunFillable"));
        assertTrue(
            "returns 未声明 layer 字段（两义标注要靠它机读）",
            d.returns()
                .contains("layer"));
        assertNotNull(d.since());
        assertTrue(
            "至少给一条可复制示例",
            d.examples()
                .size() > 0);
        for (int i = 0; i < d.examples()
            .size(); i++) {
            assertTrue(
                "示例 " + i + " 必须是 JSON 对象",
                d.examples()
                    .get(i)
                    .isJsonObject());
            JsonObject ex = d.examples()
                .get(i)
                .getAsJsonObject();
            assertTrue("示例 " + i + " 缺 confirm:true（照抄会被 CP-CONFIRM-001 拒）", ex.has("confirm"));
            // 示例必须真的能被解析器接受（示例是「无先验知识调用方」的唯一素材）
            TankFillSpec.Spec parsed = TankFillSpec.parse(ex);
            assertNotNull(parsed);
        }
        for (ActionDescriptor.Param p : d.params()) {
            assertNotNull(p.name());
            assertNotNull(p.type());
            assertNotNull(p.description());
            assertFalse(
                p.description()
                    .trim()
                    .isEmpty());
        }
    }

    /**
     * {@code scene.inventory.write} 的自述必须写出 {@code material}/{@code prefix}（#122 追加的形态）
     * 并给一条可复制示例——否则联证里的配方输入投不进去。
     *
     * <p>
     * 同时锁「只增可选字段不改语义」：该动作的 {@code since} 仍为 1.3（#99 引入）。
     */
    @Test
    public void inventoryWriteSelfDescriptionCoversMaterialForm() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor("scene.inventory.write");
        assertNotNull(d);
        String desc = d.description();
        assertTrue("自述未提 material: " + desc, desc.contains("material"));
        assertTrue("自述未提 prefix: " + desc, desc.contains("prefix"));
        assertTrue("自述未说明 material 与 id/battery 互斥", desc.contains("互斥"));
        boolean sawExample = false;
        for (int i = 0; i < d.examples()
            .size(); i++) {
            String ex = Json.toJson(
                d.examples()
                    .get(i));
            Json.parseStrictObject(ex);
            if (ex.contains("material") && ex.contains("prefix")) {
                sawExample = true;
            }
        }
        assertTrue("缺一条 material+prefix 的可复制示例", sawExample);
        assertEquals("只增可选字段：动作的引入版本不动（#99 的 1.3）", "1.3", d.since());
    }

    // ------------------------------------------------------------ D-1：储罐单值读数的宿主
    //
    // #122 实机首轮证伪的缺陷 D-1：储罐单值读数（fluid/fluidAmount/容量）最初从「方块实体」
    // 反射取，而 getFluid/getFluidAmount 的宿主是 MetaTileEntity（MTEBasicTank.java:195,200），
    // 方块实体上根本没有；更坏的是方块实体上**确实有**一个 getCapacity()，但它返回
    // (int) min(MAX, getEUCapacity())（BaseMetaTileEntity.java:1997-1999），即 **EU 缓冲容量
    // 2048** 而不是储罐容量 16000——于是实机读出一个「看起来像储罐容量、实际是 EU 容量」的数字
    // （静默给错数，比缺席更坏）。
    //
    // 下面两条是**GT 源码事实核对**（不是行为测试）：它们对 GT 源码做文本断言，锁住
    // 「为什么必须从 MTE 读」这条推理的前提。本仓离线单测的 classpath 上没有 GT
    // （compileOnly 且只对 main 可见，见 build.gradle.kts），反射拿不到类，故只能查源码文本。
    //
    // **局限（如实标注）**：GT 源码不在本机时这两条跳过（return），不伪造结论。
    // 真正的行为回归锁是实机证据（temp/cp-tank-fill/evidence/21-readte-after-fill.json：
    // 修复前 fluidAmount=null / capacityGetter=2048；修复后 fluidAmount=3000 / capacityGetter=16000）。

    /**
     * {@code getFluid}/{@code getFluidAmount} 只声明在 {@code MTEBasicTank} 上，
     * <b>不在</b>方块实体（{@code BaseMetaTileEntity}）上——从方块实体读必然得到 null。
     */
    @Test
    public void fluidGettersLiveOnMetaTileEntityNotOnBaseTileEntity() throws Exception {
        java.nio.file.Path gt = gtSourceRoot();
        if (gt == null) {
            return; // GT 源码不在本机：跳过（见本节局限说明），不伪造结论
        }
        String base = readSource(gt.resolve("gregtech/api/metatileentity/BaseMetaTileEntity.java"));
        String tank = readSource(gt.resolve("gregtech/api/metatileentity/implementations/MTEBasicTank.java"));
        assertTrue("MTEBasicTank 应当声明 getFluid()（储罐单值读数的宿主）", tank.contains("public FluidStack getFluid()"));
        assertTrue("MTEBasicTank 应当声明 getFluidAmount()", tank.contains("public int getFluidAmount()"));
        assertFalse(
            "BaseMetaTileEntity 不应声明 getFluid()——若声明了，D-1 的成因描述需要复核",
            base.contains("public FluidStack getFluid()"));
        assertFalse("BaseMetaTileEntity 不应声明 getFluidAmount()", base.contains("public int getFluidAmount()"));
    }

    /**
     * 方块实体的 {@code getCapacity()} 返回 <b>EU 容量</b>而不是储罐容量——D-1 会「静默给错数」的成因。
     *
     * <p>
     * GT 源码原文：{@code return (int) Math.min(Integer.MAX_VALUE, getEUCapacity());}
     * （{@code BaseMetaTileEntity.java:1997-1999}）。储罐容量在 MTE 上
     * （{@code MTEBasicMachineWithRecipe.java:482-484} 返回 {@code this.mTankCapacity}）。
     * 两者在 LV 化学反应釜上分别是 2048 与 16000（实机实测）。
     */
    @Test
    public void baseTileEntityGetCapacityIsEuCapacityNotTankCapacity() throws Exception {
        java.nio.file.Path gt = gtSourceRoot();
        if (gt == null) {
            return; // GT 源码不在本机：跳过（见本节局限说明）
        }
        String base = readSource(gt.resolve("gregtech/api/metatileentity/BaseMetaTileEntity.java"));
        assertTrue(
            "BaseMetaTileEntity.getCapacity() 应返回 EU 容量（getEUCapacity）——这是 D-1 的成因",
            base.contains("public int getCapacity()")
                && base.contains("return (int) Math.min(Integer.MAX_VALUE, getEUCapacity());"));
        String machine = readSource(
            gt.resolve("gregtech/api/metatileentity/implementations/MTEBasicMachineWithRecipe.java"));
        assertTrue(
            "MTEBasicMachineWithRecipe.getCapacity() 应返回 this.mTankCapacity（真正的储罐容量）",
            machine.contains("public int getCapacity()") && machine.contains("return this.mTankCapacity;"));
    }

    /**
     * D-2：{@code MTEBasicMachine} 的 {@code getFluid}/{@code getFluidAmount} 指的是
     * <b>输出/可排出</b>那一侧，不是输入储罐——字段名必须带 {@code drainable} 前缀才不会误读。
     *
     * <p>
     * 源码链：{@code MTEBasicTank.getFluid() → getDrainableStack()}（{@code :195-197}），
     * 而 {@code MTEBasicMachine.getDrainableStack() → mFluidOut}（{@code :455-457}）。
     * 实机实测（#122 段二第二轮）：注完 HCl 3000 后 {@code fluid=null/fluidAmount=0}
     * （输入罐在 {@code tanks[0]}，输出罐确实是空的），配方跑完后变成
     * {@code trichlorosilane/1000}——<b>我最初「应为 3000」的期望本身是错的</b>。
     * 这条测试把该语义锁成源码事实，免得后人再按「主罐」去理解它。
     */
    @Test
    public void metaTileMachineFluidGetterIsTheDrainableSide() throws Exception {
        java.nio.file.Path gt = gtSourceRoot();
        if (gt == null) {
            return; // GT 源码不在本机：跳过（见本节局限说明）
        }
        String tank = readSource(gt.resolve("gregtech/api/metatileentity/implementations/MTEBasicTank.java"));
        assertTrue(
            "MTEBasicTank.getFluid() 应转调 getDrainableStack()（D-2 的成因）",
            tank.contains("public FluidStack getFluid()") && tank.contains("return getDrainableStack();"));
        String machine = readSource(gt.resolve("gregtech/api/metatileentity/implementations/MTEBasicMachine.java"));
        assertTrue(
            "MTEBasicMachine.getDrainableStack() 应返回 mFluidOut（输出侧，不是 mFluid 输入侧）",
            machine.contains("public FluidStack getDrainableStack()") && machine.contains("return mFluidOut;"));
        // 对照：输入侧存在另一个字段 mFluid（MTEBasicTank 的 fillable stack），两者不是同一个东西
        assertTrue(
            "MTEBasicTank 的输入侧应是 mFluid/getFillableStack（与 drainable 分开）",
            tank.contains("public FluidStack getFillableStack()"));
    }

    /** GT 源码根（工作区约定路径 {@code D:\github\gtnh\GT5-Unofficial}）；不在时返回 null。 */
    private static java.nio.file.Path gtSourceRoot() {
        java.nio.file.Path p = java.nio.file.Paths.get("D:\\github\\gtnh\\GT5-Unofficial\\src\\main\\java");
        return java.nio.file.Files.isDirectory(p) ? p : null;
    }

    private static String readSource(java.nio.file.Path p) throws Exception {
        return new String(java.nio.file.Files.readAllBytes(p), java.nio.charset.StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------ 工具

    private static JsonObject params(String fluid, Object amount, String side) {
        JsonObject p = new JsonObject();
        p.addProperty("at", "unused-by-spec");
        p.remove("at"); // at 由动作层解析（optPos），不在 TankFillSpec 的职责内
        if (fluid != null) {
            p.addProperty("fluid", fluid);
        }
        if (amount instanceof Integer) {
            p.addProperty("amount", (Integer) amount);
        } else if (amount instanceof Double) {
            p.addProperty("amount", (Double) amount);
        }
        if (side != null) {
            p.addProperty("side", side);
        }
        return p;
    }

    private static JsonObject material(int slot, String material, String prefix, int count) {
        JsonObject p = new JsonObject();
        p.addProperty("slot", slot);
        if (material != null) {
            p.addProperty("material", material);
        }
        if (prefix != null) {
            p.addProperty("prefix", prefix);
        }
        p.addProperty("count", count);
        return p;
    }

    private static ActionDescriptor.Param param(ActionDescriptor d, String name) {
        for (ActionDescriptor.Param p : d.params()) {
            if (p.name()
                .equals(name)) {
                return p;
            }
        }
        return null;
    }

    private interface Thrower {

        void run();
    }

    /** 断言抛出的是 CP-VALID-002（可写参数类错误），且 context 逐字段。 */
    private static CpException expectParam(Thrower t) {
        try {
            t.run();
            fail("应报 CP-VALID-002");
            return null;
        } catch (CpException e) {
            assertEquals("应为参数类错误", ErrorCodes.VALID_PARAM, e.code());
            assertNotNull("必须给出逐字段 context", e.context());
            return e;
        }
    }

    private static String ctxText(CpException e) {
        return e.getMessage() + " " + Json.toJson(e.context());
    }
}
