package com.lightning.mod.client.controlplane.mc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.scene.InventoryWriteAction;
import com.lightning.mod.client.controlplane.mc.scene.SlotSpec;

/**
 * GT 机器放置与供电通道中<b>不依赖 MC/GT 运行时</b>的那部分逻辑的单测。
 *
 * <h2>为什么只能测这部分</h2>
 * 放置通道的执行体要碰 {@code WorldServer}/{@code ItemStack}/{@code BaseMetaTileEntity}，
 * 本仓 mod 无世界环境的单测能力（contract.md §14 的分层理由），因此实放路径由段二实机覆盖
 * 但两件事必须离线锁死，否则实机轮
 * 只会把参数笔误当成「GT 坏了」：
 * <ul>
 * <li><b>参数解析与全部错误路径</b>（{@link GtMachineParams}）——未知机器常量名、非法 meta、
 * 非 GT 方块、互斥字段、未知放置面，逐条显式失败（契约 §7.5 共同口径第 4 条「失败显式」）；</li>
 * <li><b>供电布景的槽位/充电口径</b>（{@link SlotSpec}）——尤其 {@code charge} ⟂ {@code nbt}
 * 这条防「逐字段 NBT 回填」的纪律，以及 {@code charge} 要求 {@code count=1}（GT 电力物品的自身条款）。</li>
 * </ul>
 *
 * <h2>为什么族名要有断言</h2>
 * 补全器与描述器<b>必须同名注册</b>（{@link TeCompleter} 的族名接缝）：不同名就会出现
 * 「能放但 read.te 读不到」，而那种缺陷在实机上表现为「描述器未认领」，与「模组缺席」长得一样。
 */
public class GtMachineFamilyTest {

    // ------------------------------------------------------------ 族名与注册表口径

    /** 补全器与描述器必须同名（族名是两者的唯一接缝）。 */
    @Test
    public void completerAndDescriberShareFamilyName() {
        assertEquals("gt-machine", GtMachineCompleter.NAME);
        assertEquals(GtMachineCompleter.NAME, GtMachineDescriber.NAME);
    }

    /**
     * GT 机器方块的注册名是 GT 源码里的字面量（{@code BlockMachines.getUnlocalizedName()}），
     * 写死它是有意的（错误路径要能说出「只接受哪个注册名」）；这条断言防手滑改错 modid。
     */
    @Test
    public void machineBlockRegistryNameIsCanonical() {
        assertEquals("gregtech:gt.blockmachines", GtMachineParams.GT_MACHINE_BLOCK);
    }

    /** 放置面表的下标必须与 {@code ForgeDirection} 的 ordinal 同序（0=DOWN、1=UP…）。 */
    @Test
    public void sideTableMatchesForgeDirectionOrdinals() {
        assertEquals(0, GtMachineParams.sideOrdinal("down"));
        assertEquals(1, GtMachineParams.sideOrdinal("UP"));
        assertEquals(2, GtMachineParams.sideOrdinal("North"));
        assertEquals(3, GtMachineParams.sideOrdinal("SOUTH"));
        assertEquals(4, GtMachineParams.sideOrdinal("west"));
        assertEquals(5, GtMachineParams.sideOrdinal("east"));
        assertEquals(-1, GtMachineParams.sideOrdinal("SIDEWAYS"));
        assertEquals(-1, GtMachineParams.sideOrdinal(null));
        assertEquals("UP", GtMachineParams.sideName(1));
        assertEquals("UP", GtMachineParams.sideName(99));
    }

    // ------------------------------------------------------------ 正常路径

    /** ItemList 常量形式（首选写法）：物品与 meta 由 GT 清单决定，因此 spec 不带 item/meta。 */
    @Test
    public void itemListFormNeedsNoItemOrMeta() {
        GtMachineParams.Spec spec = parse(machine("Machine_LV_ChemicalReactor"));
        assertTrue(spec.byItemList());
        assertEquals("Machine_LV_ChemicalReactor", spec.machine);
        assertNull("ItemList 形式不带显式 item", spec.item);
        assertEquals("ItemList 形式不带显式 meta", 0, spec.meta);
        assertEquals("缺省放置面是 UP", 1, spec.sideOrdinal);
        assertTrue(
            spec.describe(),
            spec.describe()
                .contains("Machine_LV_ChemicalReactor"));
    }

