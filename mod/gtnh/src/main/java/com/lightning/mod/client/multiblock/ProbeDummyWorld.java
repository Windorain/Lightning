package com.lightning.mod.client.multiblock;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EnumCreatureType;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.init.Blocks;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.profiler.Profiler;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.IProgressUpdate;
import net.minecraft.util.LongHashMap;
import net.minecraft.world.ChunkCoordIntPair;
import net.minecraft.world.ChunkPosition;
import net.minecraft.world.EnumSkyBlock;
import net.minecraft.world.World;
import net.minecraft.world.WorldProvider;
import net.minecraft.world.WorldProviderSurface;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.WorldType;
import net.minecraft.world.biome.BiomeGenBase;
import net.minecraft.world.chunk.Chunk;
import net.minecraft.world.chunk.IChunkProvider;
import net.minecraft.world.chunk.storage.IChunkLoader;
import net.minecraft.world.storage.IPlayerFileData;
import net.minecraft.world.storage.ISaveHandler;
import net.minecraft.world.storage.WorldInfo;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T0.3 探针用的假世界：方块 / 元数据 / TileEntity 全部落在本地 Map，不落盘、不触碰真实存档。
 * <p>
 * 与 {@code BlockRenderer6343} 的 {@code ObserverWorld} / {@code DummyWorld} 同构（该实现已被证明能承载 GT 多方块的真实
 * {@code construct} / {@code survivalConstruct}），但补了三件探针需要的东西：
 * <ol>
 * <li>{@link #blocksPlaced()} 计数器，用于判断自动建造是否收敛（不依赖 {@code World} 内部的变更标志）；</li>
 * <li>{@link #placedPositions()} 提供确定序的已放置坐标清单，供逐格几何捕获与暴力搜索有效的舱口位置；</li>
 * <li>{@link #reset()} 允许同一进程内为不同目标机器复用同一份实现（每次仍新建实例以保证隔离）。</li>
 * </ol>
 * <strong>关键事实</strong>：这里用 {@code World} 的构造器建立，因此 {@code isRemote == false} —— 即 GT 眼里的「服务端侧」。
 * 这是 {@code MTEMultiBlockBase.onPostTick} 运行态机（{@code if (aBaseMetaTileEntity.isServerSide())}）能否执行的前提。
 */
@SideOnly(Side.CLIENT)
public final class ProbeDummyWorld extends World {

    private static final WorldSettings DEFAULT_SETTINGS = new WorldSettings(
        1L,
        WorldSettings.GameType.CREATIVE,
        true,
        false,
        WorldType.FLAT);

    private final Map<Long, Block> blocks = new HashMap<Long, Block>();
    private final Map<Long, Integer> blockMetas = new HashMap<Long, Integer>();
    private final Map<Long, TileEntity> tiles = new HashMap<Long, TileEntity>();
    private int placementCount;

    /** 变更轨迹（诊断用）：最近若干次真正改变世界的 setBlock 的「坐标 + 旧值 → 新值」。 */
    private final List<String> trace = new ArrayList<String>();
    private static final int TRACE_LIMIT = 24;

    /** 开始一次新的变更轨迹（清空缓冲）。 */
    public void beginTrace() {
        trace.clear();
    }

    /** 当前轨迹快照。 */
    public List<String> trace() {
        return new ArrayList<String>(trace);
    }

    private void recordChange(String what) {
        if (trace.size() < TRACE_LIMIT) trace.add(what);
    }

    public ProbeDummyWorld() {
        super(
            new ProbeSaveHandler(),
            "LightningProbeDummy",
            DEFAULT_SETTINGS,
            new WorldProviderSurface(),
            new Profiler());
        // 与参考实现一致：避免与真实维度 id 冲突，并在 provider 上重新绑定本世界
        this.provider.setDimension(Integer.MAX_VALUE);
        int providerDim = this.provider.dimensionId;
        this.provider.worldObj = this;
        this.provider.setDimension(providerDim);
        this.chunkProvider = this.createChunkProvider();
        this.calculateInitialSkylight();
        this.calculateInitialWeatherBody();
        this.isRemote = false;
    }

    // ------------------------------------------------------------------ map-backed storage

    private static long key(int x, int y, int z) {
        return ((long) x & 0xFFFFFFL) << 40 | ((long) z & 0xFFFFFFL) << 16 | ((long) y & 0xFFFFL);
    }

    private static int unpackX(long k) {
        return (int) (k >> 40);
    }

    private static int unpackZ(long k) {
        return (int) (k >> 16 & 0xFFFFFFL);
    }

    private static int unpackY(long k) {
        return (int) (k & 0xFFFFL);
    }

    @Override
    public boolean setBlock(int x, int y, int z, Block block, int meta, int flags) {
        long k = key(x, y, z);
        if (block == null || block == Blocks.air) {
            // 已经是空气 = 无变更，不能计入 placementCount。
            // 否则「对空气位重复 setBlock(air)」会被误判成「结构还在长」（T1.2 总 Tier 试探实测撞上：
            // 6 台机器因此永远解不出总 Tier，因为 GT 的舱口/占位元素会反复把空位清成空气）。
            if (!blocks.containsKey(k)) {
                return true;
            }
            blocks.remove(k);
            blockMetas.remove(k);
            TileEntity removed = tiles.remove(k);
            if (removed != null) {
                removed.invalidate();
            }
            placementCount++;
            recordChange("AIR at (" + x + "," + y + "," + z + ")");
            return true;
        }
        Block prev = blocks.get(k);
        Integer prevMeta = blockMetas.get(k);
        if (prev == block && prevMeta != null && prevMeta.intValue() == meta) {
            return true;
        }
        blocks.put(k, block);
        blockMetas.put(k, Integer.valueOf(meta));
        placementCount++;
        recordChange(
            "(" + x
                + ","
                + y
                + ","
                + z
                + ") "
                + (prev == null ? "air" : String.valueOf(Block.blockRegistry.getNameForObject(prev)) + ":" + prevMeta)
                + " -> "
                + String.valueOf(Block.blockRegistry.getNameForObject(block))
                + ":"
                + meta);
        if (block.hasTileEntity(meta)) {
            TileEntity tile = block.createTileEntity(this, meta);
            if (tile != null) {
                setTileEntity(x, y, z, tile);
            }
        } else {
            TileEntity stale = tiles.remove(k);
            if (stale != null) {
                stale.invalidate();
            }
        }
        return true;
    }

    @Override
    public boolean blockExists(int x, int y, int z) {
        return blocks.containsKey(key(x, y, z));
    }

    @Override
    public Block getBlock(int x, int y, int z) {
        Block b = blocks.get(key(x, y, z));
        return b == null ? Blocks.air : b;
    }

    @Override
    public int getBlockMetadata(int x, int y, int z) {
        Integer m = blockMetas.get(key(x, y, z));
        return m == null ? 0 : m.intValue();
    }

    @Override
    public void setTileEntity(int x, int y, int z, TileEntity tile) {
        if (tile == null) {
            return;
        }
        tile.setWorldObj(this);
        tile.xCoord = x;
        tile.yCoord = y;
        tile.zCoord = z;
        tile.validate();
        tiles.put(key(x, y, z), tile);
    }

    @Override
    public void removeTileEntity(int x, int y, int z) {
        TileEntity removed = tiles.remove(key(x, y, z));
        if (removed != null) {
            removed.invalidate();
        }
    }

    @Override
    public TileEntity getTileEntity(int x, int y, int z) {
        return tiles.get(key(x, y, z));
    }

    // ------------------------------------------------------------------ probe helpers

    /** 累计的「放置次数」（同一坐标换成不同方块也会 +1）；用于判断自动建造是否仍在推进。 */
    public int blocksPlaced() {
        return placementCount;
    }

    /**
     * 与 {@link #blocksPlaced()} 同义，语义名对齐「世界发生了变更」这一判据。
     * <p>
     * T1.2 的总 Tier 逐级试探用 {@code construct(trigger)} 前后的差值判断「结构是否还在长」，
     * 与参考实现 {@code ObserverWorld#hasChanged} 等价，但不依赖任何元素内部实现。
     */
    public int mutationCount() {
        return placementCount;
    }

    /** 已放置（非空气）坐标，按 x → y → z 升序，保证跨运行确定序。 */
    public List<int[]> placedPositions() {
        List<int[]> out = new ArrayList<int[]>(blocks.size());
        for (Long k : blocks.keySet()) {
            out.add(new int[] { unpackX(k.longValue()), unpackY(k.longValue()), unpackZ(k.longValue()) });
        }
        Collections.sort(out, (a, b) -> {
            if (a[0] != b[0]) return Integer.compare(a[0], b[0]);
            if (a[1] != b[1]) return Integer.compare(a[1], b[1]);
            return Integer.compare(a[2], b[2]);
        });
        return out;
    }

    public int nonAirCount() {
        return blocks.size();
    }

    /**
     * 当前方块布局的内容签名（坐标 + 方块 + 元数据，按坐标排序后哈希）。
     * <p>
     * T1.2 的总 Tier 试探判据：{@code construct(trigger)} 之后签名不变 → 结构不再长 → 收敛。
     * <b>为什么不能只看「本次有没有写方块」</b>：GT 的 {@code construct} 每一级都会<b>重新遍历整个结构</b>并把
     * 每个位置写成当级方块（实测 {@code MTEBrickedBlastFurnace} 每级 4 次写入、
     * {@code MTEExtremeIndustrialGreenhouse} 每级 130 次写入），写入次数永远非零；只有「布局是否与上一级相同」
     * 才是收敛判据。更本质地说，「结构还在长」= 存在使用第 k 档与第 (k+1) 档不同方块的符号
     * （尺寸型通道增加片数、替换型通道的提示列表循环），两种情形都体现在布局签名上。
     */
    public String stateSignature() {
        List<String> entries = new ArrayList<String>(blocks.size());
        for (Map.Entry<Long, Block> e : blocks.entrySet()) {
            long k = e.getKey()
                .longValue();
            Integer meta = blockMetas.get(e.getKey());
            entries.add(
                unpackX(k) + ","
                    + unpackY(k)
                    + ","
                    + unpackZ(k)
                    + "="
                    + Block.blockRegistry.getNameForObject(e.getValue())
                    + ":"
                    + (meta == null ? 0 : meta.intValue()));
        }
        Collections.sort(entries);
        return sha256(entries);
    }

    private static String sha256(List<String> entries) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            for (String s : entries) {
                md.update(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                md.update((byte) '\n');
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return "sha256-unavailable:" + entries.size();
        }
    }

    public void reset() {
        for (TileEntity t : tiles.values()) {
            try {
                t.invalidate();
            } catch (Throwable ignored) {
                // 探针世界销毁阶段的异常不影响结论
            }
        }
        blocks.clear();
        blockMetas.clear();
        tiles.clear();
        placementCount = 0;
    }

    // ------------------------------------------------------------------ World overrides

    @Override
    public void updateEntities() {}

    @Override
    public void markBlockRangeForRenderUpdate(int x1, int y1, int z1, int x2, int y2, int z2) {}

    @Override
    protected int func_152379_p() {
        return 0;
    }

    @Override
    public Entity getEntityByID(int id) {
        return null;
    }

    @Override
    public boolean updateLightByType(EnumSkyBlock type, int x, int y, int z) {
        return true;
    }

    @Override
    protected IChunkProvider createChunkProvider() {
        return new ProbeChunkProvider(this);
    }

    @Override
    protected boolean chunkExists(int x, int z) {
        return chunkProvider.chunkExists(x, z);
    }

    // ------------------------------------------------------------------ nested chunk/save plumbing

    /** 只有形状没有内容的 chunk provider：方块真源在 {@link ProbeDummyWorld} 的 Map 里。 */
    static final class ProbeChunkProvider implements IChunkProvider {

        private final World world;
        private final LongHashMap loadedChunks = new LongHashMap();

        ProbeChunkProvider(World world) {
            this.world = world;
        }

        @Override
        public Chunk loadChunk(int x, int z) {
            return (Chunk) loadedChunks.getValueByKey(ChunkCoordIntPair.chunkXZ2Int(x, z));
        }

        @Override
        public Chunk provideChunk(int x, int z) {
            long chunkKey = ChunkCoordIntPair.chunkXZ2Int(x, z);
            if (loadedChunks.containsItem(chunkKey)) {
                return (Chunk) loadedChunks.getValueByKey(chunkKey);
            }
            Chunk chunk = new Chunk(world, x, z);
            loadedChunks.add(chunkKey, chunk);
            return chunk;
        }

        @Override
        public void populate(IChunkProvider provider, int x, int z) {}

        @Override
        public boolean saveChunks(boolean flag, IProgressUpdate progress) {
            return false;
        }

        @Override
        public boolean unloadQueuedChunks() {
            return false;
        }

        @Override
        public boolean canSave() {
            return false;
        }

        @Override
        public String makeString() {
            return "LightningProbeDummy";
        }

        @Override
        public List<BiomeGenBase.SpawnListEntry> getPossibleCreatures(EnumCreatureType type, int x, int y, int z) {
            return null;
        }

        @Override
        public ChunkPosition func_147416_a(World world, String name, int x, int y, int z) {
            return null;
        }

        @Override
        public int getLoadedChunkCount() {
            return 0;
        }

        @Override
        public void recreateStructures(int x, int z) {}

        @Override
        public void saveExtraData() {}

        @Override
        public boolean chunkExists(int x, int z) {
            return true;
        }
    }

    /** 什么都不做的存档句柄：保证不写盘。 */
    static final class ProbeSaveHandler implements ISaveHandler, IPlayerFileData, IChunkLoader {

        @Override
        public WorldInfo loadWorldInfo() {
            return null;
        }

        @Override
        public void checkSessionLock() {}

        @Override
        public IChunkLoader getChunkLoader(WorldProvider provider) {
            return this;
        }

        @Override
        public IPlayerFileData getSaveHandler() {
            return this;
        }

        @Override
        public void saveWorldInfoWithPlayer(WorldInfo info, NBTTagCompound tag) {}

        @Override
        public void saveWorldInfo(WorldInfo info) {}

        @Override
        public File getWorldDirectory() {
            return null;
        }

        @Override
        public File getMapFileFromName(String name) {
            return null;
        }

        @Override
        public String getWorldDirectoryName() {
            return "LightningProbeDummy";
        }

        @Override
        public Chunk loadChunk(World world, int x, int z) {
            return null;
        }

        @Override
        public void saveChunk(World world, Chunk chunk) {}

        @Override
        public void saveExtraChunkData(World world, Chunk chunk) {}

        @Override
        public void chunkTick() {}

        @Override
        public void saveExtraData() {}

        @Override
        public void flush() {}

        @Override
        public void writePlayerData(EntityPlayer player) {}

        @Override
        public NBTTagCompound readPlayerData(EntityPlayer player) {
            return null;
        }

        @Override
        public String[] getAvailablePlayerDat() {
            return new String[0];
        }
    }
}
