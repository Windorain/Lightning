package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code world.info}（observe，同步）：当前世界描述。
 *
 * <p>
 * 未在世界中时返回 {@code {loaded:false}}（契约 §4 明写，不算错误——调用方据此决定是否重建）。
 * 在世界中时给出 folder/维度/是否托管（{@code cp_} 前缀 + {@code cp_world.json}）/是否虚空/
 * 世界时刻/生成器参数/出生点/玩家位置。
 */
public final class WorldInfoAction implements ControlAction {

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        JsonObject world = WorldDescriber.describe(mc);
        JsonObject o = new JsonObject();
        o.add("world", world);
        o.addProperty("loaded", Json.optBool(world, "loaded", false));
        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }
}
