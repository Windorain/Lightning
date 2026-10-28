package com.lightning.mod.client.controlplane.mc;

/**
 * 托管世界使用的<b>全虚空</b>超平坦预设（contract.md §10 第 4 条：{@code WorldType.FLAT} + 空层预设，
 * 无基岩无土层，固定种子）。
 *
 * <h2>预设串的实证依据（反编译源码，非推测）</h2>
 *
 * 参考 {@code build/rfg/minecraft-src/java/net/minecraft/world/gen/FlatGeneratorInfo.java}：
 * <ul>
 * <li>{@code createFlatGeneratorFromString(s)} 以 {@code ";"} 切分（{@code split(";", -1)}）：
 * 首段为格式版本 {@code i}（合法 0..2），次段为层描述，其后可选为生物群系 id 与地貌特征串。
 * 只有「层描述成功解析且<b>非空列表</b>」时才采用传入值，否则回落
 * {@code getDefaultFlatGenerator()}（1 基岩 + 2 泥土 + 1 草方块）。</li>
 * <li>层描述按 {@code ","} 切分，每项 {@code <数量>x<方块id>[:meta]}；{@code func_82646_a} 里
 * {@code 数量=0} 是合法的（{@code j=0}，仅当 {@code j<0} 才夹取），生成的
 * {@code FlatLayerInfo(0, stone, 0)} 使列表非空、但铺出的方块数为 0。</li>
 * <li>{@code ChunkProviderFlat} 构造函数把层铺进 {@code cachedBlockIDs[256]}（层数为 0 → 全 null），
 * 因此 {@code provideChunk} 生成的区块<b>全是空气</b>；它把 {@code "village"}/{@code "biome_1"} 等
 * 结构生成器加入列表的那段被 {@code if (p_i2004_4_)} 包住，而 {@code p_i2004_4_} 即
 * {@code WorldInfo.isMapFeaturesEnabled()}（我们的 {@code WorldSettings} 第 3 参恒为 false）；
 * {@code hasDecoration} 只在特征串含 {@code "decoration"} 时为真，本预设不声明任何特征。</li>
 * </ul>
 *
 * 故本常量的语义是：格式版本 2、层描述 {@code 0x1}（0 个石头 → 无层）、生物群系 1（平原）、
 * 地貌特征串为空（无村庄/无装饰/无湖/无地牢）。实测结论与推导一致：世界除构建段放置的方块外
 * 无任何方块，也没有基岩与土层。
 *
 * <p>
 * 注意 1.7.10 里 {@code WorldSettings} 的 generatorOptions setter 在反编译/再编译 jar 中是
 * SRG 名 {@code func_82750_a(String)}（{@code javap} 已确认），传参即本常量。
 */
public final class VoidWorldPreset {

    /**
     * 全虚空超平坦预设串：{@code 2;0x1;1;}（版本;层;生物群系;特征）。
     *
     * <p>
     * 写成字面量而非拼接，便于审计与 diff；改动它必须同步本文档注释与契约 §10 第 4 条。
     */
    public static final String GENERATOR_OPTIONS = "2;0x1;1;";

    /** 人类可读的口径说明（写进 {@code cp_world.json} 与动作返回值）。 */
    public static final String DESCRIPTION = "flat:2;layers=0x1(no bedrock/soil);biome=1;features=<none>;mapFeatures=false";

    private VoidWorldPreset() {}

    /**
     * 判定一份 {@code generatorOptions} 是否等价于「无基岩无土层」的全虚空预设。
     *
     * <p>
     * 判据：层描述可解析且每一层的数量都是 0。空层描述（含 {@code ""}）会回落默认超平坦
     * （有基岩/泥土/草），因此判为 false。
     */
    public static boolean isVoid(String generatorOptions) {
        if (generatorOptions == null) {
            return false;
        }
        String s = generatorOptions.trim();
        if (s.isEmpty()) {
            return false;
        }
        String[] parts = s.split(";", -1);
        String layers = parts.length == 1 ? parts[0] : parts[1];
        if (layers == null || layers.trim()
            .isEmpty()) {
            return false;
        }
        boolean sawLayer = false;
        for (String raw : layers.split(",")) {
            String token = raw.trim();
            if (token.isEmpty()) {
                continue;
            }
            String count;
            int x = token.indexOf('x');
            if (x >= 0) {
                count = token.substring(0, x)
                    .trim();
            } else {
                count = "1";
            }
            int n;
            try {
                n = Integer.parseInt(count);
            } catch (NumberFormatException e) {
                return false;
            }
            if (n != 0) {
                return false;
            }
            sawLayer = true;
        }
        return sawLayer;
    }
}
