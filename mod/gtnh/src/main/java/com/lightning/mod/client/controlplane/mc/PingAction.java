package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code core.ping}（observe，同步）：存活回声。
 *
 * <p>
 * 返回值里带契约版本、版本串与「既有探针是否激活」——调用方据此判断这台客户端是不是
 * 正被别的自动化链占用，以及版本是否匹配（版本不符时不该继续调用场景动作）。
 */
public final class PingAction implements ControlAction {

    private final ControlPlaneRuntime runtime;

    public PingAction(ControlPlaneRuntime runtime) {
        this.runtime = runtime;
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        JsonObject o = new JsonObject();
        o.addProperty("pong", true);
        o.addProperty("contractVersion", Contract.VERSION);
        o.addProperty("prefix", Contract.PREFIX);
        o.add("versions", VersionInfo.aboutVersions());
        o.addProperty(
            "serverTime",
            TimeSource.system()
                .isoNow());
        o.addProperty(
            "uptimeMs",
            runtime != null && runtime.server() != null ? runtime.server()
                .uptimeMillis() : 0L);
        o.addProperty("busy", runtime != null && runtime.busy());
        Minecraft mc = WorldRuntime.mc();
        String probe = ProbeActivity.firstActive(mc);
        o.addProperty("probeActive", probe != null);
        o.addProperty("probe", probe);
        JsonArray caps = new JsonArray();
        Json.add(caps, "world-rebuild");
        Json.add(caps, "world-snapshot");
        Json.add(caps, "world-rollback");
        Json.add(caps, "case-run");
        o.add("capabilities", caps);
        return o;
    }
}
