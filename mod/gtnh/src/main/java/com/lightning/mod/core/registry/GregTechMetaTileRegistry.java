package com.lightning.mod.core.registry;

import java.lang.reflect.Array;
import java.lang.reflect.Method;

import net.minecraft.block.Block;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

/**
 * GT5U 唯一可信源：{@code GregTechAPI.METATILEENTITIES} 与 Tile 上的 MetaTile ID（mID）。
 * <p>
 * <b>背景</b>：MC 1.7.10 世界方块 metadata 为 4 bit（0–15）；{@code gregtech:gt.blockmachines} 上具体种类由
 * {@code BaseMetaTileEntity} / {@code BaseMetaPipeEntity} 的 {@code mID} 与全局 {@code METATILEENTITIES[mID]} 决定，
 * 与 {@code World#getBlockMetadata} 无一对一关系。
 * <p>
 * <b>契约</b>：{@code block_registry} 与结构 palette 中，对 {@code gregtech:gt.blockmachines}，键 {@code registryId@n}
 * 的 {@code n} 为 mID（表下标），不是世界 block meta。其他 GregTech 注册策略方块仍为世界 meta 0–15，见
 * {@link com.lightning.mod.core.registry.gt.GtGregtechRegistryPolicyOrder}。
 * <p>
 * 无编译期依赖 GregTech；失败时方法返回安全默认值。
 */
public final class GregTechMetaTileRegistry {

    private static final String C_GREGTECH_API = "gregtech.api.GregTechAPI";
    private static final String C_IGREG_TECH_TILE = "gregtech.api.interfaces.tileentity.IGregTechTileEntity";
    /** GT {@code ITurnable#getFrontFacing()} */
    private static final String C_ITURNABLE = "gregtech.api.interfaces.tileentity.ITurnable";
    private static final String C_BLOCK_MACHINES = "gregtech.common.blocks.BlockMachines";
    /** GT5U 多方块主机（EBF 等）的公共基类；仓室/管道等不继承此类。 */
    private static final String C_MTE_MULTIBLOCK_BASE = "gregtech.api.metatileentity.implementations.MTEMultiBlockBase";
    /** GT5U 多方块仓室（消声/能源/流体/总线等）公共基类；{@code MTEHatch#getTexture} 侧面单层、正面多层。 */
    private static final String C_MTE_HATCH = "gregtech.api.metatileentity.implementations.MTEHatch";

    /** 懒加载；失败时记为 {@link Void#TYPE} 表示不可用。 */
    private static volatile Class<?> cachedMteMultiblockBaseClass;
    private static volatile Class<?> cachedMteHatchClass;

    /** 与 GT5U {@code gregtech.common.blocks.BlockMachines} 注册名一致。 */
    public static final String REGISTRY_ID_GT_BLOCK_MACHINES = "gregtech:gt.blockmachines";

    private GregTechMetaTileRegistry() {}

