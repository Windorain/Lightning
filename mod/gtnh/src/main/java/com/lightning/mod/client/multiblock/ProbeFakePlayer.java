package com.lightning.mod.client.multiblock;

import java.util.UUID;

import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.stats.StatBase;
import net.minecraft.util.ChunkCoordinates;
import net.minecraft.util.DamageSource;
import net.minecraft.util.IChatComponent;
import net.minecraft.world.World;

import com.mojang.authlib.GameProfile;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 探针假玩家：GT 多方块的真实建造钩子（{@code ItemStack#onItemUse}）需要一个 {@link EntityPlayer}，
 * 自动放置（{@code survivalConstruct}）也需要一个 actor。本类即参考实现
 * {@code BlockRenderer6343.client.world.ClientFakePlayer} 的等价物。
 */
@SideOnly(Side.CLIENT)
public final class ProbeFakePlayer extends EntityPlayer {

    public static final String NAME = "LightningProbe";

    public ProbeFakePlayer(World world) {
        super(world, new GameProfile(UUID.nameUUIDFromBytes(NAME.getBytes()), NAME));
    }

    @Override
    public void addChatMessage(IChatComponent message) {}

    @Override
    public boolean canCommandSenderUseCommand(int permissionLevel, String command) {
        return false;
    }

    @Override
    public ChunkCoordinates getPlayerCoordinates() {
        return new ChunkCoordinates(0, 0, 0);
    }

    @Override
    public void addChatComponentMessage(IChatComponent message) {}

    @Override
    public void addStat(StatBase stat, int amount) {}

    @Override
    public void openGui(Object mod, int modGuiId, World world, int x, int y, int z) {}

    @Override
    public boolean isEntityInvulnerable() {
        return true;
    }

    @Override
    public boolean canAttackPlayer(EntityPlayer player) {
        return false;
    }

    @Override
    public void onDeath(DamageSource source) {}

    @Override
    public void onUpdate() {}

    @Override
    public void travelToDimension(int dimension) {}
}
