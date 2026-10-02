package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件记录（契约 {@code format-parts-contract.md} §3 schema 的 Java 映射）。
 *
 * <p>
 * 五要素 + 来源四元组，缺一即契约违例：
 * <ol>
 * <li>{@link #localId} —— 格内定位，族内命名空间隔离（§4：{@code <族前缀>:<族内定位符>}）；</li>
 * <li>{@link #typeKey} —— 跨格类型键 = 计数/合并键（§5，由物品身份导出）；</li>
 * <li>{@link #boxes} —— 空间盒，允许多子盒（§6，0–1 方块局部 Y-up）；</li>
 * <li>{@link #displayName} + {@link #tooltip} —— 显示名与说明行（§3④、§8 优先级链导出时生成完毕）；</li>
 * <li>{@link #items} —— 物品身份（§5；空数组 = 显式"无"，不是缺）。</li>
 * </ol>
 *
 * <p>
 * {@link #properties} 保留为族特有补充信息的扩展点（如火把挂墙 meta、FMP 材料串），
 * <strong>强契约字段不得藏进 properties</strong>（§3）。
 */
@SideOnly(Side.CLIENT)
public final class PartRecord {

    public String localId;
    public String typeKey;
    public final List<PartBox> boxes = new ArrayList<PartBox>();
    public String displayName;
    public final List<String> tooltip = new ArrayList<String>();
    public final List<PartItem> items = new ArrayList<PartItem>();
    public PartSource source;
    /** 族特有扩展点（§3）；为空时落盘省略。 */
    public final Map<String, String> properties = new LinkedHashMap<String, String>();

    public PartRecord(String localId, String typeKey, PartSource source) {
        this.localId = localId;
        this.typeKey = typeKey;
        this.source = source;
    }

    /**
     * 契约 §3 的 JSON 形态（camelCase 落盘；proto snake_case 为规范名，映射见契约 §10.2）。
     */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("localId", localId);
        o.addProperty("typeKey", typeKey);
        JsonArray boxArr = new JsonArray();
        for (PartBox b : boxes) {
            boxArr.add(b.toJson());
        }
        o.add("boxes", boxArr);
        o.addProperty("displayName", displayName);
        JsonArray ttArr = new JsonArray();
        for (String line : tooltip) {
            ttArr.add(new JsonPrimitive(line));
        }
        o.add("tooltip", ttArr);
        JsonArray itemArr = new JsonArray();
        for (PartItem it : items) {
            itemArr.add(it.toJson());
        }
        o.add("items", itemArr);
        o.add("source", source.toJson());
        if (!properties.isEmpty()) {
            JsonObject props = new JsonObject();
            for (Map.Entry<String, String> e : properties.entrySet()) {
                props.addProperty(e.getKey(), e.getValue());
            }
            o.add("properties", props);
        }
        return o;
    }
}
