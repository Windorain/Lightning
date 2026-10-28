package com.lightning.mod.client.controlplane.mc.scene;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityList;
import net.minecraft.potion.Potion;

import com.lightning.mod.client.controlplane.core.CpException;

/**
 * 1.7.10 注册名的宽容解析（实体与药水）。
 *
 * <h2>为什么需要这一层（实机暴露的两个事实）</h2>
 * 1.7.10 的注册名与现代 Minecraft <b>不同</b>，而调用方（尤其是只读自描述的 Agent）会自然地按
 * 现代写法猜。真机实测（首轮）两条都踩了：
 *
 * <ol>
 * <li><b>实体名没有 {@code minecraft:} 前缀</b>。{@code EntityList.stringToClassMapping} 的键是
 * 原版裸名（{@code Item}、{@code Zombie}、{@code XPOrb}）与 FML 的 {@code <modId>.<name>}
 * （{@code registerModEntity} 走 {@code String.format("%s.%s", modId, entityName)}，分隔符是<b>点</b>
 * 不是冒号）。传 {@code minecraft:zombie} 会直接查不到。</li>
 * <li><b>药水的类名不可用</b>。原版绝大多数效果是<b>匿名内部类</b>（{@code new Potion(16, ...)}），
 * {@code getClass().getSimpleName()} 为空串，按类名解析必然失败。稳定可用的名字是
 * {@code Potion.getName()}（即 {@code setPotionName("potion.nightVision")} 存下的那个串）。</li>
 * </ol>
 *
 * <h2>口径</h2>
 * 对两种输入都<b>宽容接受</b>：现代写法（{@code minecraft:zombie}）与 1.7.10 原生写法
 * （{@code Zombie}）都能用；比较前把两侧都规范化（小写、去 {@code minecraft:} 前缀、去
 * {@code _ - . :} 与空白）。规范化后仍无匹配或多个匹配即 {@code CP-VALID-002}，并且
 * <b>把已注册名列表带进错误上下文</b>——「查不到」必须可自救，否则调用方只能读源码。
 *
 * <p>
 * 规范化只用于<b>匹配</b>：真正交给原版 API 的永远是注册表里的原始键（
 * {@code EntityList.createEntityByName} 认原始键），所以不会因为宽容匹配而改变原版行为。
 */
final class RegistryNames {

    /** 错误上下文里最多列出的已注册名条数（防止错误响应被上千个模组实体灌爆）。 */
    static final int MAX_LISTED = 40;

    private RegistryNames() {}

    // ------------------------------------------------------------ 实体

