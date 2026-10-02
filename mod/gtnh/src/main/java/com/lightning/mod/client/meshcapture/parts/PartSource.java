package com.lightning.mod.client.meshcapture.parts;

import com.google.gson.JsonObject;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件来源四元组（契约 {@code format-parts-contract.md} §3 source）：族 / 是否兜底 /
 * 视觉或碰撞 / 档位。逐部件标记，降级可审计（契约 §7.2）。
 */
@SideOnly(Side.CLIENT)
public final class PartSource {

    // ------------------------------------------------------------------ 族（§4 localId 命名空间前缀）
    public static final String FAMILY_AE2 = "ae2";
    public static final String FAMILY_ENDERIO = "eio";
    public static final String FAMILY_FMP = "fmp";
    public static final String FAMILY_GENERIC = "generic";
    public static final String FAMILY_INFERRED = "inferred";

    // ------------------------------------------------------------------ 盒来源（§6.4）
    public static final String PROVENANCE_BOTH = "both";
    public static final String PROVENANCE_COLLISION_DERIVED_VISUAL = "collision-derived-visual";
    public static final String PROVENANCE_VISUAL_ONLY = "visual-only";
    public static final String PROVENANCE_COLLISION_ONLY = "collision-only";
    public static final String PROVENANCE_DEGENERATE = "degenerate";

    // ------------------------------------------------------------------ 档位（§7.1）
    /** 档 1：族权威提供者。 */
    public static final int TIER_FAMILY = 1;
    /** 档 2：通用盒（P1.2 单盒通用提供者）。 */
    public static final int TIER_GENERIC = 2;
    /** 档 3：几何推断（P1.6，永不当主来源）。 */
    public static final int TIER_INFERRED = 3;

    /** 族：ae2 | eio | fmp | generic | inferred（= localId 命名空间前缀，§4）。 */
    public final String family;
    /** 是否兜底（族权威 = false；generic/inferred = true）。 */
    public final boolean fallback;
    /** 盒来源：both | collision-derived-visual | visual-only | collision-only | degenerate。 */
    public final String boxProvenance;
    /** 档位：1=族权威 2=通用盒 3=几何推断。 */
    public final int tier;

    public PartSource(String family, boolean fallback, String boxProvenance, int tier) {
        this.family = family;
        this.fallback = fallback;
        this.boxProvenance = boxProvenance;
        this.tier = tier;
    }

    /** 契约 §3 source 的 JSON 形态。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("family", family);
        o.addProperty("fallback", Boolean.valueOf(fallback));
        o.addProperty("boxProvenance", boxProvenance);
        o.addProperty("tier", Integer.valueOf(tier));
        return o;
    }
}
