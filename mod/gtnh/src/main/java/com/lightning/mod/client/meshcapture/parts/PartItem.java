package com.lightning.mod.client.meshcapture.parts;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonObject;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件物品身份（契约 {@code format-parts-contract.md} §3⑤、§5）。
 *
 * <p>
 * 计数单位 = 可合成物品（硬约束）。一部件可对应多物品（{@code items} 是数组）；
 * 空数组 = 显式"无"。{@code nbtDiscriminator} 是 FMP 材料串等 NBT 级区分键
 * （契约 §10.2 {@code nbt_discriminator}），无则序列化时省略。
 */
@SideOnly(Side.CLIENT)
public final class PartItem {

    public final String registry;
    public final int damage;
    public final int count;
    /** 可空；NBT 级身份区分键（如 FMP 材料串），null 时落盘省略。 */
    public final String nbtDiscriminator;

    public PartItem(String registry, int damage, int count) {
        this(registry, damage, count, null);
    }

    public PartItem(String registry, int damage, int count, String nbtDiscriminator) {
        this.registry = registry;
        this.damage = damage;
        this.count = count;
        this.nbtDiscriminator = nbtDiscriminator;
    }

    /** 从 ItemStack 取物品身份（count 取栈数量；NBT 区分键不由本方法推断）。 */
    public static PartItem fromStack(ItemStack stack) {
        String reg = Item.itemRegistry.getNameForObject(stack.getItem());
        return new PartItem(reg == null ? "<unregistered>" : reg, stack.getItemDamage(), stack.stackSize);
    }

    /**
     * 物品身份键（P1.7 部件图标 iconKey，与 web 统计栏 P2.3/P2.4 约定一致）：
     * {@code registry:damage[#nbtDiscriminator]}。
     */
    public String iconKey() {
        return registry + ":" + damage + (nbtDiscriminator != null ? "#" + nbtDiscriminator : "");
    }

    /** 契约 §3⑤ 的 JSON 形态：{@code {"registry":"...","damage":N,"count":M}}。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("registry", registry);
        o.addProperty("damage", Integer.valueOf(damage));
        o.addProperty("count", Integer.valueOf(count));
        if (nbtDiscriminator != null) {
            o.addProperty("nbtDiscriminator", nbtDiscriminator);
        }
        return o;
    }
}