    /**
     * @return 反射得到的 {@code METATILEENTITIES} 数组，或 {@code null}
     */
    public static Object getMetaTileEntitiesArray() {
        try {
            Class<?> gta = Class.forName(C_GREGTECH_API, false, GregTechMetaTileRegistry.class.getClassLoader());
            Object array = gta.getField("METATILEENTITIES")
                .get(null);
            if (array == null || !array.getClass()
                .isArray()) {
                return null;
            }
            return array;
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * @return {@code GregTechAPI.METATILEENTITIES[mId]}，可能为 {@code null}
     */
    public static Object tryGetMetaTileEntity(int mId) {
        Object array = getMetaTileEntitiesArray();
        if (array == null) {
            return null;
        }
        int len = Array.getLength(array);
        if (mId < 0 || mId >= len) {
            return null;
        }
        return Array.get(array, mId);
    }

    /**
     * @return {@code METATILEENTITIES[mId]} 是否为 GT5U 多方块主机（{@code MTEMultiBlockBase} 子类），例如 EBF；
     *         非此类（管道、单方块机器、仓室等）为 {@code false}。无 GregTech 或类加载失败时为 {@code false}。
     */
    public static boolean isMetaTileEntityMultiblockController(Object mte) {
        if (mte == null) {
            return false;
        }
        Class<?> base = resolveMteMultiblockBaseClass();
        if (base == null || base == Void.TYPE) {
            return false;
        }
        return base.isInstance(mte);
    }

    /**
     * @return {@code METATILEENTITIES[mId]} 是否为 GT5U 多方块仓室（{@code MTEHatch} 子类）；addons 若继承 {@code MTEHatch} 亦命中。
     */
    public static boolean isMetaTileEntityHatch(Object mte) {
        if (mte == null) {
            return false;
        }
        Class<?> h = resolveMteHatchClass();
        if (h == null || h == Void.TYPE) {
            return false;
        }
        return h.isInstance(mte);
    }

    private static Class<?> resolveMteMultiblockBaseClass() {
        Class<?> c = cachedMteMultiblockBaseClass;
        if (c != null) {
            return c;
        }
        synchronized (GregTechMetaTileRegistry.class) {
            c = cachedMteMultiblockBaseClass;
            if (c != null) {
                return c;
            }
            try {
                c = Class.forName(C_MTE_MULTIBLOCK_BASE, false, GregTechMetaTileRegistry.class.getClassLoader());
            } catch (ClassNotFoundException | LinkageError e) {
                c = Void.TYPE;
            }
            cachedMteMultiblockBaseClass = c;
            return c;
        }
    }

    private static Class<?> resolveMteHatchClass() {
        Class<?> c = cachedMteHatchClass;
        if (c != null) {
            return c;
        }
        synchronized (GregTechMetaTileRegistry.class) {
            c = cachedMteHatchClass;
            if (c != null) {
                return c;
            }
            try {
                c = Class.forName(C_MTE_HATCH, false, GregTechMetaTileRegistry.class.getClassLoader());
            } catch (ClassNotFoundException | LinkageError e) {
                c = Void.TYPE;
            }
            cachedMteHatchClass = c;
            return c;
        }
    }

    /** @return {@code METATILEENTITIES[mId] != null} 且下标在范围内 */
    public static boolean isMetaTileSlotRegistered(int mId) {
        Object array = getMetaTileEntitiesArray();
        if (array == null) {
            return false;
        }
        int len = Array.getLength(array);
        if (mId < 0 || mId >= len) {
            return false;
        }
        return Array.get(array, mId) != null;
    }

    /**
     * 自 1 起扫描至数组末尾（与 GT5U NEI dumper 一致）；槽 0 若存在非空 MTE 也会回调。
     */
    public static void forEachRegisteredMetaTileId(MetaTileIdConsumer consumer) {
        Object array = getMetaTileEntitiesArray();
        if (array == null || consumer == null) {
            return;
        }
        int len = Array.getLength(array);
        if (len > 0 && Array.get(array, 0) != null) {
            consumer.accept(0);
        }
        for (int i = 1; i < len; i++) {
            if (Array.get(array, i) != null) {
                consumer.accept(i);
            }
        }
    }

    @FunctionalInterface
    public interface MetaTileIdConsumer {

        void accept(int mId);
    }

    public static boolean isBlockMachinesClass(Block block) {
        if (block == null) {
            return false;
        }
        try {
            Class<?> c = Class.forName(C_BLOCK_MACHINES, false, GregTechMetaTileRegistry.class.getClassLoader());
            return c.isInstance(block);
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }

    /**
     * 与全量 dump、{@link com.lightning.mod.client.registry.gt.GtBlockMachinesRegistryPolicy} 使用同一判定：类 +
     * 注册名。
     */
    public static boolean isGregTechBlockMachines(Block block, String registryId) {
        return REGISTRY_ID_GT_BLOCK_MACHINES.equals(registryId) && isBlockMachinesClass(block);
    }

    /**
     * 从世界坐标读取 GT Tile 的 mID；失败时返回 {@code null}（调用方应回退
     * {@link com.lightning.mod.core.sampling.DefaultBlockSampler}）。
     */
    public static Integer tryGetMetaTileIdAt(World world, int x, int y, int z) {
        if (world == null) {
            return null;
        }
        TileEntity te;
        try {
            te = world.getTileEntity(x, y, z);
        } catch (Throwable ignored) {
            return null;
        }
        if (te == null) {
            return null;
        }
        try {
            Class<?> igt = Class.forName(
                C_IGREG_TECH_TILE,
                false,
                te.getClass()
                    .getClassLoader());
            if (!igt.isInstance(te)) {
                return null;
            }
            Method m = igt.getMethod("getMetaTileID");
            Object r = m.invoke(te);
            if (r instanceof Integer) {
                return (Integer) r;
            }
            if (r instanceof Number) {
                return ((Number) r).intValue();
            }
        } catch (Throwable ignored) {
            // fall through
        }
        return null;
    }

    /**
     * 从世界坐标读取 GT {@code ITurnable} 的正面朝向，转为 Wiki {@code FaceName}（+x/-x/+y/-y/+z/-z）。
     *
     * @return 有效朝向；{@code UNKNOWN} 或失败时为 {@code null}
     */
    public static String tryGetFrontFacingWikiFaceNameAt(World world, int x, int y, int z) {
        if (world == null) {
            return null;
        }
        TileEntity te;
        try {
            te = world.getTileEntity(x, y, z);
        } catch (Throwable ignored) {
            return null;
        }
        if (te == null) {
            return null;
        }
        try {
            Class<?> it = Class.forName(
                C_ITURNABLE,
                false,
                te.getClass()
                    .getClassLoader());
            if (!it.isInstance(te)) {
                return null;
            }
            Method m = it.getMethod("getFrontFacing");
            Object r = m.invoke(te);
            if (!(r instanceof Enum)) {
                return null;
            }
            return forgeDirectionEnumNameToWikiFaceName(((Enum<?>) r).name());
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * {@code ForgeDirection} 枚举名 → Wiki 外法线；UNKNOWN 为 {@code null}。
     */
    static String forgeDirectionEnumNameToWikiFaceName(String enumName) {
        if (enumName == null) {
            return null;
        }
        switch (enumName) {
            case "UNKNOWN":
                return null;
            case "DOWN":
                return "-y";
            case "UP":
                return "+y";
            case "NORTH":
                return "-z";
            case "SOUTH":
                return "+z";
            case "WEST":
                return "-x";
            case "EAST":
                return "+x";
            default:
                return null;
        }
    }

}