    /** 显式形式：item 必须是 GT 机器方块，meta 是 MetaTileEntity id。 */
    @Test
    public void explicitFormCarriesItemAndMeta() {
        JsonObject p = new JsonObject();
        p.addProperty("item", "gregtech:gt.blockmachines");
        p.addProperty("meta", 421);
        p.addProperty("side", "north");
        GtMachineParams.Spec spec = parse(p);
        assertFalse(spec.byItemList());
        assertEquals("gregtech:gt.blockmachines", spec.item);
        assertEquals(421, spec.meta);
        assertEquals(2, spec.sideOrdinal);
    }

    /** 空参数之外的最小可用形态：只给 machine。 */
    @Test
    public void machineOnlyIsMinimalValidInput() {
        assertNotNull(parse(machine("Machine_LV_ChemicalReactor")));
    }

    // ------------------------------------------------------------ 错误路径（逐条显式）

    /** 未知机器常量名：必须报 CP-VALID-002，且 context 里带收到的名字（一次改对）。 */
    @Test
    public void unknownMachineConstantFailsExplicitly() {
        CpException e = expectParam(
            () -> GtMachineParams
                .parse(machine("Machine_LV_ChemicalReactro"), name -> "Machine_LV_ChemicalReactor".equals(name)));
        assertTrue("message 未带收到的常量名: " + e.getMessage(), ctxText(e).contains("Machine_LV_ChemicalReactro"));
        assertTrue("message 未给相近名提示: " + e.getMessage(), ctxText(e).contains("相近") || ctxText(e).contains("ItemList"));
    }

    /** 非 GT 方块：只接受 gregtech:gt.blockmachines，别的方块名显式拒绝（不是「静默换一个」）。 */
    @Test
    public void nonGtBlockFailsExplicitly() {
        JsonObject p = new JsonObject();
        p.addProperty("item", "minecraft:stone");
        p.addProperty("meta", 1);
        CpException e = expectParam(() -> GtMachineParams.parse(p, name -> true));
        assertTrue(ctxText(e).contains(GtMachineParams.GT_MACHINE_BLOCK));
    }

    /** meta=0 是「要一个空壳」，不是默认值：必须显式拒绝（GT 的 tDamage<=0 不建 MetaTileEntity）。 */
    @Test
    public void zeroMetaFailsExplicitly() {
        CpException e = expectParam(() -> GtMachineParams.parse(explicit(0), name -> true));
        assertTrue(
            "未说清 meta>0 的理由: " + e.getMessage(),
            e.getMessage()
                .contains("空壳"));
    }

    /** meta 越界 / 非整数 / 非数字：三种都显式失败，不静默取默认值。 */
    @Test
    public void illegalMetaFailsExplicitly() {
        expectParam(() -> GtMachineParams.parse(explicit(40000), name -> true));
        expectParam(() -> GtMachineParams.parse(explicit(-1), name -> true));
        expectParam(() -> GtMachineParams.parse(explicit(1.5d), name -> true));
        expectParam(() -> GtMachineParams.parse(explicit("421"), name -> true));
    }

    /** 显式形式缺 meta：显式失败（meta 无默认值）。 */
    @Test
    public void missingMetaWithItemFailsExplicitly() {
        JsonObject p = new JsonObject();
        p.addProperty("item", "gregtech:gt.blockmachines");
        expectParam(() -> GtMachineParams.parse(p, name -> true));
    }

