package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * 托管世界规则（contract.md §6.1）。
 *
 * <p>
 * 控制面只操作<b>托管世界</b>：存档目录名以 {@code cp_} 开头且内含
 * {@code cp_world.json}（schema {@code lightning.cp-world/1}，字段
 * {@code seed/void/createdBy}）。对非托管世界的一切写操作拒绝 {@code CP-STATE-001}。
 *
 * <p>
 * 删除存档目录是本模块唯一的破坏性操作，因此有<b>二次确认</b>（{@link #assertDeletable}）：
 * ①目录名以 {@code cp_} 开头且不含路径分隔符/上跳段；②目录解析后必须落在存档根之内；
 * ③目录不存在（首次建世界）或确实带 {@code cp_world.json} 标记。三者缺一即拒绝。
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

    /** 是否带托管标记。 */
    public static boolean hasMarker(Path worldDir) {
        return worldDir != null && Files.isRegularFile(worldDir.resolve(MARKER));
    }

    /** 目录是否已是托管世界（存在 + 带标记）。 */
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
     * @throws CpException CP-IO-001 写入失败
     */
    public static JsonObject writeMarker(Path worldDir, String folder, long seed, boolean isVoid) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SCHEMA);
        o.addProperty("folder", folder);
        o.addProperty("seed", seed);
        o.addProperty("void", isVoid);
        o.addProperty("generatorOptions", VoidWorldPreset.GENERATOR_OPTIONS);
        o.addProperty("voidSpec", VoidWorldPreset.DESCRIPTION);
        o.addProperty("createdBy", CREATED_BY);
        o.addProperty(
            "createdAt",
            TimeSource.system()
                .isoNow());
        try {
            Files.createDirectories(worldDir);
            Files.write(
                worldDir.resolve(MARKER),
                Json.toPretty(o)
                    .getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw CpException.io("写 " + MARKER + " 失败: " + worldDir, e);
        }
        return o;
    }

    /**
     * 断言目录是托管世界；否则 {@code CP-STATE-001}。
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
     * 删除前的二次确认（见类注释）。
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
