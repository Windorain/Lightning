package com.lightning.mod.client.meshcapture.finish;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * JABBA 桶 ISBRH 双通道渲染会在 Pass 2 给全部六个面带 {@code barrel_label} 材质。
 * 本策略按面对 quad 去重，优先保留非 {@code barrel_label} 材质，覆盖掉 Pass 2 的错误面。
 */
@SideOnly(Side.CLIENT)
public final class JabbaBarrelDedupFinisher implements BlockCaptureFinishStrategy {

    private static final int PRIORITY = 200;
    private static final double EPS = 0.01;

    @Override
    public int priority() {
        return PRIORITY;
    }

    @Override
    public boolean applies(BlockCaptureFinishContext ctx) {
        String key = ctx.getRegistryKey();
        if (key.isEmpty()) return false;
        String lower = key.toLowerCase(Locale.ROOT);
        return lower.equals("jabba:barrel");
    }

    @Override
    public void finish(BlockCaptureFinishContext ctx) {
        List<CapturedQuad> quads = ctx.getQuads();
        if (quads.isEmpty()) return;

        // Group quads by face, preserving order within each face
        Map<Integer, List<CapturedQuad>> byFace = new LinkedHashMap<>();
        for (CapturedQuad q : quads) {
            int face = detectFace(q);
            List<CapturedQuad> group = byFace.computeIfAbsent(face, k -> new ArrayList<>());
            group.add(q);
        }

        // For each face, keep best quad and remove the rest
        List<CapturedQuad> toRemove = new ArrayList<>();
        for (Map.Entry<Integer, List<CapturedQuad>> entry : byFace.entrySet()) {
            List<CapturedQuad> group = entry.getValue();
            if (group.size() <= 1) continue;

            CapturedQuad best = group.get(0);
            for (int i = 1; i < group.size(); i++) {
                CapturedQuad q = group.get(i);
                if (!isLabelMaterial(q.materialKey) && isLabelMaterial(best.materialKey)) {
                    toRemove.add(best);
                    best = q;
                } else {
                    toRemove.add(q);
                }
            }
            // Re-check: if best is still label material, keep only the first label quad
            // (this handles the label face where both passes use barrel_label)
        }

        quads.removeAll(toRemove);
    }

    /**
     * Detect which face a quad is on using world-space coordinates (pre-normalization).
     * The face is identified by the constant axis and the integer part of its coordinate.
     */
    private static int detectFace(CapturedQuad q) {
        double minX = Double.POSITIVE_INFINITY, maxX = Double.NEGATIVE_INFINITY;
        double minY = Double.POSITIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        double minZ = Double.POSITIVE_INFINITY, maxZ = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < q.vertices.size(); i++) {
            CapturedVertex v = q.vertices.get(i);
            double wx = v.x - v.tessOffsetX;
            double wy = v.y - v.tessOffsetY;
            double wz = v.z - v.tessOffsetZ;
            minX = Math.min(minX, wx);
            maxX = Math.max(maxX, wx);
            minY = Math.min(minY, wy);
            maxY = Math.max(maxY, wy);
            minZ = Math.min(minZ, wz);
            maxZ = Math.max(maxZ, wz);
        }
        // Use integer coordinate to distinguish faces (works in world space)
        if (maxY - minY < EPS) return 0 * 1000 + (int) Math.round((minY + maxY) * 0.5);
        if (maxZ - minZ < EPS) return 1 * 1000 + (int) Math.round((minZ + maxZ) * 0.5);
        if (maxX - minX < EPS) return 2 * 1000 + (int) Math.round((minX + maxX) * 0.5);
        return -1;
    }

    private static boolean isLabelMaterial(String materialKey) {
        if (materialKey == null) return false;
        return materialKey.contains("barrel_label");
    }
}
