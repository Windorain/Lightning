package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Collection;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.2 多方块扫描的 JSON 小工具：统一「数组即字段」的写法与落盘编码（UTF-8 + 2 空格缩进）。
 * <p>
 * 与 T0.3 的 {@link RunStateProbeRunner#writeJson} 同口径（同一 Gson 配置），但在此独立一份，
 * 避免 T1.2 反向依赖 T0.3 的落盘布局。
 */
@SideOnly(Side.CLIENT)
public final class ScanJson {

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    private ScanJson() {}

    public static JsonArray strings(Collection<String> values) {
        JsonArray a = new JsonArray();
        if (values != null) {
            for (String v : values) {
                a.add(new JsonPrimitive(v));
            }
        }
        return a;
    }

    public static JsonArray ints(Collection<Integer> values) {
        JsonArray a = new JsonArray();
        if (values != null) {
            for (Integer v : values) {
                a.add(new JsonPrimitive(v));
            }
        }
        return a;
    }

    /** 把 {@code List<JsonObject>} 包成 {@link JsonArray}。 */
    public static JsonArray objects(Collection<JsonObject> values) {
        JsonArray a = new JsonArray();
        if (values != null) {
            for (JsonObject v : values) {
                a.add(v);
            }
        }
        return a;
    }

    public static void write(File file, JsonObject json) throws Exception {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + parent.getAbsolutePath());
        }
        try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write(GSON.toJson(json));
            w.write('\n');
        }
    }
}
