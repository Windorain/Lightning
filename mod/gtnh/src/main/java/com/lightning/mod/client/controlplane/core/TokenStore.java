package com.lightning.mod.client.controlplane.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.EnumSet;
import java.util.Set;

import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;

/**
 * 三级 token 的持有与判定（contract.md §2 第 1 条/第 3 条）。
 *
 * <p>
 * 每次启动随机生成三个 token（SecureRandom，32 字节 → 64 位十六进制），
 * 写 {@code <mcDataDir>/controlplane/tokens.json}（0600 尽力设置，Windows 上无 POSIX 权限时降级）。
 * <b>不存在空 token 放行</b>：空/未知 token 一律不匹配任何权限级。
 *
 * <p>
 * 本类只知道「token 文本 → 权限级」；「该权限级是否够用」由 {@link Router} 用
 * {@link Tier#covers(Tier)} 判定。
 */
public final class TokenStore {

    private static final int TOKEN_BYTES = 32;

    private static final SecureRandom RANDOM = new SecureRandom();

    private final String observe;
    private final String scene;
    private final String forensic;

    /** 用给定 token 构造（空串/nulls 视为未配置，不会匹配任何输入）。 */
    public TokenStore(String observe, String scene, String forensic) {
        this.observe = normalize(observe);
        this.scene = normalize(scene);
        this.forensic = normalize(forensic);
    }

    /**
     * 生成一组全新随机 token（每次启动调用一次）。
     *
     * @return 三个权限级各不相同的 token
     */
    public static TokenStore generate() {
        Set<String> used = new java.util.HashSet<String>();
        return new TokenStore(newUnique(used), newUnique(used), newUnique(used));
    }

    /** 生成一个 64 位十六进制随机 token。 */
    public static String newToken() {
        byte[] buf = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(buf);
        return Hashing.toHex(buf);
    }

    private static String newUnique(Set<String> used) {
        for (int i = 0; i < 8; i++) {
            String t = newToken();
            if (used.add(t)) {
                return t;
            }
        }
        throw new IllegalStateException("无法生成不重复的 token");
    }

    private static String normalize(String s) {
        return s == null ? "" : s.trim();
    }

    /**
     * 判定 token 的权限级。
     *
     * @param token 调用方出示的 token（可为 null）
     * @return 匹配的权限级；未知、空、null 一律返回 {@code null}
     */
    public Tier tierOf(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        String t = token.trim();
        if (t.isEmpty()) {
            return null;
        }
        // 用常量时间比较，避免逐字符短路带来的时间侧信道（回环场景非必需，但无成本）
        if (matches(forensic, t)) {
            return Tier.FORENSIC;
        }
        if (matches(scene, t)) {
            return Tier.SCENE;
        }
        if (matches(observe, t)) {
            return Tier.OBSERVE;
        }
        return null;
    }

    private static boolean matches(String stored, String presented) {
        if (stored == null || stored.isEmpty()) {
            return false;
        }
        return MessageDigest
            .isEqual(stored.getBytes(StandardCharsets.UTF_8), presented.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 取指定权限级的 token。
     *
     * @return 该级 token；未配置时返回空串
     */
    public String tokenFor(Tier tier) {
        if (tier == null) {
            return "";
        }
        switch (tier) {
            case OBSERVE:
                return observe;
            case SCENE:
                return scene;
            case FORENSIC:
                return forensic;
            default:
                return "";
        }
    }

    /** 三个 token 是否都未配置（此时一切请求都会 CP-AUTH-001）。 */
    public boolean isEmpty() {
        return observe.isEmpty() && scene.isEmpty() && forensic.isEmpty();
    }

    /** 序列化为 {@code tokens.json} 内容（含 schema 与生成时间）。 */
    public JsonObject toJson(String generatedAt) {
        JsonObject tokens = new JsonObject();
        tokens.addProperty(Tier.OBSERVE.id(), observe);
        tokens.addProperty(Tier.SCENE.id(), scene);
        tokens.addProperty(Tier.FORENSIC.id(), forensic);
        JsonObject root = new JsonObject();
        root.addProperty("schema", Contract.SCHEMA_TOKENS);
        if (generatedAt != null) {
            root.addProperty("generatedAt", generatedAt);
        }
        root.add("tokens", tokens);
        return root;
    }

    /**
     * 从 {@code tokens.json} 内容还原。
     *
     * <p>
     * 接受两种形态：标准 {@code {"tokens":{...}}} 与扁平 {@code {"observe":...}}（容错旧文件）。
     * 任一 token 缺失时该级为空（不影响其它级）。
     */
    public static TokenStore fromJson(JsonObject root) {
        if (root == null) {
            throw new JsonSyntaxException("tokens.json 为空");
        }
        JsonObject src = Json.optObject(root, "tokens");
        if (src == null) {
            src = root;
        }
        return new TokenStore(
            Json.optString(src, Tier.OBSERVE.id(), ""),
            Json.optString(src, Tier.SCENE.id(), ""),
            Json.optString(src, Tier.FORENSIC.id(), ""));
    }

    /**
     * 读取 {@code tokens.json}。
     *
     * @throws IOException 文件不可读或内容不是合法 JSON 对象
     */
    public static TokenStore load(Path file) throws IOException {
        if (file == null) {
            throw new IOException("tokens.json 路径为 null");
        }
        byte[] bytes = Files.readAllBytes(file);
        try {
            return fromJson(Json.parseStrictObject(new String(bytes, StandardCharsets.UTF_8)));
        } catch (JsonSyntaxException e) {
            throw new IOException("tokens.json 解析失败: " + e.getMessage(), e);
        }
    }

    /**
     * 写 {@code tokens.json}；父目录自动创建，0600 权限尽力设置。
     *
     * @throws IOException 写入失败
     */
    public void save(Path file, String generatedAt) throws IOException {
        if (file == null) {
            throw new IOException("tokens.json 路径为 null");
        }
        Path parent = file.toAbsolutePath()
            .getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Files.write(
            file,
            Json.toPretty(toJson(generatedAt))
                .getBytes(StandardCharsets.UTF_8));
        restrictToOwner(file);
    }

    /**
     * 尽力把文件权限收紧到 0600；不支持 POSIX 权限的文件系统（Windows）静默跳过。
     *
     * @return 是否真的设置了 POSIX 权限
     */
    public static boolean restrictToOwner(Path file) {
        Set<PosixFilePermission> perms = EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
        try {
            Files.setPosixFilePermissions(file, perms);
            return true;
        } catch (UnsupportedOperationException e) {
            return false;
        } catch (IOException e) {
            return false;
        }
    }

    /** 供调用方拼默认文件路径：{@code <dataDir>/tokens.json}。 */
    public static Path defaultFile(Path dataDir) {
        return Paths.get(dataDir == null ? "." : dataDir.toString(), "tokens.json");
    }
}
