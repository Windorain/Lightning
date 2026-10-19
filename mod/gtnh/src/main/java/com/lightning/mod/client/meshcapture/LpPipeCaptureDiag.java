package com.lightning.mod.client.meshcapture;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import net.minecraft.tileentity.TileEntity;
import net.minecraftforge.common.util.ForgeDirection;

/**
 * 临时诊断（不入库）：抓取时打印 LP 管 TE 的渲染状态，用于定性「旧渲染器兜底」vs「渲染列表已编译」。
 */
public final class LpPipeCaptureDiag {

    private static final boolean ENABLED = !"0".equals(System.getProperty("sde.lpDiag", "1"));

    private LpPipeCaptureDiag() {}

    public static void dump(String phase, TileEntity te, int wx, int wy, int wz) {
        if (!ENABLED || te == null) {
            return;
        }
        String cn = te.getClass()
            .getName();
        if (!cn.startsWith("logisticspipes")) {
            return;
        }
        StringBuilder sb = new StringBuilder("[LP-DIAG] ").append(phase)
            .append(' ')
            .append(cn)
            .append(" @")
            .append(wx)
            .append(',')
            .append(wy)
            .append(',')
            .append(wz);
        try {
            Object rs = field(te, "renderState");
            if (rs == null) {
                sb.append(" renderState=null");
            } else {
                Object list = field(rs, "renderList");
                if (list == null) {
                    sb.append(" list=null");
                } else {
                    sb.append(" list(filled=")
                        .append(inv(list, "isFilled"))
                        .append(",invalid=")
                        .append(inv(list, "isInvalid"))
                        .append(')');
                }
                sb.append(" cached=")
                    .append(field(rs, "cachedRenderer") != null);
                sb.append(" old=")
                    .append(field(rs, "forceRenderOldPipe"));
                Object cm = field(rs, "pipeConnectionMatrix");
                if (cm != null) {
                    StringBuilder dirs = new StringBuilder();
                    Method m = cm.getClass()
                        .getMethod("isConnected", ForgeDirection.class);
                    for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
                        Object r = m.invoke(cm, d);
                        if (Boolean.TRUE.equals(r)) {
                            dirs.append(d.name()
                                .charAt(0));
                        }
                    }
                    sb.append(" conn=")
                        .append(dirs.length() == 0 ? "-" : dirs.toString());
                }
                Object tm = field(rs, "textureMatrix");
                if (tm != null) {
                    sb.append(" routed=")
                        .append(inv(tm, "isRouted"));
                }
            }
        } catch (Throwable t) {
            sb.append(" ERR ")
                .append(t);
        }
        System.out.println(sb);
    }

    private static Object field(Object owner, String name) throws Exception {
        Field f = owner.getClass()
            .getField(name);
        return f.get(owner);
    }

    private static Object inv(Object owner, String method) throws Exception {
        Method m = owner.getClass()
            .getMethod(method);
        return m.invoke(owner);
    }
}
