package com.lightning.mod.core.session;

import java.util.Locale;

import net.minecraft.world.World;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * <b>录制时所在世界</b>的身份（存档目录名 + 维度），以及「导出时刻的活动世界是否还是它」的显式判据
 * （Gitea #127 第 2 条）。
 *
 * <h2>为什么必须有这个东西</h2>
 *
 * 帧缓冲里存的是 <b>scan 中间态</b>（{@code cellTypes} + 指世界坐标的 {@code worldGrid}），而几何烘焙
 * 发生在<b>导出那一刻</b>。改造前烘焙逐格回查<b>当前活动世界</b>，取到空气就把该格丢成 0（见
 * {@link com.lightning.mod.client.meshcapture.MeshCaptureService}）——于是「同一份缓冲、同一帧、
 * 同一个 {@code frameSha256}」的产物内容会随「导出时人在哪个世界」变化，而哈希一字不变
 * （{@code provenance.frameSha256} 哈希的是缓冲内的 scan 文本）。判据 C2/C3 在这类失真面前全绿。
 *
 * <p>
 * 本类把「这一帧是哪个世界录的」在<b>录制时刻</b>记进帧 JSON（字段 {@value #FIELD}），导出时与活动世界
 * 比对：不一致即 {@code CP-STATE-001} 显式报错（对照 {@code expectFrames} 的同一手法），<b>不写任何产物</b>。
 *
 * <h2>纯数据 + 一处 MC 适配</h2>
 *
 * 解析、比对、序列化都不碰 MC；只有 {@link #ofWorld(World)} 需要世界实例（读存档目录名与维度），
 * 因此「比对规则」可以在纯 JVM 下逐行锁死（{@code CaptureWorldIdentityTest}）。
 */
public final class CaptureWorldIdentity {

    /** 帧 JSON / provenance 里的字段名。 */
    public static final String FIELD = "captureWorld";

    /** 存档目录名；不可解析时为 {@code null}（此时身份<b>不可校验</b>，导出侧必须显式失败而不是放行）。 */
    public final String folder;

    /** 维度 id（{@code world.provider.dimensionId}）。 */
    public final int dimension;

    private CaptureWorldIdentity(String folder, int dimension) {
        this.folder = folder;
        this.dimension = dimension;
    }

    /** 由已知目录名与维度构造。 */
    public static CaptureWorldIdentity of(String folder, int dimension) {
        return new CaptureWorldIdentity(folder, dimension);
    }

    /**
     * 从一个世界对象读身份（<b>唯一</b>的 MC 适配点）。
     *
     * <p>
     * 目录名走 {@code world.getSaveHandler().getWorldDirectoryName()}（与
     * {@code WorldDescriber.folderOf} 同一口径）；取不到时回落到 {@code level.dat} 的 levelName，
     * 再取不到就是 {@code null}（= 不可校验，导出侧会显式报错，不静默放行）。
     *
     * <p>
     * <b>调用方注意</b>：客户端 {@code WorldClient} 的 saveHandler 是占位实现（目录名只会得到
     * {@code none}/{@code MpServer}）。录制侧传的是服务端世界（{@code player.worldObj}），导出侧应传
     * 服务端权威世界（{@code WorldDescriber.currentFolder}）——两处都不能直接喂 {@code mc.theWorld}。
     */
    public static CaptureWorldIdentity ofWorld(World world) {
        if (world == null) {
            return null;
        }
        String folder = null;
        try {
            if (world.getSaveHandler() != null) {
                folder = world.getSaveHandler()
                    .getWorldDirectoryName();
            }
        } catch (Throwable ignored) {
            folder = null;
        }
        if (folder == null || folder.trim()
            .isEmpty()) {
            try {
                folder = world.getWorldInfo() == null ? null
                    : world.getWorldInfo()
                        .getWorldName();
            } catch (Throwable ignored) {
                folder = null;
            }
        }
        int dim = 0;
        try {
            dim = world.provider == null ? 0 : world.provider.dimensionId;
        } catch (Throwable ignored) {
            dim = 0;
        }
        return new CaptureWorldIdentity(
            folder == null || folder.trim()
                .isEmpty() ? null : folder.trim(),
            dim);
    }

    /** 是否可用于校验（目录名可解析）。 */
    public boolean resolvable() {
        return folder != null && !folder.isEmpty();
    }

    /** 产物/帧里写下的形状：{@code {folder, dimension}}（folder 为 null 时如实写 null，不编造）。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        if (folder == null) {
            o.add(FIELD_FOLDER, com.google.gson.JsonNull.INSTANCE);
        } else {
            o.addProperty(FIELD_FOLDER, folder);
        }
        o.addProperty(FIELD_DIMENSION, dimension);
        return o;
    }

    /** 字段名：目录。 */
    public static final String FIELD_FOLDER = "folder";

    /** 字段名：维度。 */
    public static final String FIELD_DIMENSION = "dimension";

    /**
     * 从帧 JSON 的 {@code captureWorld} 成员解析。
     *
     * <p>
     * <b>「键在但 folder 是 null」是合法形态</b>（录制时拿不到目录名 ⇒ 如实记 null）：它解析成一个
     * {@link #resolvable()} 为 false 的身份，导出侧据此报「不可解析」——比笼统的「没有身份」更精确。
     * <b>形态坏掉</b>（不是对象、缺 dimension、类型不符）才返回 {@code null}（调用方同样显式报错，
     * 不猜「大概是同一个世界」）。
     */
    public static CaptureWorldIdentity parse(JsonElement e) {
        if (e == null || !e.isJsonObject()) {
            return null;
        }
        JsonObject o = e.getAsJsonObject();
        JsonElement f = o.get(FIELD_FOLDER);
        if (f == null) {
            return null;
        }
        String folder;
        if (f.isJsonNull()) {
            folder = null;
        } else if (f.isJsonPrimitive() && f.getAsJsonPrimitive()
            .isString()) {
                folder = f.getAsString();
            } else {
                return null;
            }
        JsonElement d = o.get(FIELD_DIMENSION);
        if (d == null || !d.isJsonPrimitive()
            || !d.getAsJsonPrimitive()
                .isNumber()) {
            return null;
        }
        return new CaptureWorldIdentity(folder, d.getAsInt());
    }

    /**
     * 比对判据（<b>纯函数</b>，可在纯 JVM 下逐行锁死）。
     *
     * @param expected 录制时刻的世界身份（来自帧/provenance）；null = 该帧没记
     * @param actual   导出时刻活动世界的身份；null = 读不到
     * @return 一致时返回 {@code null}；否则返回人读的「为什么不能导出」原因
     */
    public static String mismatchReason(CaptureWorldIdentity expected, CaptureWorldIdentity actual) {
        if (expected == null) {
            return "该帧没有录制世界身份（缺 " + FIELD + "：缓冲可能来自本契约之前的版本，或帧被手工构造）";
        }
        if (!expected.resolvable()) {
            return "录制世界身份不可解析（" + FIELD + "." + FIELD_FOLDER + " 缺失）：无法校验这帧属于哪个世界";
        }
        if (actual == null) {
            return "导出时刻的活动世界不可读（拿不到存档目录名）：无法校验录制世界";
        }
        if (!actual.resolvable()) {
            return "导出时刻的活动世界不可读（拿不到存档目录名，可能是客户端世界占位实现）：无法校验录制世界";
        }
        if (!expected.folder.equals(actual.folder)) {
            return "世界不同：该帧录制于 " + expected.folder + "，导出时刻活动世界是 " + actual.folder;
        }
        if (expected.dimension != actual.dimension) {
            return "维度不同：该帧录制于维度 " + expected.dimension + "，导出时刻活动维度是 " + actual.dimension;
        }
        return null;
    }

    /** 人读描述（错误上下文与日志用）。 */
    public String describe() {
        return "folder=" + (folder == null ? "(不可解析)" : folder) + ",dimension=" + dimension;
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof CaptureWorldIdentity)) {
            return false;
        }
        CaptureWorldIdentity o = (CaptureWorldIdentity) other;
        if (dimension != o.dimension) {
            return false;
        }
        return folder == null ? o.folder == null : folder.equals(o.folder);
    }

    @Override
    public int hashCode() {
        return (folder == null ? 0
            : folder.toLowerCase(Locale.ROOT)
                .hashCode())
            * 31 + dimension;
    }

    /** 便于日志与测试。 */
    @Override
    public String toString() {
        return describe();
    }
}