    /** machine 与 item 互斥；machine 与 meta 也互斥（meta 由常量自带）。 */
    @Test
    public void machineConflictsWithItemAndMeta() {
        JsonObject both = machine("Machine_LV_ChemicalReactor");
        both.addProperty("item", "gregtech:gt.blockmachines");
        both.addProperty("meta", 421);
        expectParam(() -> GtMachineParams.parse(both, name -> true));

        JsonObject withMeta = machine("Machine_LV_ChemicalReactor");
        withMeta.addProperty("meta", 421);
        expectParam(() -> GtMachineParams.parse(withMeta, name -> true));
    }

    /** 空参数：显式失败并说明两种写法。 */
    @Test
    public void emptyParamsFailExplicitly() {
        CpException e = expectParam(() -> GtMachineParams.parse(new JsonObject(), name -> true));
        assertTrue(ctxText(e).contains("machine"));
        assertTrue(ctxText(e).contains("item"));
    }

    /** null params 也走同一条显式失败（不是 NPE）。 */
    @Test
    public void nullParamsFailExplicitly() {
        expectParam(() -> GtMachineParams.parse(null, name -> true));
    }

    /** 未知放置面：显式失败并列出可用取值。 */
    @Test
    public void unknownSideFailsExplicitly() {
        JsonObject p = machine("Machine_LV_ChemicalReactor");
        p.addProperty("side", "SIDEWAYS");
        CpException e = expectParam(() -> GtMachineParams.parse(p, name -> true));
        assertTrue(ctxText(e).contains("DOWN"));
    }

    // ------------------------------------------------------------ 槽位/充电口径（供电布景）

    /** battery + charge 是供电布景的写法；解析后 clear=false 且 id 为空。 */
    @Test
    public void batteryEntryParses() {
        SlotSpec s = SlotSpec.parse(battery(1, "Battery_RE_LV_Lithium", new JsonPrimitive("full")), "slots[0]");
        assertEquals(1, s.slot);
        assertFalse(s.clear);
        assertNull(s.id);
        assertEquals("Battery_RE_LV_Lithium", s.battery);
        assertEquals(SlotSpec.Charge.Mode.FULL, s.charge.mode);
        assertFalse(s.charge.isNone());
        assertEquals("full", s.charge.describe());
    }

    /** charge 三种取值：full / empty / 非负整数。 */
    @Test
    public void chargeAcceptsThreeForms() {
        assertEquals(
            SlotSpec.Charge.Mode.EMPTY,
            SlotSpec.parse(battery(1, "B", new JsonPrimitive("EMPTY")), "s").charge.mode);
        SlotSpec amount = SlotSpec.parse(battery(1, "B", new JsonPrimitive(50000)), "s");
        assertEquals(SlotSpec.Charge.Mode.AMOUNT, amount.charge.mode);
        assertEquals(50000L, amount.charge.amount);
        assertEquals("50000", amount.charge.describe());
        assertTrue(SlotSpec.parse(battery(1, "B", null), "s").charge.isNone());
    }

    /** charge 与 nbt 互斥：这条是「禁止逐字段 NBT 回填」的可执行形式（契约 §10 第 6 条）。 */
    @Test
    public void chargeConflictsWithNbt() {
        JsonObject entry = battery(1, "Battery_RE_LV_Lithium", new JsonPrimitive("full"));
        entry.addProperty("nbt", "{GT.ItemCharge:100000L}");
        CpException e = expectParam(() -> SlotSpec.parse(entry, "slots[0]"));
        assertTrue("未说清为什么禁止: " + e.getMessage(), ctxText(e).contains("6.4") || ctxText(e).contains("回填"));
    }

    /** charge 要求 count=1（GT 的电力物品在 stackSize != 1 时拒绝充放）。 */
    @Test
    public void chargeRequiresSingleItem() {
        JsonObject entry = battery(1, "Battery_RE_LV_Lithium", new JsonPrimitive("full"));
        entry.addProperty("count", 2);
        CpException e = expectParam(() -> SlotSpec.parse(entry, "slots[0]"));
        assertTrue(ctxText(e).contains("count"));
    }

