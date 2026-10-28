package com.lightning.mod.client.controlplane.mc;

import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonObject;

/**
 * Applied Energistics 2 部件宿主的<b>运行期状态描述器</b>（族名 {@code ae2-part}，与
 * {@link Ae2PartCompleter} 同名注册）。
 *
 * <h2>输出（只读；{@code te-state-equals} 的 {@code key} 指向这棵树）</h2>
 *
 * <pre>
 * {
 *   "te": "appeng.tile.networking.TileCableBus",
 *   "parts":      {"DOWN":null,"UP":"appeng:ItemPart@1","...":"...","UNKNOWN":"appeng:ItemCable@0"},
 *   "partClasses":{"DOWN":null,"UP":"appeng.parts.automation.PartImportBus", ...},
 *   "facades":    {"DOWN":null,"UP":"minecraft:stone@0", ...}
 * }
 * </pre>
 *
 * <ul>
 * <li><b>六面齐全</b>（{@code ForgeDirection.VALID_DIRECTIONS}），外加中心位 {@code UNKNOWN}
 * （缆本体）；没有部件/伪装板的面写<b>显式 {@code null}</b>，因此 {@code expect: null}
 * （断言「这一面是空的」）是可写的，与「键名写错」区分得开；</li>
 * <li>{@code parts}/{@code facades} 的值是物品身份（{@link ModReflect#itemId(ItemStack)}，
 * meta 非 0 时形如 {@code modid:name@meta}）——与用例 {@code params.parts[].item}+{@code meta}
 * 同一套标识；</li>
 * <li>{@code partClasses} 是部件实现类全名（区分同物品不同部件，如不同 meta 的总线）。</li>
 * </ul>
 *
 * <h2>权威读取路径（源码实证，AE2-U rv3-beta-834）</h2>
 * <ol>
 * <li>TE 必须是 {@code appeng.api.parts.IPartHost}（{@code TileCableBus} 实现之）；</li>
 * <li>部件：{@code IPartHost.getPart(ForgeDirection)}（{@code api/parts/IPartHost.java:66} →
 * {@code parts/CableBusContainer.getPart:258}，{@code UNKNOWN} 即中心缆）；物品身份取
 * {@code IPart.getItemStack(PartItemStack.World)}（{@code api/parts/IPart.java:56}）；</li>
 * <li>伪装板：{@code IPartHost.getFacadeContainer().getFacade(ForgeDirection)}
 * （{@code parts/CableBusContainer.java:104} → {@code facade/FacadeContainer.java:63}）。
 * <b>注意</b>：{@code getFacade} 直接按 ordinal 索引长度 6 的数组，故
 * <b>绝不</b>对 {@code UNKNOWN} 调它（会越界）——本类只对 {@code VALID_DIRECTIONS} 查询。</li>
 * </ol>
 *
 * <p>
 * <b>只读</b>：不调 {@code markForUpdate}/{@code addPart}/{@code removePart} 等任何写方法，
 * 也不读 NBT 猜状态（{@link TeDescriber} 的实现纪律）。
 */
public final class Ae2PartDescriber implements TeDescriber {

    /** 注册名（与 {@link Ae2PartCompleter#NAME} 一致）。 */
    public static final String NAME = Ae2PartCompleter.NAME;

    /** 中心位在输出里的键名（AE2 用 {@code ForgeDirection.UNKNOWN} 表示缆本体）。 */
    public static final String CENTER_KEY = "UNKNOWN";

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public JsonObject describe(WorldServer world, int x, int y, int z) {
        if (world == null) {
            return null;
        }
        Class<?> hostClass = ModReflect.cls(Ae2PartCompleter.IPART_HOST_CLASS);
        if (hostClass == null) {
            return null; // AE2 缺席：本描述器不认领任何 TE
        }
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null || !hostClass.isInstance(te)) {
            return null;
        }
        JsonObject parts = new JsonObject();
        JsonObject partClasses = new JsonObject();
        JsonObject facades = new JsonObject();
        for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
            addPart(te, d, parts, partClasses);
            addFacade(te, d, facades);
        }
        addPart(te, ForgeDirection.UNKNOWN, parts, partClasses);
        JsonObject o = new JsonObject();
        o.addProperty(
            "te",
            te.getClass()
                .getName());
        o.add("parts", parts);
        o.add("partClasses", partClasses);
        o.add("facades", facades);
        return o;
    }

    // ------------------------------------------------------------ 读取

    /** 读一面的部件（没有则写显式 null）。 */
    private static void addPart(TileEntity te, ForgeDirection dir, JsonObject parts, JsonObject partClasses) {
        Object part = ModReflect.call(te, "getPart", new Class<?>[] { ForgeDirection.class }, dir);
        if (part == null) {
            parts.addProperty(dir.name(), (String) null);
            partClasses.addProperty(dir.name(), (String) null);
            return;
        }
        ItemStack stack = partStackOf(part);
        parts.addProperty(dir.name(), ModReflect.itemId(stack));
        partClasses.addProperty(
            dir.name(),
            part.getClass()
                .getName());
    }

    /** 读一面的伪装板（没有则写显式 null）。只对 VALID_DIRECTIONS 调用（getFacade 不接受 UNKNOWN）。 */
    private static void addFacade(TileEntity te, ForgeDirection dir, JsonObject facades) {
        Object container = ModReflect.call(te, "getFacadeContainer");
        if (container == null) {
            facades.addProperty(dir.name(), (String) null);
            return;
        }
        Object facade = ModReflect.call(container, "getFacade", new Class<?>[] { ForgeDirection.class }, dir);
        if (facade == null) {
            facades.addProperty(dir.name(), (String) null);
            return;
        }
        facades.addProperty(dir.name(), ModReflect.itemId(facadeStack(facade)));
    }

    /**
     * 部件自身的物品栈：{@code IPart.getItemStack(PartItemStack.World)}。
     *
     * <p>
     * {@code PartItemStack} 是 AE2 的枚举（{@code World/Wrench/Network}）；这里按枚举名取
     * {@code World}（世界里的部件物品形态），取不到则退回第一个枚举常量——不硬编码序号。
     *
     * <p>
     * 同一个方法也被 {@link Ae2PartCompleter} 用作幂等判定的第二级（缆的颜色/材质只在物品 meta 上），
     * 故可见性是包级。
     */
    static ItemStack partStackOf(Object part) {
        Class<?> typeClass = ModReflect.load("appeng.api.parts.PartItemStack");
        Object type = partItemStack(typeClass);
        if (typeClass == null || type == null) {
            return null;
        }
        Object s = ModReflect.call(part, "getItemStack", new Class<?>[] { typeClass }, type);
        return s instanceof ItemStack ? (ItemStack) s : null;
    }

    /** 伪装板自身的物品栈。 */
    private static ItemStack facadeStack(Object facade) {
        Object s = ModReflect.call(facade, "getItemStack");
        return s instanceof ItemStack ? (ItemStack) s : null;
    }

    /** {@code PartItemStack} 里的指定常量；取不到时退回首个常量。 */
    private static Object partItemStack(Class<?> c) {
        if (c == null || !c.isEnum()) {
            return null;
        }
        Object[] constants = c.getEnumConstants();
        if (constants == null || constants.length == 0) {
            return null;
        }
        for (Object o : constants) {
            if (o instanceof Enum && "World".equals(((Enum<?>) o).name())) {
                return o;
            }
        }
        return constants[0];
    }
}
