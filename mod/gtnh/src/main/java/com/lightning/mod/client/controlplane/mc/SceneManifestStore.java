package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 场景清单的存档侧读写：场景清单既落 run 目录（evidence 口径 {@code world/scene-manifest.json}），
 * 也落存档目录（{@code saves/<folder>/scene-manifest.json}）。
 *
 * <p>
 * 落存档目录的意义是<b>按段续跑</b>（case-file.md §8.2）：{@code segments:["criteria"]} 这种只跑
 * 判据段的调用没有「本 run 首次构建」这个上下文，只能从世界自己的清单里取首次构建哈希；
 * 而 {@code world-hash-equals} 的「当前哈希」始终由服务端世界<b>实读</b>得到（见
 * {@link SceneManifest#readBack}），两边都不是缓存值。
 */
public final class SceneManifestStore {

    private SceneManifestStore() {}

    /** 存档内清单路径。 */
    public static Path worldFile(File mcDataDir, String folder) {
        return ManagedWorld.worldDir(mcDataDir, folder)
            .resolve(SceneManifest.FILE_NAME);
    }

    /** 读存档内清单；不存在或不可解析返回 null。 */
    public static JsonObject read(File mcDataDir, String folder) {
        if (folder == null) {
            return null;
        }
        Path file = worldFile(mcDataDir, folder);
        if (!Files.isRegularFile(file)) {
            return null;
        }
        try {
            return Json.parseStrictObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        } catch (java.io.IOException e) {
            CpLog.warn("读取存档内场景清单失败: %s / %s", file, String.valueOf(e));
            return null;
        } catch (JsonSyntaxException e) {
            CpLog.warn("存档内场景清单不是合法 JSON: %s / %s", file, String.valueOf(e));
            return null;
        }
    }

    /** 写存档内清单。 */
    public static void write(File mcDataDir, String folder, JsonObject manifest) {
        if (manifest == null || folder == null) {
            return;
        }
        Path file = worldFile(mcDataDir, folder);
        try {
            Files.createDirectories(file.getParent());
            Files.write(
                file,
                Json.toPretty(manifest)
                    .getBytes(StandardCharsets.UTF_8));
        } catch (java.io.IOException e) {
            throw CpException.io("写存档内场景清单失败: " + file, e);
        }
    }

    /** 服务端实读后的场景哈希；世界或清单不可用时返回 null。 */
    public static String readBackHash(WorldServer world, JsonObject manifest) {
        if (world == null || manifest == null) {
            return null;
        }
        try {
            return SceneManifest.hashOfSubset(SceneManifest.readBack(world, manifest));
        } catch (Throwable t) {
            CpLog.warn("场景读回失败: %s", String.valueOf(t));
            return null;
        }
    }
}