    /** battery 与 id 互斥。 */
    @Test
    public void batteryConflictsWithId() {
        JsonObject entry = battery(1, "Battery_RE_LV_Lithium", new JsonPrimitive("full"));
        entry.addProperty("id", "minecraft:stone");
        expectParam(() -> SlotSpec.parse(entry, "slots[0]"));
    }

    /**
     * 「清空该槽」与「要一格满充电池」矛盾，必须显式失败——静默忽略 charge 会让调用方以为
     * 电池已经写进去了（假绿）。
     */
    @Test
    public void clearEntryRejectsCharge() {
        JsonObject entry = new JsonObject();
        entry.addProperty("slot", 1);
        entry.addProperty("id", "air");
        entry.addProperty("charge", "full");
        expectParam(() -> SlotSpec.parse(entry, "slots[0]"));
    }

    /**
     * 既有语义不收紧：清空条目（id=air）历来忽略 count/meta（旧实现直接返回 null、不做范围校验），
     * 这里锁住该兼容性，免得把合法老用例判红。
     */
    @Test
    public void clearEntryStillIgnoresCountAndMeta() {
        JsonObject entry = new JsonObject();
        entry.addProperty("slot", 1);
        entry.addProperty("id", "air");
        entry.addProperty("count", 99);
        entry.addProperty("meta", 40000);
        assertTrue(SlotSpec.parse(entry, "slots[0]").clear);
    }

    /** charge 取值非法：字符串与负数都显式失败（列出可用取值）。 */
    @Test
    public void illegalChargeFailsExplicitly() {
        CpException e = expectParam(() -> SlotSpec.parse(battery(1, "B", new JsonPrimitive("mostly")), "slots[0]"));
        assertTrue(ctxText(e).contains("full"));
        expectParam(() -> SlotSpec.parse(battery(1, "B", new JsonPrimitive(-5)), "slots[0]"));
        expectParam(() -> SlotSpec.parse(battery(1, "B", new JsonPrimitive(1.5d)), "slots[0]"));
    }

    /** 既有口径不变：id 给 air 即清空；缺 id 也清空（与 L0 的既有语义一致）。 */
    @Test
    public void clearSemanticsUnchanged() {
        JsonObject air = new JsonObject();
        air.addProperty("slot", 3);
        air.addProperty("id", "air");
        assertTrue(SlotSpec.parse(air, "s").clear);
        JsonObject noId = new JsonObject();
        noId.addProperty("slot", 3);
        assertTrue(SlotSpec.parse(noId, "s").clear);
        JsonObject normal = new JsonObject();
        normal.addProperty("slot", 3);
        normal.addProperty("id", "minecraft:torch");
        normal.addProperty("count", 16);
        SlotSpec s = SlotSpec.parse(normal, "s");
        assertFalse(s.clear);
        assertEquals("minecraft:torch", s.id);
        assertEquals(16, s.count);
        assertEquals(3, s.slot);
    }

    /** 既有口径不变：count/meta 越界报 CP-VALID-002；slot 缺失报 CP-VALID-002 且指明条目路径。 */
    @Test
    public void existingRangeChecksStillFailExplicitly() {
        JsonObject badCount = new JsonObject();
        badCount.addProperty("slot", 0);
        badCount.addProperty("id", "minecraft:torch");
        badCount.addProperty("count", 65);
        expectParam(() -> SlotSpec.parse(badCount, "s"));

        JsonObject badMeta = new JsonObject();
        badMeta.addProperty("slot", 0);
        badMeta.addProperty("id", "minecraft:torch");
        badMeta.addProperty("meta", 40000);
        expectParam(() -> SlotSpec.parse(badMeta, "s"));

        JsonObject noSlot = new JsonObject();
        noSlot.addProperty("id", "minecraft:torch");
        CpException e = expectParam(() -> SlotSpec.parse(noSlot, "slots[4]"));
        assertNotNull("错误必须指明是哪个条目", e.context());
        assertTrue(ctxText(e).contains("slots[4]"));
    }

    // ------------------------------------------------------------ 自描述与版本口径

