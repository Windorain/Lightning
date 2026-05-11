package com.lightning.mod.item;

import net.minecraft.creativetab.CreativeTabs;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.network.play.server.S23PacketBlockChange;
import net.minecraft.util.ChatComponentText;
import net.minecraft.world.World;

import com.lightning.mod.LightningMod;
import com.lightning.mod.core.session.ExportSession;
import com.lightning.mod.network.SdeNetwork;
import com.lightning.mod.server.SdePermissions;

public class ItemSdeSelectionTool extends Item {

    public ItemSdeSelectionTool() {
        setCreativeTab(CreativeTabs.tabTools);
        setUnlocalizedName("sde_tool_select");
        setTextureName(LightningMod.MODID + ":sde_tool_select");
        setMaxStackSize(1);
    }

    @Override
    public boolean onBlockStartBreak(ItemStack stack, int x, int y, int z, EntityPlayer player) {
        if (player.worldObj.isRemote) {
            return false;
        }
        if (!(player instanceof EntityPlayerMP)) {
            return false;
        }
        EntityPlayerMP mp = (EntityPlayerMP) player;
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return false;
        }
        ExportSession.get()
            .setPos1Block(x, y, z);
        SdeNetwork.sendSelectionSync(mp);
        /*
         * 创造模式左键客户端常会乐观“打碎”方块，而服务端因本方法 return true 已取消采掘，格子上仍为原方块。
         * 与 Forge 取消交互时一致：对该玩家下发 S23，用服务端世界状态强制回写，避免人端与世界不同步。
         */
        mp.playerNetServerHandler.sendPacket(new S23PacketBlockChange(x, y, z, mp.worldObj));
        mp.addChatMessage(new ChatComponentText("SDE: pos1 已记录（方块）"));
        return true;
    }

    @Override
    public boolean onItemUse(ItemStack stack, EntityPlayer player, World world, int x, int y, int z, int side,
        float hitX, float hitY, float hitZ) {
        if (world.isRemote) {
            return false;
        }
        if (!(player instanceof EntityPlayerMP)) {
            return false;
        }
        EntityPlayerMP mp = (EntityPlayerMP) player;
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return false;
        }
        ExportSession.get()
            .setPos2Block(x, y, z);
        SdeNetwork.sendSelectionSync(mp);
        mp.addChatMessage(new ChatComponentText("SDE: pos2 已记录（方块）"));
        return true;
    }
}
