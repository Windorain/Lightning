package com.lightning.mod.client.controlplane.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * RFC 6902 的 v1 子集：{@code replace} / {@code add} / {@code remove}（case-file.md §6）。
 *
 * <p>
 * 用于用例文件的负对照变体（{@code variants[].mutate}）与任何「就地覆盖一小块 JSON」的场景。
 * 路径是 RFC 6901 指针，支持 {@code ~0}/{@code ~1} 转义、数组下标与 {@code -} 追加；
 * 一切结构性错误都抛 {@code CP-VALID-002} 并给出逐字段说明（{@code context.fields}），
 * 因为静默不生效的负对照会直接制造「恒绿假断言」。
 *
 * <p>
 * {@link #apply} 不修改入参，返回深拷贝后的新文档。
 */
public final class JsonPatch {

    /** 追加/覆盖成员或插入数组元素。 */
    public static final String OP_ADD = "add";

    /** 替换已存在成员或数组元素。 */
    public static final String OP_REPLACE = "replace";

    /** 删除成员或数组元素。 */
    public static final String OP_REMOVE = "remove";

    private JsonPatch() {}

    /**
     * 依次应用补丁。
     *
     * @param target      基座文档
     * @param ops         补丁数组
     * @param fieldPrefix 错误定位前缀，如 {@code variants[0].mutate}
     * @return 应用后的新文档（{@code target} 不被修改）
     * @throws CpException CP-VALID-002
     */
    public static JsonElement apply(JsonElement target, JsonArray ops, String fieldPrefix) {
        String prefix = fieldPrefix == null ? "patch" : fieldPrefix;
        JsonElement root = Json.copy(target);
        if (ops == null) {
            return root;
        }
        for (int i = 0; i < ops.size(); i++) {
            String fp = prefix + "[" + i + "]";
            JsonElement e = ops.get(i);
            if (e == null || !e.isJsonObject()) {
                throw fieldError(fp, "补丁项须为对象");
            }
            root = applyOne(root, e.getAsJsonObject(), fp);
        }
        return root;
    }

    /**
     * 应用单条补丁。
     *
     * @return 新的根节点（只有 {@code path:""} 的 add/replace 会替换根）
     * @throws CpException CP-VALID-002
     */
    public static JsonElement applyOne(JsonElement root, JsonObject op, String fieldPath) {
        String fp = fieldPath == null ? "patch" : fieldPath;
        String kind = Json.optString(op, "op", null);
        if (kind == null) {
            throw fieldError(fp + ".op", "缺失");
        }
        if (!OP_ADD.equals(kind) && !OP_REPLACE.equals(kind) && !OP_REMOVE.equals(kind)) {
            throw fieldError(fp + ".op", "v1 只支持 replace/add/remove，收到: " + kind);
        }
        JsonElement pathEl = Json.get(op, "path");
        if (pathEl == null || !pathEl.isJsonPrimitive()
            || !pathEl.getAsJsonPrimitive()
                .isString()) {
            throw fieldError(fp + ".path", "缺失或不是字符串");
        }
        String path = pathEl.getAsString();
        boolean hasValue = op.has("value") && !op.get("value")
            .isJsonNull();
        if (OP_REMOVE.equals(kind) && op.has("value")) {
            throw fieldError(fp + ".value", "op=remove 不得带 value");
        }
        if (!OP_REMOVE.equals(kind) && !hasValue) {
            throw fieldError(fp + ".value", "op=" + kind + " 必须带 value");
        }
        if (path.isEmpty()) {
            if (OP_REMOVE.equals(kind)) {
                throw fieldError(fp + ".path", "不能删除根节点");
            }
            return Json.copy(op.get("value"));
        }
        if (!path.startsWith("/")) {
            throw fieldError(fp + ".path", "指针须以 / 开头: " + path);
        }
        int lastSlash = path.lastIndexOf('/');
        String parentPointer = path.substring(0, lastSlash);
        String lastToken = Json.pointerUnescape(path.substring(lastSlash + 1));
        JsonElement parent = Json.resolvePointer(root, parentPointer);
        if (parent == null) {
            throw fieldError(fp + ".path", "父路径不存在: " + (parentPointer.isEmpty() ? "/" : parentPointer));
        }
        JsonElement value = OP_REMOVE.equals(kind) ? null : op.get("value");
        if (parent.isJsonObject()) {
            applyToObject(parent.getAsJsonObject(), kind, lastToken, value, fp, path);
        } else if (parent.isJsonArray()) {
            root = applyToArray(root, parentPointer, parent.getAsJsonArray(), kind, lastToken, value, fp, path);
        } else {
            throw fieldError(fp + ".path", "父节点既不是对象也不是数组: " + parentPointer);
        }
        return root;
    }

    private static void applyToObject(JsonObject parent, String kind, String token, JsonElement value, String fp,
        String path) {
        boolean exists = parent.has(token);
        if (OP_REMOVE.equals(kind)) {
            if (!exists) {
                throw fieldError(fp + ".path", "目标不存在: " + path);
            }
            parent.remove(token);
            return;
        }
        if (OP_REPLACE.equals(kind) && !exists) {
            throw fieldError(fp + ".path", "replace 目标不存在（需要 add）: " + path);
        }
        parent.add(token, Json.copy(value));
    }

    private static JsonElement applyToArray(JsonElement root, String parentPointer, JsonArray parent, String kind,
        String token, JsonElement value, String fp, String path) {
        int size = parent.size();
        int idx;
        if ("-".equals(token)) {
            if (OP_REPLACE.equals(kind)) {
                throw fieldError(fp + ".path", "replace 不能用 \"-\" 下标: " + path);
            }
            idx = size;
        } else {
            idx = Json.parseIndex(token);
            if (idx < 0) {
                throw fieldError(fp + ".path", "非法数组下标: " + token);
            }
        }
        if (OP_REMOVE.equals(kind)) {
            if (idx >= size) {
                throw fieldError(fp + ".path", "下标越界: " + idx + " (size=" + size + ")");
            }
            // JsonArray.remove(int) 是 gson 2.8+ API（运行期 2.2.4 没有）：
            // 与下面的「按位置插入」同法——重建整数组后替换回去。
            return replaceNode(root, parentPointer, withoutIndex(parent, idx), fp);
        }
        if (OP_REPLACE.equals(kind)) {
            if (idx >= size) {
                throw fieldError(fp + ".path", "replace 下标越界: " + idx + " (size=" + size + ")");
            }
            // JsonArray.set(int, JsonElement) 同为 2.8+ API，同样走重建。
            return replaceNode(root, parentPointer, withIndexReplaced(parent, idx, Json.copy(value)), fp);
        }
        if (idx > size) {
            throw fieldError(fp + ".path", "add 下标越界: " + idx + " (size=" + size + ")");
        }
        if (idx == size) {
            parent.add(Json.copy(value));
            return root;
        }
        // Gson 2.8.9 的 JsonArray 没有「按位置插入」，只能重建整个数组再替换回去
        JsonArray rebuilt = new JsonArray();
        for (int k = 0; k < size; k++) {
            if (k == idx) {
                rebuilt.add(Json.copy(value));
            }
            rebuilt.add(parent.get(k));
        }
        return replaceNode(root, parentPointer, rebuilt, fp);
    }

    /** 用 {@code node} 替换 {@code pointer} 指向的节点（指针为空串时替换根）。 */
    private static JsonElement replaceNode(JsonElement root, String pointer, JsonElement node, String fp) {
        if (pointer == null || pointer.isEmpty()) {
            return node;
        }
        int ls = pointer.lastIndexOf('/');
        String grandParentPointer = pointer.substring(0, ls);
        String token = Json.pointerUnescape(pointer.substring(ls + 1));
        JsonElement grandParent = Json.resolvePointer(root, grandParentPointer);
        if (grandParent == null) {
            throw fieldError(fp + ".path", "父路径不存在: " + grandParentPointer);
        }
        if (grandParent.isJsonObject()) {
            grandParent.getAsJsonObject()
                .add(token, node);
        } else if (grandParent.isJsonArray()) {
            JsonArray a = grandParent.getAsJsonArray();
            int i = Json.parseIndex(token);
            if (i < 0 || i >= a.size()) {
                throw fieldError(fp + ".path", "下标越界: " + token);
            }
            // JsonArray.set(int, JsonElement) 是 2.8+ API：重建该数组并递归替换
            return replaceNode(root, grandParentPointer, withIndexReplaced(a, i, node), fp);
        } else {
            throw fieldError(fp + ".path", "父节点既不是对象也不是数组: " + grandParentPointer);
        }
        return root;
    }

    /** 新数组 = {@code a} 去掉下标 {@code idx}（gson 2.2.4 无 {@code JsonArray.remove(int)}）。 */
    private static JsonArray withoutIndex(JsonArray a, int idx) {
        JsonArray out = new JsonArray();
        for (int i = 0; i < a.size(); i++) {
            if (i != idx) {
                out.add(a.get(i));
            }
        }
        return out;
    }

    /** 新数组 = {@code a} 的下标 {@code idx} 换成 {@code v}（gson 2.2.4 无 {@code JsonArray.set}）。 */
    private static JsonArray withIndexReplaced(JsonArray a, int idx, JsonElement v) {
        JsonArray out = new JsonArray();
        for (int i = 0; i < a.size(); i++) {
            out.add(i == idx ? v : a.get(i));
        }
        return out;
    }

    private static CpException fieldError(String field, String reason) {
        return new CpException(
            ErrorCodes.VALID_PARAM,
            "补丁非法：" + reason + "（字段 " + field + "）",
            new Fields().add(field, reason)
                .toContext());
    }
}