    /**
     * {@code scene.inventory.write} 的自描述必须把新增的 {@code battery}/{@code charge} 写出来
     * （「没有自描述的动作视为不存在」；只加可选参数、不改语义与默认值 ⇒ 契约版本不动）。
     */
    @Test
    public void inventoryWriteSelfDescriptionCoversBatteryAndCharge() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor("scene.inventory.write");
        assertNotNull(d);
        String desc = d.description();
        assertTrue("自述未提 battery: " + desc, desc.contains("battery"));
        assertTrue("自述未提 charge: " + desc, desc.contains("charge"));
        assertTrue("自述未说明 charge 与 nbt 互斥", desc.contains("互斥"));
        assertTrue("自述未提 GT", desc.contains("GT"));
        boolean sawExample = false;
        for (int i = 0; i < d.examples()
            .size(); i++) {
            String ex = Json.toJson(
                d.examples()
                    .get(i));
            if (ex.contains("battery") && ex.contains("charge")) {
                sawExample = true;
            }
            // 示例必须可解析（示例是「无先验知识调用方」的唯一素材）
            Json.parseStrictObject(ex);
        }
        assertTrue("缺一条 battery+charge 的可复制示例", sawExample);
        // 只增可选参数：动作的引入版本不动（since 仍为 1.3）；
        // 契约版本随功能前进（1.4/1.5），这里只锁不变式「契约版本 ≥ 动作 since」。
        assertEquals("1.3", d.since());
        assertTrue(
            "契约版本 " + Contract.VERSION + " 必须 ≥ 动作 since " + d.since(),
            Contract.VERSION.compareTo(d.since()) >= 0);
    }

    /** 脚本参数说明里每个参数都要有类型与说明（复用读面单测的同一纪律）。 */
    @Test
    public void inventoryWriteParamsAreDocumented() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (ActionDescriptor.Param p : registry.descriptor("scene.inventory.write")
            .params()) {
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
     * 场景清单哈希对「空壳 vs 真机器」是盲的——把这条事实锁成测试，因为它正是
     * 「负对照必须用描述器而不是 world-hash-equals」的依据（{@link GtMachineDescriber} 的类注释）。
     */
    @Test
    public void manifestHashIsBlindToGtMetaTileEntity() {
        JsonObject shell = manifestWithTeState("absent-ish");
        JsonObject live = manifestWithTeState("live");
        // 两次 teReads 不同（描述器能分辨），但哈希相同（哈希只看 pos/class）
        assertEquals(
            com.lightning.mod.client.controlplane.mc.SceneManifest.hash(shell),
            com.lightning.mod.client.controlplane.mc.SceneManifest.hash(live));
    }

    // ------------------------------------------------------------ 工具

    /** 造一份「同一位置、同一 TE 类、但描述器读数不同」的清单。 */
    private static JsonObject manifestWithTeState(String state) {
        com.google.gson.JsonArray pos = new com.google.gson.JsonArray();
        pos.add(new JsonPrimitive(65));
        pos.add(new JsonPrimitive(12));
        pos.add(new JsonPrimitive(65));

        com.google.gson.JsonArray blockArr = new com.google.gson.JsonArray();
        JsonObject block = new JsonObject();
        block.add("pos", pos);
        block.addProperty("blockId", 1000);
        block.addProperty("meta", 1);
        blockArr.add(block);

        com.google.gson.JsonArray teArr = new com.google.gson.JsonArray();
        JsonObject te = new JsonObject();
        te.add("pos", pos);
        te.addProperty("class", "gregtech.api.metatileentity.BaseMetaTileEntity");
        teArr.add(te);

        com.google.gson.JsonArray teReads = new com.google.gson.JsonArray();
        JsonObject read = new JsonObject();
        read.add("pos", pos);
        read.addProperty("completer", GtMachineCompleter.NAME);
        JsonObject st = new JsonObject();
        st.addProperty("metaTileId", state);
        read.add("state", st);
        teReads.add(read);

        JsonObject m = new JsonObject();
        m.addProperty("schema", com.lightning.mod.client.controlplane.mc.SceneManifest.SCHEMA);
        m.add("blocks", blockArr);
        m.add("tileEntities", teArr);
        m.add("teReads", teReads);
        return m;
    }

    private static GtMachineParams.Spec parse(JsonObject p) {
        return GtMachineParams.parse(p, name -> true);
    }

    private static JsonObject machine(String constant) {
        JsonObject p = new JsonObject();
        p.addProperty("machine", constant);
        return p;
    }

    private static JsonObject explicit(Object meta) {
        JsonObject p = new JsonObject();
        p.addProperty("item", GtMachineParams.GT_MACHINE_BLOCK);
        if (meta instanceof String) {
            p.addProperty("meta", (String) meta);
        } else if (meta instanceof Double) {
            p.addProperty("meta", (Double) meta);
        } else {
            p.addProperty("meta", (Integer) meta);
        }
        return p;
    }

    private static JsonObject battery(int slot, String constant, com.google.gson.JsonElement charge) {
        JsonObject p = new JsonObject();
        p.addProperty("slot", slot);
        p.addProperty("battery", constant);
        if (charge != null) {
            p.add("charge", charge);
        }
        return p;
    }

    private interface Thrower {

        void run();
    }

    /** 断言抛出的是 CP-VALID-002（可写参数类错误）。 */
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

    /** 未使用但保留：确认 {@link InventoryWriteAction} 的常量口径可被测试引用。 */
    @Test
    public void inventoryWriteConstantsAreStable() {
        assertEquals(256, InventoryWriteAction.MAX_SLOTS);
    }

    // ------------------------------------------------------------ 放置接收者

    /**
     * {@code placeBlockAt} 的接收者必须是<b>物品自己</b>，不能是 null。
     *
     * <p>
     * <b>这条测试是实机缺陷的离线回归锁。</b>段一以
     * {@code placeBlockAt.invoke(null, …)} 调用 GT 的 <b>实例</b>方法
     * （GT5U {@code ItemMachines.java:59,239-241}，方法体用 {@code this.field_150939_a}），
     * 运行期必抛 {@code NullPointerException}。该缺陷在离线单测下不可见（本仓无世界环境），
     * 实机一跑就炸；本测试把「接收者来自 {@code stack.getItem()}」这个约束钉在无世界环境也能跑的地方。
     */
    @Test
    public void placementReceiverIsTheItemBlockNotNull() {
        ItemStack stack = new ItemStack(new ItemBlockTestDouble(), 1, 421);
        Item resolved = GtMachineCompleter.placementReceiver(stack, ItemBlockTestDouble.class, 421);
        assertNotNull("接收者不能为 null（null 即反射解析失败）", resolved);
        assertTrue("接收者必须是物品自己（该方块自己的 ItemBlock）", resolved == stack.getItem());
    }

    /** 接收者类型不对时显式失败（CP-EXEC-001），而不是留给运行期一个裸 NPE。 */
    @Test
    public void placementReceiverRejectsForeignItemBlock() {
        ItemStack stack = new ItemStack(new ItemBlockTestDouble(), 1, 421);
        try {
            GtMachineCompleter.placementReceiver(stack, String.class, 421);
            fail("ItemBlock 类型不符应显式失败");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
            assertTrue("错误里要说清接收者是什么", ctxText(e).contains("ItemBlock"));
        }
    }

    /** 最恶劣的一种：物品为空（接收者将解析成 null）也必须显式失败。 */
    @Test
    public void placementReceiverRejectsNullItemStack() {
        try {
            GtMachineCompleter.placementReceiver(null, ItemBlockTestDouble.class, 421);
            fail("空物品栈应显式失败");
        } catch (CpException e) {
            assertEquals(ErrorCodes.EXEC_FAILED, e.code());
        }
    }

    /** 测试替身：冒充 ItemBlock（本仓离线单测没有 MC 运行时，但不妨碍验证接收者解析）。 */
    private static final class ItemBlockTestDouble extends Item {
    }
}
