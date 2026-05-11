package com.lightning.mod.core.registry.gt;

import net.minecraft.block.Block;

/** GregTech 方块类反射：无编译期依赖 GT。 */
public final class GregTechBlockReflection {

    private GregTechBlockReflection() {}

    public static boolean isInstance(Block block, String binaryClassName) {
        if (block == null) {
            return false;
        }
        try {
            Class<?> c = Class.forName(binaryClassName, false, GregTechBlockReflection.class.getClassLoader());
            return c.isInstance(block);
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }
}
