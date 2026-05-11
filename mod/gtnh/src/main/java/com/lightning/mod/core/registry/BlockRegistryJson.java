package com.lightning.mod.core.registry;

import net.minecraft.block.Block;

import com.google.gson.JsonObject;

/** BlockRegistry（Wiki）JSON 片段辅助；与 material_registry 正交。 */
public final class BlockRegistryJson {

    private BlockRegistryJson() {}

    /** 未命中任何策略时的占位：{@code meshKind: Unknown}、空 faces。 */
    public static void writeUnknownEntry(JsonObject entry, Block block) {
        entry.addProperty("occludesAdjacentFaces", block.isOpaqueCube());
        entry.addProperty("meshKind", "Unknown");
        entry.add("faces", new JsonObject());
    }
}
