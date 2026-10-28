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
            // 版本事实成对搬运：gtnhVersion（整合包）+ gtVersion（GregTech），语义互不冒充
            copyIfPresent(rawFinal, meta, "gtVersion");
            copyIfPresent(rawFinal, meta, "structureId");
            copyIfPresent(rawFinal, meta, "description");
            copyIfPresent(rawFinal, meta, "modSource");
            copyIfPresent(rawFinal, meta, "playback");
            copyIfPresent(rawFinal, meta, "globalConfig");
            copyIfPresent(rawFinal, meta, "schemaVersion");
            // 因子化编码器（docs/contracts/format-multiblock-doc.md §8）：文档级形态枚举量进 meta —— "multiblock" 与缺省的"帧为主"互斥。
            copyIfPresent(rawFinal, meta, "documentShape");
            // cp 通道的导出溯源进 meta ——「同会话同缓冲」判据读它。
            // 命令通道不写这两个字段 ⇒ copyIfPresent 天然字节干净（既有产物逐字节不变）。
            copyIfPresent(rawFinal, meta, "provenance");
            copyIfPresent(rawFinal, meta, "exportId");
            copyIfPresent(rawFinal, inner, "frames");
            copyIfPresent(rawFinal, inner, "materialPalette");
            copyIfPresent(rawFinal, inner, "blockPalette");
            copyIfPresent(rawFinal, inner, "textureBlobs");
            copyIfPresent(rawFinal, inner, "tooltipPalette");
            // 成对 idioms 的另一半——frames 分支也搬 cellTooltipGrid（与非 frames 分支对齐）；
            // copyIfPresent 天然字节干净：文档本来没有时不会凭空出现。
            copyIfPresent(rawFinal, inner, "cellTooltipGrid");
            // 部件导出：帧结构的 cellPartsGrid/partLists 随 frames 整体随行；
            // 文档级 statsTemplate/partIconTextures 仅在含部件数据时存在（copyIfPresent 天然字节干净）。
            copyIfPresent(rawFinal, inner, "statsTemplate");
            copyIfPresent(rawFinal, inner, "partIconTextures");
            // 因子化编码器（docs/contracts/format-multiblock-doc.md §8）：多方块声明作为新的 inner 键（判别式需要 inner.multiblock +
            // multiblockCount）。
            copyIfPresent(rawFinal, inner, "multiblock");
            copyIfPresent(rawFinal, inner, "multiblockCount");
        } else {
            copyIfPresent(rawFinal, meta, "geometryPhase");
            copyIfPresent(rawFinal, meta, "mode");
            copyIfPresent(rawFinal, meta, "id");
            copyIfPresent(rawFinal, meta, "label");
            copyIfPresent(rawFinal, meta, "author");
            copyIfPresent(rawFinal, meta, "gtnhVersion");
            // 版本事实成对搬运：gtnhVersion（整合包）+ gtVersion（GregTech），语义互不冒充
            copyIfPresent(rawFinal, meta, "gtVersion");
            copyIfPresent(rawFinal, meta, "structureId");
            copyIfPresent(rawFinal, meta, "description");
            copyIfPresent(rawFinal, meta, "modSource");
            copyIfPresent(rawFinal, meta, "globalConfig");
            copyIfPresent(rawFinal, meta, "source");
            copyIfPresent(rawFinal, meta, "axis");
            copyIfPresent(rawFinal, meta, "initialCamera");
            copyIfPresent(rawFinal, meta, "scanBounds");
            copyIfPresent(rawFinal, meta, "schemaVersion");
            // 裸单结构形态的溯源留在根上（与 World 形态的 meta 位置不同，
            // 口径见 docs/contracts/format-scene-file.md §6）。命令通道不写 ⇒ 既有产物逐字节不变。
            copyIfPresent(rawFinal, meta, "provenance");
            copyIfPresent(rawFinal, meta, "exportId");
            copyIfPresent(rawFinal, inner, "blockPalette");
            copyIfPresent(rawFinal, inner, "materialPalette");
            copyIfPresent(rawFinal, inner, "cellGrid");
            copyIfPresent(rawFinal, inner, "cellTooltipGrid");
            copyIfPresent(rawFinal, inner, "sdeCellNotes");
            copyIfPresent(rawFinal, inner, "textureBlobs");
            copyIfPresent(rawFinal, inner, "tooltipPalette");
            // 部件导出（契约 §2/§9）：仅在含部件数据时存在 ⇒ copyIfPresent 保持无部件文件字节干净
            copyIfPresent(rawFinal, inner, "cellPartsGrid");
            copyIfPresent(rawFinal, inner, "partLists");
            copyIfPresent(rawFinal, inner, "statsTemplate");
            copyIfPresent(rawFinal, inner, "partIconTextures");
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
