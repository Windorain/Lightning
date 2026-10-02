package com.lightning.mod.client.multiblock;

import net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 单台多方块的 T0.3 探针：假世界真实构建 → 驱动运行态 → 两态烘焙几何 → 内容签名比对。
 * <p>
 * 「运行态」严格分两段写进结果，避免夸大：{@code trace.activeMechanism} 说明活动位是**状态机派生**（
 * {@code onPostTick} 的 {@code setActive(mMaxProgresstime > 0)}）还是**公开逃生门**（{@code IMachineProgress#setActive}）。
 * 两态的几何都是同一条渲染管线（主批次 + 后渲染/TESR 补画）真实烘焙出来的，没有任何合成。
 */
@SideOnly(Side.CLIENT)
public final class RunStateProbe {

    private RunStateProbe() {}

    public static JsonObject probeOne(ProbeTarget target) {
        JsonObject root = new JsonObject();
        root.addProperty("probe", "T0.3 run-state reachability");
        root.addProperty("probeSchema", 1);
        root.addProperty("targetFqcn", target.fqcn);
        root.addProperty("targetLabel", target.label);
        root.addProperty("metaTileId", target.metaTileId);
        root.addProperty("targetStackForm", target.describeStackForm());
        root.addProperty("targetImplementsIMTERenderer", target.hasTesr());

        MultiblockWorldBuilder.BuildResult build;
        try {
            build = MultiblockWorldBuilder.build(target);
        } catch (Throwable t) {
            root.addProperty("status", "build-threw");
            root.addProperty(
                "failure",
                t.getClass()
                    .getName() + ": "
                    + t.getMessage());
            return root;
        }

        JsonObject world = new JsonObject();
        world.addProperty(
            "dummyWorldClass",
            build.world.getClass()
                .getName());
        world.addProperty("dummyWorldIsRemote", build.world.isRemote);
        world.addProperty("controllerPos", build.x + "," + build.y + "," + build.z);
        world.addProperty("controllerPlaced", build.controllerPlaced);
        world.addProperty("controllerBlock", String.valueOf(build.controllerBlock));
        world.addProperty("controllerMeta", build.controllerMeta);
        world.addProperty("structureBuilt", build.structureBuilt);
        world.addProperty("structureMode", build.structureMode);
        world.addProperty("nonAirBlocksAfterBuild", build.world.nonAirCount());
        world.addProperty("blocksPlacedCounter", build.world.blocksPlaced());
        world.addProperty("hatchCandidateTries", build.hatchCandidateTries);
        world.addProperty("machineFormedAfterHatchSearch", build.machineFormed);
        JsonArray hatchPlacements = new JsonArray();
        for (String h : build.hatchPlacements) {
            hatchPlacements.add(new JsonPrimitive(h));
        }
        world.add("hatchPlacements", hatchPlacements);
        JsonArray structureErrors = new JsonArray();
        for (String e : build.structureErrors) {
            structureErrors.add(new JsonPrimitive(e));
        }
        world.add("structureErrorsAfterSkeleton", structureErrors);
        world.addProperty("hatchCountsAfterSkeleton", build.hatchCounts);
        world.addProperty("coilLevelAfterSkeleton", build.coilLevel);
        world.addProperty("errorDisplayIdAfterSkeleton", build.errorDisplayId);
        if (build.failure != null) {
            world.addProperty("failure", build.failure);
        }
        JsonArray buildNotes = new JsonArray();
        for (String n : build.notes) {
            buildNotes.add(new JsonPrimitive(n));
        }
        world.add("notes", buildNotes);
        root.add("world", world);

        if (!build.controllerPlaced) {
            root.addProperty("status", "controller-not-placed");
            return root;
        }

        RunStateDriver.Trace trace = RunStateDriver.drive(build, target);
        root.add("runStateTrace", traceToJson(trace));

        boolean escape = !trace.stateMachineDerivedActive && target.allowEscapeHatch;

        // ---------------- 两态捕获 ----------------
        StateGeometryCapture.StateCapture idle = captureState(build, trace, "idle", 0, escape);
        StateGeometryCapture.StateCapture active = captureState(
            build,
            trace,
            "active",
            RunStateDriver.SIMULATED_MAX_PROGRESS,
            escape);
        // 立即把活动位放下，缩小 TESR/后处理延迟渲染的窗口
        try {
            build.baseTile.setActive(false);
        } catch (Throwable ignored) {
            // 收尾失败不影响已捕获的证据
        }

        StateGeometryCapture.Diff diff = StateGeometryCapture.diff(idle, active);

        JsonObject states = new JsonObject();
        states.add("idle", stateToJson(idle, build));
        states.add("active", stateToJson(active, build));
        root.add("states", states);

        JsonObject diffJson = new JsonObject();
        diffJson.addProperty("quadCountIdle", diff.quadCountIdle);
        diffJson.addProperty("quadCountActive", diff.quadCountActive);
        diffJson.addProperty("addedQuads", diff.addedQuads);
        diffJson.addProperty("removedQuads", diff.removedQuads);
        diffJson.addProperty("differingQuads", diff.differingQuads);
        diffJson.addProperty("changedPositions", diff.changedPositions);
        diffJson.addProperty("signaturesIdentical", diff.signaturesIdentical);
        diffJson.add("onlyIdleMaterials", toArray(diff.onlyIdleMaterials));
        diffJson.add("onlyActiveMaterials", toArray(diff.onlyActiveMaterials));
        diffJson.add("changedPositionDetails", toArray(diff.changedPositionDetails));
        root.add("diff", diffJson);

        JsonObject tesr = new JsonObject();
        boolean hasSpecialRenderer = false;
        try {
            hasSpecialRenderer = TileEntityRendererDispatcher.instance.hasSpecialRenderer(build.tileEntity);
        } catch (Throwable ignored) {
            // 渲染器查询失败按 false 记录
        }
        tesr.addProperty(
            "controllerTileEntityClass",
            build.tileEntity == null ? "null"
                : build.tileEntity.getClass()
                    .getName());
        tesr.addProperty("controllerTileEntityHasSpecialRenderer", hasSpecialRenderer);
        tesr.addProperty("metaTileImplementsIMTERenderer", target.hasTesr());
        tesr.addProperty("tesrTessellatorQuadsIdle", idle.dynamicExtensionQuads);
        tesr.addProperty("tesrTessellatorQuadsActive", active.dynamicExtensionQuads);
        root.add("tesr", tesr);

        root.addProperty("status", "ok");
        root.addProperty("reachable", diff.differingQuads > 0);
        return root;
    }

    private static StateGeometryCapture.StateCapture captureState(MultiblockWorldBuilder.BuildResult build,
        RunStateDriver.Trace trace, String name, int maxProgress, boolean escape) {
        // 建立捕获前的状态：字段 + （必要时）公开逃生门
        build.multi.mProgresstime = 0;
        build.multi.mMaxProgresstime = maxProgress;
        if (escape) {
            build.baseTile.setActive(maxProgress > 0);
        } else {
            try {
                build.multi.onPostTick(build.baseTile, RunStateDriver.STATE_MACHINE_TICKS + 1000);
            } catch (Throwable ex) {
                trace.notes.add("捕获 " + name + " 前 onPostTick 抛出: " + ex);
            }
        }
        boolean activeObserved = build.baseTile.isActive();
        return StateGeometryCapture.capture(build.world, name, activeObserved, build.x, build.y, build.z, build.player);
    }

    private static JsonObject traceToJson(RunStateDriver.Trace t) {
        JsonObject o = new JsonObject();
        o.addProperty("dummyWorldIsRemote", t.worldIsRemote);
        o.addProperty("serverSideByWorldFlag", t.serverSideByWorldFlag);
        o.addProperty("errorDisplayIdBefore", t.errorDisplayIdBefore);
        o.addProperty("errorDisplayIdAfterRealPathTicks", t.errorDisplayIdAfterRealPathTicks);
        o.addProperty("serverBranchExecuted", t.serverBranchExecuted);
        o.addProperty("realPathTicks", RunStateDriver.REAL_PATH_TICKS);
        if (t.realPathException != null) {
            o.addProperty("realPathException", t.realPathException);
        }
        o.addProperty("stateMachineTicks", t.stateMachineTicks);
        o.addProperty("structureCheckTick", t.structureCheckTick);
        o.addProperty("machineFormedByDriver", t.machineFormedByDriver);
        o.addProperty("repairStatus", t.repairStatus);
        o.addProperty("idealStatus", t.idealStatus);
        o.addProperty("allowedToWork", t.allowedToWork);
        o.addProperty("startUpCheckAtEnd", t.startUpCheckAtEnd);
        if (t.stateMachineException != null) {
            o.addProperty("stateMachineException", t.stateMachineException);
        }
        JsonArray steps = new JsonArray();
        for (RunStateDriver.DerivationStep s : t.derivation) {
            JsonObject so = new JsonObject();
            so.addProperty("phase", s.phase);
            so.addProperty("mMaxProgresstime", s.maxProgressTime);
            so.addProperty("mProgresstime", s.progressTime);
            so.addProperty("isActiveAfterOnPostTick", s.activeAfterTick);
            so.addProperty("errorDisplayId", s.errorDisplayId);
            steps.add(so);
        }
        o.add("derivation", steps);
        o.addProperty("stateMachineDerivedActive", t.stateMachineDerivedActive);
        o.addProperty("activeMechanism", t.activeMechanism);
        o.add("notes", toArray(t.notes));
        return o;
    }

    private static JsonObject stateToJson(StateGeometryCapture.StateCapture c,
        MultiblockWorldBuilder.BuildResult build) {
        JsonObject o = new JsonObject();
        o.addProperty("activeObserved", c.activeObserved);
        o.addProperty("blockCount", c.blockCount);
        o.addProperty("quadCount", c.quadCount);
        o.addProperty("dynamicExtensionQuads", c.dynamicExtensionQuads);
        o.addProperty("signature", c.signature);
        o.add("materialQuadCounts", mapToJson(c.materialQuadCounts));
        o.add("bindHintQuadCounts", mapToJson(c.bindHintQuadCounts));
        JsonArray samples = new JsonArray();
        for (String s : c.controllerSamples) {
            samples.add(new JsonPrimitive(s));
        }
        o.add("controllerQuadSamples", samples);
        o.add("captureErrors", toArray(c.errors));
        return o;
    }

    private static JsonObject mapToJson(java.util.Map<String, Integer> map) {
        JsonObject o = new JsonObject();
        for (java.util.Map.Entry<String, Integer> e : map.entrySet()) {
            o.addProperty(e.getKey(), e.getValue());
        }
        return o;
    }

    private static JsonArray toArray(java.util.List<String> list) {
        JsonArray a = new JsonArray();
        for (String s : list) {
            a.add(new JsonPrimitive(s));
        }
        return a;
    }
}
