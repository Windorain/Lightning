package com.lightning.mod.item;

import net.minecraft.creativetab.CreativeTabs;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.ChatComponentText;
import net.minecraft.world.World;

import com.lightning.mod.LightningMod;
import com.lightning.mod.core.session.ExportSession;
import com.lightning.mod.server.SdePermissions;

public class ItemSdeRecordTool extends Item {

    public ItemSdeRecordTool() {
        setCreativeTab(CreativeTabs.tabTools);
        setUnlocalizedName("sde_tool_record");
        setTextureName(LightningMod.MODID + ":sde_tool_record");
        setMaxStackSize(1);
    }

    @Override
    public ItemStack onItemRightClick(ItemStack stack, World world, EntityPlayer player) {
        if (world.isRemote) {
            return stack;
        }
        if (!(player instanceof EntityPlayerMP)) {
            return stack;
        }
        EntityPlayerMP mp = (EntityPlayerMP) player;
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return stack;
        }
        ExportSession s = ExportSession.get();
        if (!s.isInSession()) {
            mp.addChatMessage(new ChatComponentText("SDE: 请先 /sde start"));
            return stack;
        }
        if (!s.hasCompleteSelection()) {
            mp.addChatMessage(new ChatComponentText("SDE: 请先设 pos1 与 pos2"));
            return stack;
        }
        try {
            s.record(mp);
            mp.addChatMessage(new ChatComponentText("SDE: 已写入内存帧 " + s.getActiveFrame() + "（未落盘）"));
        } catch (Exception e) {
            mp.addChatMessage(new ChatComponentText("SDE: " + e.getMessage()));
        }
        return stack;
    }
}
