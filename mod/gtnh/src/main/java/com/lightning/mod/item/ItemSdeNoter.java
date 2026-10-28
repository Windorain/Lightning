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
import com.lightning.mod.core.session.SdeCellCoords;
import com.lightning.mod.core.session.SelectionSnapshot;
import com.lightning.mod.network.SdeNetwork;
import com.lightning.mod.server.SdePermissions;

/**
 * Shift+右键方块：编辑当前活动帧、该体素格的 Wiki 备注（写入 {@code sdeCellNotes} → 烘焙后 ToolTip）。
 */
public class ItemSdeNoter extends Item {

    public ItemSdeNoter() {
        setCreativeTab(CreativeTabs.tabTools);
        setUnlocalizedName("sde_tool_noter");
        setTextureName(LightningMod.MODID + ":sde_tool_record");
        setMaxStackSize(1);
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
        if (!player.isSneaking()) {
            return false;
        }
        EntityPlayerMP mp = (EntityPlayerMP) player;
        if (!SdePermissions.canUseSde(mp)) {
            mp.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return true;
        }
        ExportSession s = ExportSession.get();
        if (!s.isInSession()) {
            mp.addChatMessage(new ChatComponentText("SDE: 请先 /sde start"));
            return true;
        }
        if (!s.hasCompleteSelection()) {
            mp.addChatMessage(new ChatComponentText("SDE: 请先设 pos1 与 pos2"));
            return true;
        }
        SelectionSnapshot snap = s.getSelectionSnapshot();
        if (!snap.complete) {
            mp.addChatMessage(new ChatComponentText("SDE: 请先设 pos1 与 pos2"));
            return true;
        }
        int[] zrc = new int[3];
        if (!SdeCellCoords
            .tryWorldToCell(x, y, z, snap.minX, snap.minY, snap.minZ, snap.maxX, snap.maxY, snap.maxZ, zrc)) {
            mp.addChatMessage(new ChatComponentText("SDE: 该方块不在当前选区内"));
            return true;
        }
        int frame = s.getActiveFrame();
        String initial = s.getCellNote(frame, zrc[0], zrc[1], zrc[2]);
        SdeNetwork.sendOpenCellNote(mp, frame, zrc[0], zrc[1], zrc[2], initial);
        return true;
    }
}
