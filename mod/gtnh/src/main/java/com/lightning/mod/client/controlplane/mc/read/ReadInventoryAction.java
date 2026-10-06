package com.lightning.mod.client.controlplane.mc.read;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.IInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code read.inventory}（observe，同步）：背包与容器逐槽读回。
 *
 * <p>
 * 三选一的数据源（同一实现，只换来源），<b>必须显式给出其中一个</b>：
 * <ul>
 * <li>{@code source:"player"}（默认）：服务端玩家背包——主手 36 槽 + 护甲 4 槽 + 光标槽；</li>
 * <li>{@code source:"tile"} + {@code at:[x,y,z]}：该位置方块实体实现的 {@link IInventory}
 * （箱子/桶/GT 机器/AE2 驱动器…）；</li>
 * <li>{@code source:"ender"}：玩家末影箱（{@code InventoryEnderChest}，独立 27 槽）。</li>
 * </ul>
 *
 * <h2>「容器不存在」为什么不静默返回空</h2>
 * 需求书 §8.5「失败显式：不静默成功、不静默跳过、不空转绿」。一个不存在的容器与一个空容器
 * 在「逐槽都为空」这个读数上完全一样，但含义相反：前者说明调用方写错了坐标或还没放方块。
 * 因此后者判 {@code CP-VALID-002}/{@code CP-STATE-001}（见执行体），而不是返回 27 个空槽。
 *
 * <h2>为什么写回 slot 编号的映射</h2>
 * 1.7.10 的 {@code InventoryPlayer.getStackInSlot(i)} 把 {@code i∈[0,35]} 映射到主背包、
 * {@code i∈[36,39]} 映射到护甲（{@code InventoryPlayer.java:636}）。逐槽读数<b>按同一个索引口径</b>给出，
 * 并附 {@code slotMeaning} 说明，调用方不必读源码就知道第 36 槽是头盔。
 */