    /**
     * 把调用方给的实体名解析为 {@code EntityList.stringToClassMapping} 里的原始键。
     *
     * @throws CpException CP-VALID-002：未知或歧义（{@code context.fields} 带已注册名样本）
     */
    static String resolveEntityKey(String raw, String field) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            throw CpException.param("实体名为空", field, "须为注册名（如 Zombie / minecraft:zombie）");
        }
        Map<String, Class<? extends Entity>> map = EntityList.stringToClassMapping;
        // 1) 原始键直接命中（最快路径，也是 1.7.10 的原生写法）
        if (map.containsKey(s)) {
            return s;
        }
        // 2) 规范化匹配（容忍 minecraft: 前缀、大小写、下划线/连字符差异）
        String want = normalize(s);
        List<String> hits = new ArrayList<String>();
        for (String key : map.keySet()) {
            if (key != null && normalize(key).equals(want)) {
                hits.add(key);
            }
        }
        if (hits.size() == 1) {
            return hits.get(0);
        }
        if (hits.size() > 1) {
            Collections.sort(hits);
            throw CpException.param("实体名有歧义", field, "规范化后匹配到多个注册名: " + hits + "（请用其中之一的完整写法）");
        }
        throw CpException.param(
            "未知实体 id",
            field,
            "注册表里没有该实体: " + raw + "；7.10 的注册名不带 minecraft: 前缀（如 Zombie / Item）。已注册样本: " + sample(map.keySet()));
    }

    /** 实体类 → 注册名；未注册返回 {@code null}。 */
    static String entityKeyOf(Entity e) {
        if (e == null) {
            return null;
        }
        String s = EntityList.getEntityString(e);
        return s != null ? s
            : e.getClass()
                .getName();
    }

    /** 两个实体名是否指同一注册项（规范化比较，容忍现代/原生两种写法）。 */
    static boolean sameEntity(String a, String b) {
        return a != null && b != null && normalize(a).equals(normalize(b));
    }

    // ------------------------------------------------------------ 药水

    /**
     * 解析药水：先按数字 id（上限 = 运行期 {@code Potion.potionTypes} 长度），再按
     * {@code Potion.getName()}（{@code potion.nightVision}）与类名匹配，最后按已注册名样本报错。
     *
     * @throws CpException CP-VALID-002：未知药水（{@code context.fields} 带已注册名样本）
     */
    static Potion resolvePotion(String raw, String field) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            throw CpException.param("药水 id 为空", field, "须为效果名或数字 id（上限见运行期 Potion.potionTypes 长度）");
        }
        // 1) 数字 id
        try {
            int id = Integer.parseInt(s);
            if (id < 1 || id >= Potion.potionTypes.length || Potion.potionTypes[id] == null) {
                // 上限是运行期的：原版 Potion.potionTypes 只有 32，GTNH 里被模组扩到 256。
                // 因此报错里报的是**本次运行**的真实上限，而不是写死的 31（D3：默认/边界值可见）。
                throw CpException.param(
                    "未知药水 id",
                    field,
                    "须在 1.." + (Potion.potionTypes.length - 1)
                        + " 且该位已注册（上限 = 运行期 Potion.potionTypes 长度，原版 32、本实例 "
                        + Potion.potionTypes.length
                        + "），收到: "
                        + id);
            }
            return Potion.potionTypes[id];
        } catch (NumberFormatException ignored) {
            // 不是数字：按名字找
        }
        // 2) 规范化名字匹配：Potion.getName()（形如 potion.nightVision）与类简单名都试
        String want = normalize(s);
        List<Potion> hits = new ArrayList<Potion>();
        List<String> known = new ArrayList<String>();
        for (Potion p : Potion.potionTypes) {
            if (p == null) {
                continue;
            }
            String statName = potionNameOf(p);
            known.add(statName + "(id=" + p.getId() + ")");
            if (normalize(statName).equals(want)) {
                hits.add(p);
                continue;
            }
            String cls = p.getClass()
                .getSimpleName();
            if (!cls.isEmpty() && normalize(cls).equals(want)) {
                hits.add(p);
            }
        }
        if (hits.size() == 1) {
            return hits.get(0);
        }
        if (hits.size() > 1) {
            throw CpException.param("药水名有歧义", field, "匹配到多个效果，请改用数字 id: " + hits.size() + " 个命中");
        }
        Collections.sort(known);
        throw CpException.param("未知药水", field, "按名字找不到效果: " + raw + "；已注册样本: " + sample(known));
    }

    /**
     * 药水的稳定名：优先 {@code Potion.getName()}（{@code potion.nightVision}），
     * 缺名时退回类简单名，再缺则用 {@code potion<id>}。<b>永远不返回空串</b>——
     * 空名会让错误信息与自述都没法引用这个效果。
     */
    static String potionNameOf(Potion p) {
        if (p == null) {
            return "potion<null>";
        }
        String n = null;
        try {
            n = p.getName();
        } catch (Throwable ignored) {
            // getName 理论上不抛；真抛了也不能让「列名字」这件事炸掉整个动作
        }
        if (n != null && !n.trim()
            .isEmpty()) {
            return n.trim();
        }
        String cls = p.getClass()
            .getSimpleName();
        if (!cls.isEmpty()) {
            return cls;
        }
        return "potion" + p.getId();
    }

    // ------------------------------------------------------------ 规范化与样本

    /**
     * 匹配用的规范形：小写、去 {@code minecraft:} 前缀、去 {@code _ - . :} 与空白。
     *
     * <p>
     * 于是 {@code minecraft:night_vision}、{@code NightVision}、{@code potion.nightVision}
     * 三者都归一到 {@code nightvision}。
     */
    static String normalize(String s) {
        if (s == null) {
            return "";
        }
        String v = s.trim()
            .toLowerCase(Locale.ROOT);
        if (v.startsWith("minecraft:")) {
            v = v.substring("minecraft:".length());
        } else if (v.startsWith("potion.")) {
            v = v.substring("potion.".length());
        }
        StringBuilder sb = new StringBuilder(v.length());
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '_' || c == '-' || c == '.' || c == ':' || Character.isWhitespace(c)) {
                continue;
            }
            sb.append(c);
        }
        return sb.toString();
    }

    /** 排序后的已注册名样本（最多 {@link #MAX_LISTED} 条 + 总数说明），供错误上下文用。 */
    static String sample(Iterable<String> names) {
        List<String> all = new ArrayList<String>();
        if (names != null) {
            for (String n : names) {
                if (n != null && !n.isEmpty()) {
                    all.add(n);
                }
            }
        }
        Collections.sort(all);
        int total = all.size();
        List<String> head = all.size() > MAX_LISTED ? all.subList(0, MAX_LISTED) : all;
        return head + (total > MAX_LISTED ? " …共 " + total + " 个" : "");
    }
}
