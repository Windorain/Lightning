package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import net.minecraft.item.ItemStack;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.GregTechAPI;
import gregtech.api.interfaces.metatileentity.IMetaTileEntity;
import gregtech.common.render.IMTERenderer;

/**
 * 一台被探针盯上的 GT 多方块：按类名在 {@link GregTechAPI#METATILEENTITIES} 里解析出注册实例。
 * <p>
 * 用「类名 → 运行时注册实例」而不是硬编码 meta id：meta id 随 GT5U 版本漂移，类名是稳定标识；
 * 与 {@code BlockRenderer6343} 的 {@code GTConstructableScan} 走的是同一条注册表。
 */
@SideOnly(Side.CLIENT)
public final class ProbeTarget {

    /** 构造方式：是否需要把结构真的建起来（决定能否走到 {@code checkStructure} 成功）。 */
    public enum StructurePlan {
        /** 不用建造（例如结构过大），只探测控制器本体与状态机可达性。 */
        NONE,
        /** 真实构造结构；若仍有舱口缺口，按「逐格试放维护仓」补偿。 */
        BUILD_AND_FIND_HATCH
    }

    public final String fqcn;
    public final String label;
    public final int metaTileId;
    public final StructurePlan structurePlan;
    /** 目标机器的结构无法/不必建起时，允许用公开逃生门 {@code IMachineProgress#setActive} 抵达活动态。 */
    public final boolean allowEscapeHatch;

    public transient IMetaTileEntity metaTile;

    private ProbeTarget(String fqcn, String label, int metaTileId, StructurePlan structurePlan,
        boolean allowEscapeHatch, IMetaTileEntity metaTile) {
        this.fqcn = fqcn;
        this.label = label;
        this.metaTileId = metaTileId;
        this.structurePlan = structurePlan;
        this.allowEscapeHatch = allowEscapeHatch;
        this.metaTile = metaTile;
    }

    public String slug() {
        return label.toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("^-|-$", "");
    }

    public boolean hasTesr() {
        return metaTile instanceof IMTERenderer;
    }

    /** 触发文件提供的目标集覆盖（一次运行有效，运行结束由自动化入口置回 null）。 */
    public static volatile List<ProbeTarget> defaultsOverride;

    /** T0.3 默认目标集：一台「活动纹理」代表 + 一台「TESR 活动表现」代表。 */
    public static List<ProbeTarget> defaults() {
        List<ProbeTarget> override = defaultsOverride;
        if (override != null && !override.isEmpty()) {
            return new ArrayList<ProbeTarget>(override);
        }
        List<ProbeTarget> out = new ArrayList<ProbeTarget>();
        addIfResolvable(
            out,
            "gregtech.common.tileentities.machines.multi.MTEElectricBlastFurnace",
            "MTEElectricBlastFurnace",
            StructurePlan.BUILD_AND_FIND_HATCH,
            false);
        addIfResolvable(
            out,
            "gregtech.common.tileentities.machines.multi.foundry.MTEExoFoundry",
            "MTEExoFoundry",
            StructurePlan.NONE,
            true);
        return out;
    }

    private static void addIfResolvable(List<ProbeTarget> out, String fqcn, String label, StructurePlan plan,
        boolean allowEscapeHatch) {
        ProbeTarget t = resolve(fqcn, label, plan, allowEscapeHatch);
        if (t != null) {
            out.add(t);
        }
    }

    public static ProbeTarget resolve(String fqcn, String label, StructurePlan plan, boolean allowEscapeHatch) {
        IMetaTileEntity[] all = GregTechAPI.METATILEENTITIES;
        if (all == null) {
            return null;
        }
        for (int i = 0; i < all.length; i++) {
            IMetaTileEntity mte = all[i];
            if (mte == null) {
                continue;
            }
            if (fqcn.equals(
                mte.getClass()
                    .getName())) {
                return new ProbeTarget(fqcn, label, i, plan, allowEscapeHatch, mte);
            }
        }
        return null;
    }

    public String describeStackForm() {
        try {
            ItemStack stack = metaTile.getStackForm(1);
            return stack == null ? "<null>" : stack.getDisplayName() + " (" + ItemStack.class.getSimpleName() + ")";
        } catch (Throwable t) {
            return "<unavailable: " + t.getClass()
                .getSimpleName() + ">";
        }
    }
}