public final class ReadInventoryAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.inventory";

    /** {@code source} 取值：玩家背包。 */
    public static final String SOURCE_PLAYER = "player";

    /** {@code source} 取值：方块实体容器。 */
    public static final String SOURCE_TILE = "tile";

    /** {@code source} 取值：末影箱。 */
    public static final String SOURCE_ENDER = "ender";

    @Override
    public JsonObject execute(ActionContext ctx) {
        String source = ctx.optString("source", SOURCE_PLAYER);
        WorldServer world = ReadSupport.requireServerWorld(NAME);

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-inventory/1");
        o.addProperty("action", NAME);
        o.addProperty("source", source);

        boolean includeEmpty = ctx.optBool("includeEmpty", true);
        int metaMax = ctx.optInt("nbtMaxEntries", ReadSupport.NBT_MAX_ENTRIES);
        if (metaMax <= 0) {
            throw CpException.param("nbtMaxEntries 非法", "nbtMaxEntries", "须为正整数，收到 " + metaMax);
        }

        switch (source) {
            case SOURCE_PLAYER:
                readPlayer(ctx, o, includeEmpty, metaMax);
                break;
            case SOURCE_TILE:
                readTile(ctx, world, o, includeEmpty, metaMax);
                break;
            case SOURCE_ENDER:
                readEnder(o, includeEmpty, metaMax);
                break;
            default:
                throw CpException.param(
                    "source 取值非法",
                    "source",
                    "须为 " + SOURCE_PLAYER + " | " + SOURCE_TILE + " | " + SOURCE_ENDER + "，收到: " + source);
        }

        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    // ------------------------------------------------------------ 三种来源

    /** 玩家背包（主背包 36 + 护甲 4）。 */
    private static void readPlayer(ActionContext ctx, JsonObject o, boolean includeEmpty, int metaMax) {
        EntityPlayerMP player = requirePlayer();
        JsonObject inv = new JsonObject();
        inv.addProperty("size", player.inventory.getSizeInventory());
        inv.addProperty("mainSize", player.inventory.mainInventory.length);
        inv.addProperty("armorSize", player.inventory.armorInventory.length);
        inv.addProperty("currentItem", player.inventory.currentItem);
        inv.addProperty("heldSlot", player.inventory.currentItem + 36);
        inv.addProperty(
            "slotMeaning",
            "[0,35] 主背包（0..8 为快捷栏；getStackInSlot 的 same 索引），[36,39] 护甲（36 头盔/37 胸甲/38 护腿/39 靴子）");
        inv.add("slots", slots(player.inventory, includeEmpty, metaMax));
        JsonObject cursor = new JsonObject();
        try {
            cursor.add("item", ReadSupport.readSlot(null, -1, player.inventory.getItemStack()));
        } catch (Throwable t) {
            cursor.addProperty("available", false);
        }
        inv.add("cursor", cursor);
        o.add("inventory", inv);
        o.addProperty("name", safeName(player.inventory));
        o.addProperty("owner", player.getCommandSenderName());
    }

    /** 方块实体容器（须实现 {@link IInventory}）。 */
    private static void readTile(ActionContext ctx, WorldServer world, JsonObject o, boolean includeEmpty,
        int metaMax) {
        // at 形态：平铺 [x,y,z]，或 {pos:[x,y,z]}（与 read.te 同一份解析，见 parseAt）
        int[] pos = parseAt(ctx, "at");
        com.lightning.mod.client.controlplane.core.Fields fields = new com.lightning.mod.client.controlplane.core.Fields();
        ReadSupport.checkBounds(pos, "at", fields);
        fields.throwIfAny("容器坐标非法");

        TileEntity te = world.getTileEntity(pos[0], pos[1], pos[2]);
        if (te == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "该位置没有方块实体（容器不存在）",
                Json.object(
                    "action",
                    NAME,
                    "at",
                    ReadSupport.posArray(pos),
                    "blockId",
                    ReadSupport.blockId(world.getBlock(pos[0], pos[1], pos[2])),
                    "hint",
                    "先放容器（build 段的 block 步）或核对坐标；空容器与不存在的容器不是一回事，故不返回空槽表"));
        }
        if (!(te instanceof IInventory)) {
            throw new CpException(
                ErrorCodes.STATE,
                "该位置的方块实体不实现 IInventory（不是容器）",
                Json.object(
                    "action",
                    NAME,
                    "at",
                    ReadSupport.posArray(pos),
                    "teClass",
                    te.getClass()
                        .getName(),
                    "hint",
                    "该位置可用 read.te 读其权威状态；本题只读实现了 IInventory 的容器"));
        }
        IInventory inv = (IInventory) te;
        JsonObject c = new JsonObject();
        c.add("at", ReadSupport.posArray(pos));
        c.addProperty(
            "teClass",
            te.getClass()
                .getName());
        c.addProperty("size", inv.getSizeInventory());
        c.addProperty("name", safeName(inv));
        c.addProperty("customName", Boolean.valueOf(safeHasCustomName(inv)));
        c.addProperty("stackLimit", Integer.valueOf(safeStackLimit(inv)));
        c.addProperty("slotMeaning", "[0,size) 为该容器自身的槽位编号（模组自定义语义由该容器的 getSizeInventory 定义）");
        c.add("slots", slots(inv, includeEmpty, metaMax));
        o.add("container", c);
    }

    /** 玩家末影箱。 */
    private static void readEnder(JsonObject o, boolean includeEmpty, int metaMax) {
        EntityPlayerMP player = requirePlayer();
        IInventory ender;
        try {
            ender = player.getInventoryEnderChest();
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.STATE,
                "末影箱背包不可用: " + t,
                Json.object("action", NAME, "owner", player.getCommandSenderName()));
        }
        if (ender == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "末影箱背包不可用（返回 null）",
                Json.object("action", NAME, "owner", player.getCommandSenderName()));
        }
        JsonObject c = new JsonObject();
        c.addProperty("size", ender.getSizeInventory());
        c.addProperty("name", safeName(ender));
        c.addProperty("owner", player.getCommandSenderName());
        c.add("slots", slots(ender, includeEmpty, metaMax));
        o.add("container", c);
    }

    // ------------------------------------------------------------ 工具

    /**
     * 解析 {@code at} 参数（两种等价写法，只留一个定义点）。
     *
     * <p>
     * 写法一（推荐，与 {@code read.blocks} 的 {@code from/to} 同形）：平铺 {@code "at":[x,y,z]}；
     * 写法二：{@code "at":{"pos":[x,y,z]}}（与固件式动作 {@code shot.multi} 的 bbox 记法一致）。
     * 两种都给且不一致时按平铺的算并报错——不猜调用方想用哪个。
     */
    static int[] parseAt(ActionContext ctx, String field) {
        com.google.gson.JsonElement raw = ctx.param(field);
        if (raw == null) {
            throw CpException.param("缺少必填参数", field, "必填：[x,y,z] 三个整数");
        }
        if (raw.isJsonObject()) {
            return ReadSupport.coords(Json.get(raw.getAsJsonObject(), "pos"), field + ".pos");
        }
        return ReadSupport.coords(raw, field);
    }

    /** 逐槽读数（{@code includeEmpty} 为假时只保留非空槽）。 */
    static JsonArray slots(IInventory inv, boolean includeEmpty, int metaMax) {
        JsonArray out = new JsonArray();
        if (inv == null) {
            return out;
        }
        int size;
        try {
            size = inv.getSizeInventory();
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "读取容器槽位数失败: " + t,
                Json.object(
                    "inventoryClass",
                    inv.getClass()
                        .getName()));
        }
        for (int i = 0; i < size; i++) {
            ItemStack stack = null;
            try {
                stack = inv.getStackInSlot(i);
            } catch (Throwable t) {
                // 单槽读取异常不升级成整次读面失败：该槽以 empty:false + error 出现（可见而非静默）
                JsonObject err = new JsonObject();
                err.addProperty("slot", Integer.valueOf(i));
                err.addProperty("empty", false);
                err.addProperty("error", String.valueOf(t));
                out.add(err);
                continue;
            }
            if (stack == null && !includeEmpty) {
                continue;
            }
            JsonObject slot = ReadSupport.readSlot(null, i, stack);
            if (metaMax != ReadSupport.NBT_MAX_ENTRIES) {
                // 逐次读面声明不同的 NBT 上限时，重算摘要（不改变默认口径）
                slot.add("nbt", nbtWithLimit(stack, metaMax));
            }
            out.add(slot);
        }
        return out;
    }

    /** 按指定条数上限重算 NBT 摘要；无 NBT 返回 null。 */
    private static JsonObject nbtWithLimit(ItemStack stack, int maxEntries) {
        if (stack == null) {
            return null;
        }
        JsonObject full = ReadSupport.nbtSummary(stack.getTagCompound());
        if (full == null) {
            return null;
        }
        JsonObject v = Json.optObject(full, "value");
        if (v != null) {
            JsonObject members = Json.optObject(v, "members");
            if (members != null && Json.size(members) > maxEntries) {
                JsonObject trimmed = new JsonObject();
                int n = 0;
                for (java.util.Map.Entry<String, com.google.gson.JsonElement> e : Json.entries(members)) {
                    if (n++ >= maxEntries) {
                        break;
                    }
                    trimmed.add(e.getKey(), e.getValue());
                }
                v.add("members", trimmed);
                v.addProperty("truncated", true);
                full.addProperty("truncated", true);
            }
        }
        full.addProperty("maxEntries", Integer.valueOf(maxEntries));
        return full;
    }

    private static EntityPlayerMP requirePlayer() {
        EntityPlayerMP player = com.lightning.mod.client.controlplane.mc.WorldRuntime.serverPlayer();
        if (player == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "服务端玩家实体不可用（未进入世界或玩家尚未加入集成服）",
                Json.object("action", NAME, "hint", "先进世界：world.rebuild 或 case.run 的 world 段"));
        }
        return player;
    }

    private static String safeName(IInventory inv) {
        try {
            return inv.getInventoryName();
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean safeHasCustomName(IInventory inv) {
        try {
            return inv.hasCustomInventoryName();
        } catch (Throwable t) {
            return false;
        }
    }

    private static int safeStackLimit(IInventory inv) {
        try {
            return inv.getInventoryStackLimit();
        } catch (Throwable t) {
            return -1;
        }
    }
}
