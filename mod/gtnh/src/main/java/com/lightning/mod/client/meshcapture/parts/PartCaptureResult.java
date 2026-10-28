package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 三档兜底流水线一格的采集结果（契约 {@code format-parts-contract.md} §7）。
 *
 * <ul>
 * <li>{@link #hostFullCube} = true ⇒ 满方块快速否定命中（§1），该格走现有路径零改动，
 * 不发射任何部件数据；</li>
 * <li>{@link #parts} 非空 ⇒ 该格部件列表，档位见 {@link #tier}（每条 PartRecord 的 source
 * 四元组逐部件标记，§3）；</li>
 * <li>{@link #notes} —— 流水线级备注（如"档 3 未实现"、localId 冲突改名记录）；</li>
 * <li>{@link #providerFailures} —— 逐提供者失败留痕（契约 §7 降级记录）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class PartCaptureResult {

    public final boolean hostFullCube;
    public final List<PartRecord> parts;
    /** 产出档位：0 = 无产出（含满方块与三档全空）；1/2/3 见 {@link PartSource}。 */
    public final int tier;
    public final List<String> notes;
    public final List<String> providerFailures;

    private PartCaptureResult(boolean hostFullCube, List<PartRecord> parts, int tier, List<String> notes,
        List<String> providerFailures) {
        this.hostFullCube = hostFullCube;
        this.parts = parts;
        this.tier = tier;
        this.notes = notes;
        this.providerFailures = providerFailures;
    }

    /** 满方块快速否定结果（§1：走现有路径零改动，零额外开销）。 */
    public static PartCaptureResult fullCube() {
        return new PartCaptureResult(
            true,
            new ArrayList<PartRecord>(),
            0,
            new ArrayList<String>(),
            new ArrayList<String>());
    }

    public static PartCaptureResult of(List<PartRecord> parts, int tier, List<String> notes,
        List<String> providerFailures) {
        return new PartCaptureResult(false, parts, tier, notes, providerFailures);
    }

    /** 调试/探针落盘形态（生产导出落盘按契约 §2 的 cellPartsGrid/partLists 表达）。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("hostFullCube", Boolean.valueOf(hostFullCube));
        o.addProperty("tier", Integer.valueOf(tier));
        JsonArray partArr = new JsonArray();
        for (PartRecord p : parts) {
            partArr.add(p.toJson());
        }
        o.add("parts", partArr);
        JsonArray noteArr = new JsonArray();
        for (String n : notes) {
            noteArr.add(new JsonPrimitive(n));
        }
        o.add("notes", noteArr);
        JsonArray failArr = new JsonArray();
        for (String f : providerFailures) {
            failArr.add(new JsonPrimitive(f));
        }
        o.add("providerFailures", failArr);
        return o;
    }
}
