package com.lightning.mod.client.export;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.GZIPOutputStream;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

/**
 * 将终态 Plain 文档拆成明文 {@code meta} + gzip+Base64 {@code payload}。
 * 与 Wiki 侧约定一致：元数据只在 {@code meta}；{@code payload} 解压后为不含 id/label 等顶层元数据键的 body（仅 frames / cellGrid / palette /
 * textureBlobs 等）。
 */
public final class SceneEnvelopeBuilder {

    public static final String PAYLOAD_ENCODING = "gzip+base64";

    private static final Gson COMPACT_GSON = new Gson();

    private SceneEnvelopeBuilder() {}

    public static JsonObject toEnvelope(JsonObject rawFinal) {
        JsonObject meta = new JsonObject();
        JsonObject inner = new JsonObject();
        if (rawFinal.has("frames") && rawFinal.get("frames")
            .isJsonArray()) {
            copyIfPresent(rawFinal, meta, "id");
            copyIfPresent(rawFinal, meta, "mode");
            copyIfPresent(rawFinal, meta, "label");
            copyIfPresent(rawFinal, meta, "author");
            copyIfPresent(rawFinal, meta, "gtnhVersion");
            copyIfPresent(rawFinal, meta, "structureId");
            copyIfPresent(rawFinal, meta, "description");
            copyIfPresent(rawFinal, meta, "modSource");
            copyIfPresent(rawFinal, meta, "playback");
            copyIfPresent(rawFinal, meta, "globalConfig");
            copyIfPresent(rawFinal, meta, "schemaVersion");
            copyIfPresent(rawFinal, inner, "frames");
            copyIfPresent(rawFinal, inner, "materialPalette");
            copyIfPresent(rawFinal, inner, "blockPalette");
            copyIfPresent(rawFinal, inner, "textureBlobs");
            copyIfPresent(rawFinal, inner, "tooltipPalette");
        } else {
            copyIfPresent(rawFinal, meta, "geometryPhase");
            copyIfPresent(rawFinal, meta, "mode");
            copyIfPresent(rawFinal, meta, "id");
            copyIfPresent(rawFinal, meta, "label");
            copyIfPresent(rawFinal, meta, "author");
            copyIfPresent(rawFinal, meta, "gtnhVersion");
            copyIfPresent(rawFinal, meta, "structureId");
            copyIfPresent(rawFinal, meta, "description");
            copyIfPresent(rawFinal, meta, "modSource");
            copyIfPresent(rawFinal, meta, "globalConfig");
            copyIfPresent(rawFinal, meta, "source");
            copyIfPresent(rawFinal, meta, "axis");
            copyIfPresent(rawFinal, meta, "initialCamera");
            copyIfPresent(rawFinal, meta, "scanBounds");
            copyIfPresent(rawFinal, meta, "schemaVersion");
            copyIfPresent(rawFinal, inner, "blockPalette");
            copyIfPresent(rawFinal, inner, "materialPalette");
            copyIfPresent(rawFinal, inner, "cellGrid");
            copyIfPresent(rawFinal, inner, "cellTooltipGrid");
            copyIfPresent(rawFinal, inner, "sdeCellNotes");
            copyIfPresent(rawFinal, inner, "textureBlobs");
            copyIfPresent(rawFinal, inner, "tooltipPalette");
        }
        byte[] utf8 = COMPACT_GSON.toJson(inner)
            .getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.min(utf8.length + 32, 1024 * 1024));
        try (GZIPOutputStream gzip = new GZIPOutputStream(bos)) {
            gzip.write(utf8);
        } catch (Exception e) {
            throw new IllegalStateException("gzip inner JSON", e);
        }
        String b64 = Base64.getEncoder()
            .encodeToString(bos.toByteArray());
        JsonObject env = new JsonObject();
        env.addProperty("documentFormat", "Envelope");
        env.addProperty("payloadEncoding", PAYLOAD_ENCODING);
        env.add("meta", meta);
        env.addProperty("payload", b64);
        return env;
    }

    private static void copyIfPresent(JsonObject src, JsonObject dest, String key) {
        if (src.has(key)) {
            dest.add(key, src.get(key));
        }
    }
}
