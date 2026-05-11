package com.lightning.mod.item;

import cpw.mods.fml.common.registry.GameRegistry;

public final class SdeItems {

    public static ItemSdeSelectionTool selectionTool;
    public static ItemSdeRecordTool recordTool;
    public static ItemSdeNoter noter;

    private SdeItems() {}

    public static void register() {
        selectionTool = new ItemSdeSelectionTool();
        recordTool = new ItemSdeRecordTool();
        noter = new ItemSdeNoter();
        GameRegistry.registerItem(selectionTool, "sde_tool_select");
        GameRegistry.registerItem(recordTool, "sde_tool_record");
        GameRegistry.registerItem(noter, "sde_tool_noter");
    }
}
