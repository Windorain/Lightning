package com.lightning.mod.item;

import net.minecraft.creativetab.CreativeTabs;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.network.play.server.S23PacketBlockChange;
import net.minecraft.util.ChatComponentText;
import net.minecraft.world.World;

import com.lightning.mod.LightningMod;
import com.lightning.mod.core.session.ExportSession;
import com.lightning.mod.network.SdeNetwork;
import com.lightning.mod.server.SdePermissions;

public class ItemSdeSelectionTool extends Item {

    private static final String NBT_POS1_X = "sde_pos1x";
    private static final String NBT_POS1_Y = "sde_pos1y";
    private static final String NBT_POS1_Z = "sde_pos1z";
    private static final String NBT_POS2_X = "sde_pos2x";
    private static final String NBT_POS2_Y = "sde_pos2y";
    private static final String NBT_POS2_Z = "sde_pos2z";
    private static final String NBT_EXPORT_NAME = "sde_exportName";

    public ItemSdeSelectionTool() {
        setCreativeTab(CreativeTabs.tabTools);
        setUnlocalizedName("sde_tool_select");
        setTextureName("stick");
        setMaxStackSize(1);
    }

    @Override
    public boolean onBlockStartBreak(ItemStack stack, int x, int y, int z, EntityPlayer player) {
        if (player.worldObj.isRemote || !(player instanceof EntityPlayerMP)) return false;
        EntityPlayerMP mp = (EntityPlayerMP) player;
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return false;
        }
        ExportSession.get().setPos1Block(x, y, z);
        writePos1ToNbt(stack, x, y, z);
        SdeNetwork.sendSelectionSync(mp);
        mp.playerNetServerHandler.sendPacket(new S23PacketBlockChange(x, y, z, mp.worldObj));
        mp.addChatMessage(new ChatComponentText("SDE: pos1 已记录（" + x + " " + y + " " + z + "）"));
        return true;
    }

    @Override
    public boolean onItemUse(ItemStack stack, EntityPlayer player, World world, int x, int y, int z, int side,
        float hitX, float hitY, float hitZ) {
        if (world.isRemote || !(player instanceof EntityPlayerMP)) return false;
        EntityPlayerMP mp = (EntityPlayerMP) player;
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return false;
        }
        if (player.isSneaking()) {
            return doQuickExport(stack, mp);
        }
        ExportSession.get().setPos2Block(x, y, z);
        writePos2ToNbt(stack, x, y, z);
        SdeNetwork.sendSelectionSync(mp);
        mp.addChatMessage(new ChatComponentText("SDE: pos2 已记录（" + x + " " + y + " " + z + "）"));
        return true;
    }

    @Override
    public ItemStack onItemRightClick(ItemStack stack, World world, EntityPlayer player) {
        if (world.isRemote || !(player instanceof EntityPlayerMP)) return stack;
        if (player.isSneaking()) {
            doQuickExport(stack, (EntityPlayerMP) player);
        }
        return stack;
    }

    private boolean doQuickExport(ItemStack stack, EntityPlayerMP mp) {
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return false;
        }
        int[] p1 = readPosFromNbt(stack, NBT_POS1_X, NBT_POS1_Y, NBT_POS1_Z);
        int[] p2 = readPosFromNbt(stack, NBT_POS2_X, NBT_POS2_Y, NBT_POS2_Z);
        if (p1 == null || p2 == null) {
            mp.addChatMessage(new ChatComponentText("SDE: 魔杖未记录完整选区，请先左键设 pos1，右键设 pos2"));
            return false;
        }
        try {
            ExportSession s = ExportSession.get();
            if (!s.isInSession()) s.startSession();
            s.setPos1Block(p1[0], p1[1], p1[2]);
            s.setPos2Block(p2[0], p2[1], p2[2]);
            String name = getExportName(stack);
            s.setOutputName(name);
            s.record(mp);
            String path = s.exportToFile();
            java.io.File outFile = new java.io.File(path);
            byte[] payload = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path));
            SdeNetwork.sendEnrichExportedScene(mp, outFile.getName(), payload, false);
            mp.addChatMessage(new ChatComponentText("SDE: 已导出 " + name + " → " + outFile.getName()));
        } catch (Exception e) {
            mp.addChatMessage(new ChatComponentText("SDE 导出失败: " + e.getMessage()));
        }
        return true;
    }

    private static void writePos1ToNbt(ItemStack stack, int x, int y, int z) {
        NBTTagCompound tag = stack.getTagCompound();
        if (tag == null) {
            tag = new NBTTagCompound();
            stack.setTagCompound(tag);
        }
        tag.setInteger(NBT_POS1_X, x);
        tag.setInteger(NBT_POS1_Y, y);
        tag.setInteger(NBT_POS1_Z, z);
    }

    private static void writePos2ToNbt(ItemStack stack, int x, int y, int z) {
        NBTTagCompound tag = stack.getTagCompound();
        if (tag == null) {
            tag = new NBTTagCompound();
            stack.setTagCompound(tag);
        }
        tag.setInteger(NBT_POS2_X, x);
        tag.setInteger(NBT_POS2_Y, y);
        tag.setInteger(NBT_POS2_Z, z);
    }

    private static int[] readPosFromNbt(ItemStack stack, String keyX, String keyY, String keyZ) {
        NBTTagCompound tag = stack.getTagCompound();
        if (tag == null) return null;
        if (!tag.hasKey(keyX) || !tag.hasKey(keyY) || !tag.hasKey(keyZ)) return null;
        return new int[] { tag.getInteger(keyX), tag.getInteger(keyY), tag.getInteger(keyZ) };
    }

    private static String getExportName(ItemStack stack) {
        NBTTagCompound tag = stack.getTagCompound();
        if (tag != null && tag.hasKey(NBT_EXPORT_NAME)) return tag.getString(NBT_EXPORT_NAME);
        return "export";
    }
}
