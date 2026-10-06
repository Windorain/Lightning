package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.IInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.inventory.write}（scene，同步）：逐槽写入玩家背包或世界里某个容器的槽位。
 *
 * <h2>层归属（#96 §4.1 与 裁决 4，本动作是 L0）</h2>
 * 「拿到物品」有两义，<b>两义都做、按层标注</b>：
 * <ul>
 * <li><b>给</b>（本动作，L0）：直接把 {@code {id, meta, count, nbt}} 写进指定槽位。快、稳、少变量，
 * 用于构造输入与布景。它<b>不是</b>「玩家捡起了东西」的证据；</li>
 * <li><b>拾取</b>（#101，L1）：把掉落物放进世界，再经玩家真实路径拾起。验证「拾取行为」用它。</li>
 * </ul>
 * 两条路径的结论不互替（#96 §4.2）。本动作的返回值里带 {@code layer:"L0"} 与
 * {@code semantics:"give"} 两个显式标注，免得下游把布景产物当成行为证据。
 *
 * <h2>两种目标</h2>
 * <ul>
 * <li>{@code target:"player"}（默认）：玩家背包 {@code InventoryPlayer}（{@link IInventory} 实现）。
 * 槽位语义 = <b>{@code InventoryPlayer} 自己的下标</b>（1.7.10 原版 {@code InventoryPlayer}
 * 的 {@code getStackInSlot}/{@code setInventorySlotContents} 映射）：
 * {@code 0..8} 快捷栏（其中 {@code 0} 是当前手持）、{@code 9..35} 主背包、
 * {@code 36..39} 盔甲（脚/腿/胸/头，即 36=靴、37=护腿、38=胸甲、39=头盔）。
 * <b>注意</b>：这与 {@code ContainerPlayer} 的界面槽位号<b>不同</b>（后者含 5 个合成格且顺序错位）；
 * 本动作不走界面语义，故用 {@code InventoryPlayer} 的下标——自述里写死这一点，
 * 免得调用方按界面槽号去写。</li>
 * <li>{@code target:"container"}：世界里某坐标的容器（{@code at:[x,y,z]}），槽位语义 =
 * 该 {@link IInventory} 的 {@code getSizeInventory()} 下标。</li>
 * </ul>
 *
 * <h2>写入与同步</h2>
 * 一律走 {@link IInventory#setInventorySlotContents} + {@link IInventory#markDirty}
 * （原版自身的写入 API），写完对玩家发一次 {@code Container.detectAndSendChanges}
 * （{@code S2FPacketSetSlot}），因此客户端侧同 tick 内即可见。
 * <b>不从静态数据推算回填</b>（契约 §6.4 的既有禁令）。
 */
public final class InventoryWriteAction implements ControlAction {

    /** 单次最多写入的槽位数。 */
    public static final int MAX_SLOTS = 256;

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, "scene.inventory.write");

        String target = ctx.optString("target", "player");
        if (target == null) {
            target = "player";
        }
        target = target.trim()
            .toLowerCase(java.util.Locale.ROOT);
        JsonArray slots = ctx.optArray("slots");
        JsonObject single = ctx.optObject("slot");
        java.util.List<JsonObject> entries = new java.util.ArrayList<JsonObject>();
        if (slots != null) {
            for (int i = 0; i < slots.size(); i++) {
                JsonElement e = slots.get(i);
                if (e == null || !e.isJsonObject()) {
                    throw CpException.param("槽位条目非法", "slots[" + i + "]", "须为 object");
                }
                entries.add(e.getAsJsonObject());
            }
        }
        if (single != null) {
            entries.add(single);
        }
        if (entries.isEmpty()) {
            throw CpException.param("缺少槽位定义", "slots", "给 slots[] 或 slot{} 之一（不可都缺）");
        }
        if (entries.size() > MAX_SLOTS) {
            throw CpException.param("槽位数超出上限", "slots", "单次最多 " + MAX_SLOTS + " 条，收到 " + entries.size());
        }

        EntityPlayerMP player = WorldRuntime.serverPlayer();
        IInventory inv;
        JsonObject targetInfo = new JsonObject();
        boolean isPlayerInventory = false;
        if ("player".equals(target)) {
            if (player == null) {
                throw new CpException(ErrorCodes.STATE, "scene.inventory.write：服务端没有玩家实体——先 world.rebuild 进入托管世界");
            }
            // 用 InventoryPlayer（IInventory 实现，槽位语义 = 0..35 主背包 / 36..39 盔甲），
            // 不用 player.inventoryContainer（那是 Container，含合成格，且是「界面」而非「背包」）。
            inv = player.inventory;
            isPlayerInventory = true;
            targetInfo.addProperty("kind", "player");
            targetInfo.addProperty("player", player.getCommandSenderName());
        } else if ("container".equals(target)) {
            double[] at = EntitySpawnAction.optPos(ctx, "at");
            if (at == null) {
                throw CpException.param("缺少容器坐标", "at", "target=container 时必填 [x,y,z]");
            }
            EntitySpawnAction.checkPos(at, "at");
            int x = (int) Math.floor(at[0]);
            int y = (int) Math.floor(at[1]);
            int z = (int) Math.floor(at[2]);
            TileEntity te = world.getTileEntity(x, y, z);
            if (te == null) {
                throw new CpException(
                    ErrorCodes.STATE,
                    "该位置没有方块实体（不是容器）",
                    Json.object("at", EntitySpawnAction.dblArray(at), "block", blockIdAt(world, x, y, z)));
            }
            if (!(te instanceof IInventory)) {
                throw new CpException(
                    ErrorCodes.STATE,
                    "该位置的方块实体不是容器（未实现 IInventory）",
                    Json.object(
                        "at",
                        EntitySpawnAction.dblArray(at),
                        "block",
                        blockIdAt(world, x, y, z),
                        "teClass",
                        te.getClass()
                            .getName()));
            }
            inv = (IInventory) te;
            targetInfo.addProperty("kind", "container");
            targetInfo.addProperty("at", Json.toJson(EntitySpawnAction.dblArray(at)));
            targetInfo.addProperty(
                "teClass",
                te.getClass()
                    .getName());
        } else {
            throw CpException.param("target 非法", "target", "只允许 player | container，收到: " + target);
        }

        int size = inv.getSizeInventory();
        targetInfo.addProperty("size", Integer.valueOf(size));
        targetInfo.addProperty("inventoryName", safeInventoryName(inv));

        JsonArray written = new JsonArray();
        for (int i = 0; i < entries.size(); i++) {
            written.add(writeOne(inv, entries.get(i), size, "slots[" + i + "]", target));
        }

        try {
            inv.markDirty();
        } catch (Throwable t) {
            CpLog.warn("容器 markDirty 失败（存档可能漏记本次写入）: %s", String.valueOf(t));
        }
        if (player != null && isPlayerInventory) {
            try {
                player.openContainer.detectAndSendChanges();
            } catch (Throwable t) {
                CpLog.warn("玩家背包同步失败（客户端槽位可能滞后一 tick）: %s", String.valueOf(t));
            }
        }

        JsonObject o = new JsonObject();
        o.addProperty("layer", "L0");
        o.addProperty("semantics", "give");
        o.addProperty("layerNote", "L0 直接写入，不是「玩家拾取」的证据（拾取属 L1，#101）；两层结论不互替（case-file.md §8.8）");
        o.add("target", targetInfo);
        o.addProperty("writtenCount", Integer.valueOf(written.size()));
        o.add("written", written);
        o.add("readBack", readBack(inv, written));
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "scene.inventory.write：" + written.size() + " 槽（" + target + "）",
            Json.object("target", target, "writtenCount", Integer.valueOf(written.size())));
        return L0Session.decorated("scene.inventory.write", o, world, mc);
    }

    // ------------------------------------------------------------ 单槽写入

    private JsonObject writeOne(IInventory inv, JsonObject spec, int size, String where, String target) {
        int slot = Json.optInt(spec, "slot", Integer.MIN_VALUE);
        if (slot == Integer.MIN_VALUE) {
            throw CpException.param("缺少 slot", where + ".slot", "必填（整数槽位下标）");
        }
        if (slot < 0 || slot >= size) {
            throw CpException.param(
                "槽位越界",
                where + ".slot",
                "须在 0.." + (size - 1)
                    + "（"
                    + ("player".equals(target) ? "InventoryPlayer 下标：0..8 快捷栏 / 9..35 主背包 / 36..39 盔甲"
                        : "该容器 getSizeInventory()")
                    + "），收到 "
                    + slot);
        }
        ItemStack stack = buildStack(spec, where);
        try {
            inv.setInventorySlotContents(slot, stack);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "写入槽位失败（" + where + " slot=" + slot + "）: " + t,
                Json.object("slot", Integer.valueOf(slot)));
        }
        JsonObject o = new JsonObject();
        o.addProperty("slot", Integer.valueOf(slot));
        if (stack == null) {
            o.addProperty("cleared", true);
        } else {
            o.add("requested", stackSummary(stack));
            ItemStack live = inv.getStackInSlot(slot);
            o.add("actual", stackSummary(live));
            o.addProperty("matches", Boolean.valueOf(sameStack(stack, live)));
        }
        return o;
    }

    /** 由 {@code {id, meta, count, nbt}} 造物品栈；{@code id} 为 null 或 {@code "air"} 表示清空该槽。 */
    private ItemStack buildStack(JsonObject spec, String where) {
        String id = Json.optString(spec, "id", null);
        if (id == null || id.trim()
            .isEmpty()
            || "air".equalsIgnoreCase(id.trim())
            || "minecraft:air".equalsIgnoreCase(id.trim())
            || "0".equals(id.trim())) {
            return null;
        }
        Item item = EntitySpawnAction.resolveItem(id.trim(), where + ".id");
        int meta = Json.optInt(spec, "meta", 0);
        int count = Json.optInt(spec, "count", 1);
        if (count < 1 || count > 64) {
            throw CpException.param("数量非法", where + ".count", "须在 1..64（清空请用 id=air），收到 " + count);
        }
        if (meta < 0 || meta > 32767) {
            throw CpException.param("meta 非法", where + ".meta", "须在 0..32767，收到 " + meta);
        }
        ItemStack stack = new ItemStack(item, count, meta);
        NBTTagCompound tag = EntitySpawnAction.parseNbt(Json.optString(spec, "nbt", null), where + ".nbt");
        if (tag != null) {
            stack.setTagCompound(tag);
        }
        return stack;
    }

    // ------------------------------------------------------------ 读回

    private JsonArray readBack(IInventory inv, JsonArray written) {
        JsonArray out = new JsonArray();
        for (int i = 0; i < written.size(); i++) {
            JsonObject w = written.get(i)
                .getAsJsonObject();
            int slot = Json.optInt(w, "slot", -1);
            if (slot < 0) {
                continue;
            }
            JsonObject r = new JsonObject();
            r.addProperty("slot", Integer.valueOf(slot));
            ItemStack live = inv.getStackInSlot(slot);
            if (live == null || live.getItem() == null) {
                r.addProperty("empty", true);
            } else {
                r.add("stack", stackSummary(live));
            }
            out.add(r);
        }
        return out;
    }

    private static JsonObject stackSummary(ItemStack stack) {
        JsonObject o = new JsonObject();
        if (stack == null || stack.getItem() == null) {
            return o;
        }
        o.addProperty("id", Item.itemRegistry.getNameForObject(stack.getItem()));
        o.addProperty("itemId", Integer.valueOf(Item.getIdFromItem(stack.getItem())));
        o.addProperty("meta", Integer.valueOf(stack.getItemDamage()));
        o.addProperty("count", Integer.valueOf(stack.stackSize));
        o.addProperty("displayName", safeDisplayName(stack));
        o.addProperty("nbtPresent", Boolean.valueOf(stack.getTagCompound() != null));
        if (stack.getTagCompound() != null) {
            o.addProperty(
                "nbtBytes",
                Integer.valueOf(
                    stack.getTagCompound()
                        .toString()
                        .length()));
        }
        return o;
    }

    private static boolean sameStack(ItemStack a, ItemStack b) {
        if (a == null || b == null) {
            return a == b;
        }
        return a.getItem() == b.getItem() && a.getItemDamage() == b.getItemDamage() && a.stackSize == b.stackSize;
    }

    private static String safeDisplayName(ItemStack stack) {
        try {
            return stack.getDisplayName();
        } catch (Throwable t) {
            return null;
        }
    }

    private static String safeInventoryName(IInventory inv) {
        try {
            return inv.getInventoryName();
        } catch (Throwable t) {
            return null;
        }
    }

    private static String blockIdAt(WorldServer world, int x, int y, int z) {
        try {
            net.minecraft.block.Block b = world.getBlock(x, y, z);
            return b == null ? null
                : net.minecraft.block.Block.blockRegistry.getNameForObject(b) + ":" + world.getBlockMetadata(x, y, z);
        } catch (Throwable t) {
            return null;
        }
    }
}
