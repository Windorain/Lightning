package com.lightning.mod.client.registry;

import java.io.IOException;

import net.minecraft.client.Minecraft;
import net.minecraft.util.ResourceLocation;

import com.lightning.mod.client.export.ExportTextureLocator;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/** 客户端：locator 对应 PNG 是否在资源包中（供 block_registry 策略使用）。 */
@SideOnly(Side.CLIENT)
public final class BlockRegistryTextureProbe {

    private BlockRegistryTextureProbe() {}

    public static boolean texturePngExistsForLocator(Minecraft mc, String locator) {
        String norm = ExportTextureLocator.normalizeLocatorForBundle(locator);
        if (norm == null) {
            return false;
        }
        for (ResourceLocation texLoc : ExportTextureLocator.texturePngResourceLocationsForBundle(norm)) {
            if (resourceExists(mc, texLoc)) {
                return true;
            }
        }
        return false;
    }

    private static boolean resourceExists(Minecraft mc, ResourceLocation loc) {
        try {
            mc.getResourceManager()
                .getResource(loc);
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
