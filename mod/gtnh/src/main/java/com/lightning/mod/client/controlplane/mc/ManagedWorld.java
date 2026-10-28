package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * 托管世界规则（contract.md §10）。
 *
 * <p>
 * 控制面只操作<b>托管世界</b>：存档目录名以 {@code cp_} 开头且内含
 * {@code cp_world.json}（schema {@code lightning.cp-world/1}，字段
 * {@code seed/void/complete/createdBy}）。对非托管世界的一切写操作拒绝 {@code CP-STATE-001}。
 *
 * <p>
 * 删除存档目录是本模块唯一的破坏性操作，因此有<b>二次确认</b>（{@link #assertDeletable}）：
 * ①目录名以 {@code cp_} 开头且不含路径分隔符/上跳段；②目录解析后必须落在存档根之内；
 * ③目录不存在（首次建世界）或确实带 {@code cp_world.json} 标记。三者缺一即拒绝。
 *
 * <h2>标记前置与 {@code complete} 状态机</h2>
 *
 * <p>
 * 本字段引入前，标记<b>只在重建的最末 MARKER 阶段</b>写：build 阶段失败即在存档根留下
 * 「有世界文件、无标记」的残留——{@link #assertDeletable} 与
 * {@code WorldRebuildRunner.assertManagedIfExists} 都拒绝它，于是<b>没有任何 API 能清掉</b>
 * （实机擒获，只能手工删目录）。修法是<b>标记前置</b>：
 * 世界建好（存档目录由 MC 建立、可以进入）后<b>立刻</b>写一份 {@code complete:false} 的标记，
 * 构建全部成功后<b>改写</b>为 {@code complete:true}。任何中途失败因此都留下「带标记」的残留，
 * 可正常删除/重建。
 *
 * <p>
 * 两个判据必须分清（{@link #hasMarker} 是<b>安全边界</b>，{@link #isComplete} 是<b>可用性边界</b>）：
 * <ul>
 * <li><b>有标记</b>（不论 {@code complete} 取值）= 「曾经开始过」⇒ <b>可以删、可以重建</b>。
 * 这正是修法的落点：失败残留因此可清。无标记的目录<b>仍然一律拒绝</b>（安全属性不回退）。</li>
 * <li><b>{@code complete:true}</b> = 「构建完成的世界」⇒ <b>可以当作成品世界复用</b>（如
 * {@code world.snapshot} 的整目录复制、快照/回滚的成品语义）。</li>
 * </ul>
 *
 * <p>
 * <b>{@code complete:false} 的语义（消费方必须照此判读）</b>：
 * 「曾经开始过、可以删可以重建，但<b>不得</b>当作构建完成的世界复用」——
 * 它的场景可能只铺了一半（build 段中途失败）、TE 补全可能未完成、场景清单可能不存在或过期。
 * 复用判据见 {@link #assertCompleteWorld}；只读描述见
 * {@code WorldDescriber} 的 {@code markerComplete} 字段。
 *
 * <p>
 * 向后兼容：本字段引入前写下的标记<b>没有</b> {@code complete} 键，而那时的标记只在构建完成后
 * 才写，故 {@link #markerComplete} 对缺键按 {@code true} 读（缺键 = 旧代码写的完成标记）；
 * 新代码<b>总是</b>显式写该字段。
 */
public final class ManagedWorld {

    /** 托管世界元数据文件名（= {@link Contract#MANAGED_WORLD_MARKER}）。 */
    public static final String MARKER = Contract.MANAGED_WORLD_MARKER;

    /** 元数据 schema。 */
    public static final String SCHEMA = "lightning.cp-world/1";

    /** 存档目录名前缀。 */
    public static final String PREFIX = Contract.MANAGED_WORLD_PREFIX;

    /** {@code createdAt} 的创造者标记。 */
    public static final String CREATED_BY = "control-plane";

    /** 构建完成标志字段名（见类注释的状态机）。 */
    public static final String FIELD_COMPLETE = "complete";

    private ManagedWorld() {}

    /** 存档目录 {@code <saves>/<folder>}。 */
    public static Path worldDir(File mcDataDir, String folder) {
        return CpPaths.savesRoot(mcDataDir)
            .resolve(folder)
            .normalize();
    }

    /** 目录名是否形态合法（{@code cp_} 前缀 + 安全字符 + 无路径成分）。 */
    public static boolean isManagedFolderName(String folder) {
        if (folder == null || folder.isEmpty() || !folder.startsWith(PREFIX)) {
            return false;
        }
        if (folder.indexOf('/') >= 0 || folder.indexOf('\\') >= 0) {
            return false;
        }
        if (".".equals(folder) || "..".equals(folder)) {
            return false;
        }
        for (int i = 0; i < folder.length(); i++) {
            char c = folder.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c == '_'
                || c == '-'
                || c == '.';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    /** 目录名形态不合法时抛 {@code CP-VALID-002}，否则返回规范化目录。 */
    public static Path requireManagedFolder(File mcDataDir, String folder, String field) {
        if (!isManagedFolderName(folder)) {
            throw CpException.param("托管世界目录名非法", field, "须以 " + PREFIX + " 开头且只含 [A-Za-z0-9_.-]，收到: " + folder);
        }
        Path dir = worldDir(mcDataDir, folder);
        Path root = CpPaths.savesRoot(mcDataDir);
        if (!dir.startsWith(root) || dir.equals(root)) {
            throw CpException.param("托管世界目录越界", field, "解析结果不在存档根之内: " + dir);
        }
        return dir;
    }

    /** 是否带托管标记（<b>安全边界</b>：不区分 {@code complete} 取值，见类注释）。 */
    public static boolean hasMarker(Path worldDir) {
        return worldDir != null && Files.isRegularFile(worldDir.resolve(MARKER));
    }

    /**
     * 标记是否为「构建完成」；<b>没有标记</b>时返回 false。
     *
     * <p>
     * 三种取值分开处理（「失败显式」，不猜）：
     * <ul>
     * <li><b>缺键</b> ⇒ {@code true}：本字段引入前的标记只在构建完成后才写，缺键即旧口径的完成标记
     * （向后兼容，见类注释）；</li>
     * <li><b>布尔值</b> ⇒ 按值读；</li>
     * <li><b>键在但不是布尔</b>（null / 数字 / 字符串）⇒ {@code false}：形态坏掉的标记不能被当作
     * 「大概完成了」，宁可按未完成处理（可删可重建）也不放它进成品复用路径。</li>
     * </ul>
     */
    public static boolean markerComplete(JsonObject marker) {
        if (marker == null) {
            return false;
        }
        if (!marker.has(FIELD_COMPLETE)) {
            return true; // 旧标记（本字段引入前只在完成后写）
        }
        JsonElement e = marker.get(FIELD_COMPLETE);
        if (e == null || !e.isJsonPrimitive()
            || !e.getAsJsonPrimitive()
                .isBoolean()) {
            return false; // 形态坏掉：按未完成处理
        }
        return e.getAsBoolean();
    }

    /**
     * 目录是否为「构建完成」的托管世界（<b>可用性边界</b>：存在 + 带标记 + {@code complete:true}）。
     *
     * <p>
     * 与 {@link #isManaged} 的区别是本修法的核心：{@code isManaged} 回答「能不能删/重建」
     * （带标记即可），本方法回答「能不能当成品复用」（必须构建完成）。
     */
    public static boolean isComplete(Path worldDir) {
        if (worldDir == null || !Files.isDirectory(worldDir) || !hasMarker(worldDir)) {
            return false;
        }
        JsonObject m = readMarker(worldDir);
        // 标记存在但读不出来（损坏/非法 JSON）：不能当成品复用（失败显式，不猜「大概是完成的」）
        return m != null && markerComplete(m);
    }

    /**
     * 目录是否已是托管世界（存在 + 带标记；<b>不</b>要求 {@code complete:true}）。
     *
     * <p>
     * 语义是「这是一个托管目录」（可以删、可以重建），<b>不是</b>「这是一个可复用的成品世界」——
     * 后者用 {@link #isComplete}。需要「能不能当成品复用」的调用方（快照复制等）必须用后者。
     */
    public static boolean isManaged(Path worldDir) {
        return worldDir != null && Files.isDirectory(worldDir) && hasMarker(worldDir);
    }

    /** 读取标记；不存在或不可解析时返回 null。 */
    public static JsonObject readMarker(Path worldDir) {
        if (!hasMarker(worldDir)) {
            return null;
        }
        try {
            String text = new String(Files.readAllBytes(worldDir.resolve(MARKER)), StandardCharsets.UTF_8);
            return Json.parseStrictObject(text);
        } catch (IOException e) {
            CpLog.warn("读取 %s 失败: %s", MARKER, String.valueOf(e));
            return null;
        } catch (JsonSyntaxException e) {
            CpLog.warn("%s 不是合法 JSON: %s", MARKER, String.valueOf(e));
            return null;
        }
    }

    /**
     * 写托管标记（{@code cp_world.json}）。
     *
     * <p>
     * {@code complete} 是构建完成标志（见类注释的状态机）：{@code false} = 「曾经开始过、可以删可以
     * 重建，但不得当作构建完成的世界复用」，用于标记前置；{@code true} = 构建已完成，可以复用。
     *
     * @param complete 构建是否已完成
     * @throws CpException CP-IO-001 写入失败
     */
    public static JsonObject writeMarker(Path worldDir, String folder, long seed, boolean isVoid, boolean complete) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SCHEMA);
        o.addProperty("folder", folder);
        o.addProperty("seed", seed);
        o.addProperty("void", isVoid);
        o.addProperty("generatorOptions", VoidWorldPreset.GENERATOR_OPTIONS);
        o.addProperty("voidSpec", VoidWorldPreset.DESCRIPTION);
        o.addProperty(FIELD_COMPLETE, complete);
        o.addProperty("createdBy", CREATED_BY);
        String now = TimeSource.system()
            .isoNow();
        o.addProperty("createdAt", now);
        if (complete) {
            // 完成时刻单列一栏：createdAt 是「世界何时建的」，completedAt 才是「构建何时收口的」——
            // 两者在「先建世界、后失败、再重跑成功」的轨迹里会差出整整一轮，混用会让审计读错。
            o.addProperty("completedAt", now);
        }
        writeMarkerFile(worldDir, o);
        return o;
    }

    /**
     * 把已存在的标记<b>改写</b>为 {@code complete:true}（构建成功后由 MARKER / build 段调用）。
     *
     * <p>
     * 保留原标记的 {@code createdAt}（世界创建时刻不变），只翻 {@code complete} 并补
     * {@code completedAt}。这样「先失败残留、后重跑成功」的世界仍能看出真实的创建时刻。
     *
     * <p>
     * <b>本方法绝不创建标记</b>：标记缺失即 {@code CP-STATE-001}。这是安全属性的一部分——
     * 「写标记」这个动作等于把目录<b>认证为托管世界</b>，只允许发生在标记前置（
     * {@link #writeMarker} 被重建机显式调用）那条路径上；构建收口这种「事后认证」若顺手补写标记，
     * 就会把任意一个没被我们建过的目录认证成托管世界（安全属性回退）。
     *
     * @throws CpException CP-STATE-001 标记缺失；CP-IO-001 写入失败
     */
    public static JsonObject promoteMarker(Path worldDir, String folder, long seed, boolean isVoid) {
        JsonObject existing = readMarker(worldDir);
        if (existing == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "标记收口失败：目录缺 " + MARKER + "，拒绝把未认证的目录认证为托管世界: " + folder,
                Json.object("folder", folder, "marker", MARKER, "dir", String.valueOf(worldDir)));
        }
        existing.addProperty(FIELD_COMPLETE, true);
        // put 会改在原有位置：字段序稳定（同一份标记两次提升产出相同的键序，便于 diff）
        existing.addProperty(
            "completedAt",
            TimeSource.system()
                .isoNow());
        writeMarkerFile(worldDir, existing);
        return existing;
    }

    /** 落盘一份标记对象（{@link #writeMarker} 与 {@link #promoteMarker} 共用的写入点）。 */
    private static void writeMarkerFile(Path worldDir, JsonObject marker) {
        try {
            Files.createDirectories(worldDir);
            Files.write(
                worldDir.resolve(MARKER),
                Json.toPretty(marker)
                    .getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw CpException.io("写 " + MARKER + " 失败: " + worldDir, e);
        }
    }

    /**
     * 断言目录是托管世界；否则 {@code CP-STATE-001}。
     *
     * <p>
     * <b>不</b>校验 {@code complete}——「是托管目录」即通过（调用方拿它做删除/重建一类的
     * 「可以动这个目录」判断）。要求「构建完成」的调用方用 {@link #assertCompleteWorld}。
     *
     * @param what 调用方语境（错误信息用）
     */
    public static void assertManaged(Path worldDir, String folder, String what) {
        if (!isManagedFolderName(folder)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：目录 " + folder + " 不是托管世界（须以 " + PREFIX + " 开头）",
                Json.object("folder", String.valueOf(folder), "requiredPrefix", PREFIX));
        }
        if (!Files.isDirectory(worldDir)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：托管世界不存在: " + folder,
                Json.object("folder", folder, "dir", worldDir.toString()));
        }
        if (!hasMarker(worldDir)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：目录缺少 " + MARKER + "（非托管世界）: " + folder,
                Json.object("folder", folder, "marker", MARKER));
        }
    }

    /**
     * 断言目录是<b>构建完成</b>的托管世界（{@code complete:true}）；否则 {@code CP-STATE-001}。
     *
     * <p>
     * 本方法是 {@code complete:false} 的<b>可用性边界</b>：失败残留（有标记、构建未完成）必须被
     * 拒绝当成品复用。两类拒绝分开报，调用方能一眼分清根因：
     * <ul>
     * <li>无标记 ⇒ 「非托管世界」（目录名写错/手工塞的文件——安全属性，不碰）；</li>
     * <li>有标记但 {@code complete:false} ⇒ 「构建未完成的世界，不得复用」（重跑
     * {@code world.rebuild} 即可修好）——这不是「安全」拒绝而是「可用性」拒绝，
     * 提示里必须给出该怎么修。</li>
     * </ul>
     *
     * @param what 调用方语境（错误信息用）
     */
    public static void assertCompleteWorld(Path worldDir, String folder, String what) {
        assertManaged(worldDir, folder, what);
        JsonObject marker = readMarker(worldDir);
        if (!markerComplete(marker)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：托管世界构建未完成（" + MARKER + " 的 " + FIELD_COMPLETE + ":false），不得当作成品复用: " + folder,
                Json.object(
                    "folder",
                    folder,
                    "marker",
                    MARKER,
                    FIELD_COMPLETE,
                    Boolean.FALSE,
                    "dir",
                    worldDir.toString(),
                    "hint",
                    "该目录是失败残留：可重跑 world.rebuild / case.run 的 world 段重建，或用 world.rollback 恢复"));
        }
    }

    /**
     * 删除前的二次确认（见类注释）。
     *
     * <p>
     * 判据是「<b>带标记</b>」（{@link #hasMarker}），<b>不看</b> {@code complete} 取值——
     * 这是该修法的落点：标记前置写下的 {@code complete:false} 失败残留必须可以删。
     * 无标记目录仍然一律拒绝（安全属性不回退）。
     *
     * @throws CpException CP-STATE-001 未通过确认
     */
    public static void assertDeletable(Path worldDir, String folder, String what) {
        if (!isManagedFolderName(folder)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：拒绝删除非托管目录 " + folder,
                Json.object("folder", String.valueOf(folder), "requiredPrefix", PREFIX));
        }
        Path root = worldDir.getParent();
        if (root == null || !worldDir.startsWith(root) || worldDir.getFileName() == null) {
            throw new CpException(ErrorCodes.STATE, what + "：目录路径非法: " + worldDir, null);
        }
        if (!Files.exists(worldDir)) {
            return; // 首次建世界：不存在即可写
        }
        if (!Files.isDirectory(worldDir)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：目标不是目录: " + worldDir,
                Json.object("path", worldDir.toString()));
        }
        if (!hasMarker(worldDir)) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：目录存在但缺少 " + MARKER + "，拒绝删除: " + folder,
                Json.object("folder", folder, "marker", MARKER, "dir", worldDir.toString()));
        }
    }

    /** 读存档目录的显示名（{@code level.dat} 里的 levelName）；取不到时回落 {@code folder}。 */
    public static String displayNameOf(File mcDataDir, String folder) {
        try {
            Path dir = worldDir(mcDataDir, folder);
            Path levelDat = dir.resolve("level.dat");
            if (!Files.isRegularFile(levelDat)) {
                return folder;
            }
            net.minecraft.world.storage.ISaveHandler handler = net.minecraft.client.Minecraft.getMinecraft()
                .getSaveLoader()
                .getSaveLoader(folder, false);
            if (handler == null) {
                return folder;
            }
            net.minecraft.world.storage.WorldInfo info = handler.loadWorldInfo();
            if (info == null) {
                return folder;
            }
            String name = info.getWorldName();
            return name == null || name.isEmpty() ? folder : name;
        } catch (Throwable t) {
            CpLog.warn("读取存档显示名失败（用目录名代替）: %s / %s", folder, String.valueOf(t));
            return folder;
        }
    }
}
