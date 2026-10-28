package com.lightning.mod.client.meshcapture.postrender;

import java.lang.reflect.Field;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.ResourceLocation;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.util.vector.Matrix4f;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentRegistry;
import com.lightning.mod.client.meshcapture.env.ModelAccessPresence;
import com.lightning.mod.client.meshcapture.env.probes.EnderStorageTankModelProbe;
import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler;
import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler.Placement;
import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler.Quad;
import com.lightning.mod.client.meshcapture.postrender.tank.TankFrameAssembler.Vertex;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 末影储罐框架的捕获策略：把渲染器手里那份<strong>已经算好的模型顶点</strong>写进捕获窗口。
 * <p>
 * 为什么需要它：储罐的罐体/阀门/按钮在渲染器里是预计算的顶点数组，绘制时只把它们编进显示列表，顶点从不经过
 * {@code Tessellator}——通用 TESR 通道因此一个四边形都录不到，这一格只能落成占位。本策略读同一份顶点、套用同一套
 * 朝向与 UV 偏移，按真渲染器的绘制次序写进窗口，于是产物里出现的是<strong>真几何</strong>而不是替代品。
 * <p>
 * <strong>成功标准只有真几何</strong>：取不到模型、读不出顶点、顶点模式不认识——一律整条不写（本类不留半份几何），
 * 该格照常落到零产出裁决与兜底。绝不画简化块。
 * <p>
 * <strong>参与条件</strong>（三条同时成立）：本格是末影储罐方块（注册名与 meta）、该格的 TE 是储罐 TE、环境事实
 * {@link ModelAccessPresence#PRESENT}（模型数据的访问面经只读反射核对通过）。任何一条不成立就不参与——事实不是
 * PRESENT 时，连反射都不做。
 * <p>
 * <strong>与 TESR 策略并存</strong>：注册表对<strong>所有</strong> {@code applies} 为真的策略依次调度。本策略只出框架
 * （罐体/按钮/阀门），液体由既有 TESR 策略经真渲染器的液体路径产出，两边几何不相交、无双重计数。
 * <p>
 * <strong>坐标口径</strong>：本类自己算世界坐标（不依赖 GL 矩阵），因此写入前把 MODELVIEW 基线钉成"入口矩阵的逆"
 * ——捕获层据此把顶点按 {@code inv(M0) * M_now} 变换，而本类不改矩阵，等价于原样录制。若不钉基线，捕获层会退到
 * "只套 3x3"的兜底分支，把世界坐标再乘一次相机旋转。
 */
@SideOnly(Side.CLIENT)
public final class EnderStorageTankFramePostRenderStrategy implements MeshCaptureBlockPostRenderStrategy {

    /** 排在内置 multipart 策略（1000）之后、通用 TESR 策略（2000）之前：三者都会被执行，先后只影响写出次序。 */
    public static final int DEFAULT_PRIORITY = 1500;

    /** 储罐所在方块（注册名）与其 meta。 */
    public static final String BLOCK_ID = "EnderStorage:enderChest";

    public static final int TANK_META = 1;

    /** 储罐 TE 的类名（只按名字比对：子类若自绘，需要自己的适配器，不能被这里静默继承）。 */
    public static final String TANK_TILE_CLASS = "codechicken.enderstorage.storage.liquid.TileEnderTank";

    /** 渲染器只画三枚按钮：颜色位宽也是三位，第四枚没有对应 UV 档。 */
    public static final int BUTTON_COUNT = 3;

    private static final ResourceLocation ENDERTANK_TEXTURE = new ResourceLocation(
        "enderstorage",
        "textures/endertank.png");
    private static final ResourceLocation BUTTONS_TEXTURE = new ResourceLocation(
        "enderstorage",
        "textures/buttons.png");

    /** 反射访问面；{@code null} = 解析失败（本策略整条不参与）。 */
    private static volatile Access access;

    private static volatile boolean accessResolved;

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(MeshCaptureBlockPostRenderContext ctx) {
        if (ctx == null) {
            return false;
        }
        TileEntity te = ctx.getTileEntity();
        return decisionApplies(
            registryIdOf(ctx),
            ctx.getMeta(),
            te == null ? null
                : te.getClass()
                    .getName(),
            CaptureEnvironmentRegistry.current()
                .tankModelAccess());
    }

    /**
     * 参与判据的纯形式（供单测直接钉住四条合取项）：三条身份条件 + 一条事实条件，缺一不可。
     */
    static boolean decisionApplies(String registryId, int meta, String tileClassName, ModelAccessPresence presence) {
        return presence == ModelAccessPresence.PRESENT && meta == TANK_META
            && BLOCK_ID.equals(registryId)
            && TANK_TILE_CLASS.equals(tileClassName);
    }

    @Override
    public void renderPostMainBlock(MeshCaptureBlockPostRenderContext ctx) {
        TileEntity te = ctx.getTileEntity();
        if (te == null) {
            return;
        }
        Access a = access();
        if (a == null) {
            return;
        }
        List<Section> sections;
        try {
            // 先把整格的几何算完（反射 + 纯函数），再开窗口写出：写出阶段只剩 Tessellator 调用，
            // 因此不存在"算到一半抛出、留下半份几何"的路径。
            sections = assembleSections(a, te, ctx);
        } catch (Throwable t) {
            FMLLog.warning(
                "[SDE] 末影储罐框架装配失败（该格不写几何，交回零产出裁决）(%d,%d,%d): %s",
                Integer.valueOf(ctx.getWx()),
                Integer.valueOf(ctx.getWy()),
                Integer.valueOf(ctx.getWz()),
                String.valueOf(t));
            return;
        }
        if (sections.isEmpty()) {
            return;
        }
        if (!texturesReady()) {
            FMLLog.warning(
                "[SDE] 末影储罐贴图未就绪（该格不写几何，交回零产出裁决）(%d,%d,%d)",
                Integer.valueOf(ctx.getWx()),
                Integer.valueOf(ctx.getWy()),
                Integer.valueOf(ctx.getWz()));
            return;
        }
        write(sections);
    }

    // ------------------------------------------------------------------ 装配

    private static List<Section> assembleSections(Access a, TileEntity te, MeshCaptureBlockPostRenderContext ctx)
        throws IllegalAccessException {
        int rotation = a.rotationField.getInt(te);
        int freq = a.freqField.getInt(te);
        Object owner = a.ownerField.get(te);
        boolean owned = owner != null && !"global".equals(owner);
        Placement placement = new Placement(rotation, valveDegrees(a, te), ctx.getWx(), ctx.getWy(), ctx.getWz());

        List<Section> sections = new ArrayList<Section>(3);

        Object tankModel = a.tankModelField.get(null);
        List<Quad> tankQuads = TankFrameAssembler
            .assemble(readVertices(a, tankModel), vertexMode(a, tankModel), placement, false, 0.0, 0.0);
        if (!tankQuads.isEmpty()) {
            sections.add(new Section(ENDERTANK_TEXTURE, tankQuads));
        }

        Object buttons = a.buttonsField.get(null);
        if (buttons instanceof Object[]) {
            Object[] models = (Object[]) buttons;
            List<Quad> buttonQuads = new ArrayList<Quad>();
            int count = Math.min(BUTTON_COUNT, models.length);
            for (int i = 0; i < count; i++) {
                Object model = models[i];
                if (model == null) {
                    continue;
                }
                double[] offset = TankFrameAssembler.buttonUvOffset(freq, i);
                buttonQuads.addAll(
                    TankFrameAssembler.assemble(
                        readVertices(a, model),
                        vertexMode(a, model),
                        placement,
                        false,
                        offset[0],
                        offset[1]));
            }
            if (!buttonQuads.isEmpty()) {
                sections.add(new Section(BUTTONS_TEXTURE, buttonQuads));
            }
        }

        Object valveModel = a.valveModelField.get(null);
        double[] valveOffset = TankFrameAssembler.valveUvOffset(owned);
        List<Quad> valveQuads = TankFrameAssembler.assemble(
            readVertices(a, valveModel),
            vertexMode(a, valveModel),
            placement,
            true,
            valveOffset[0],
            valveOffset[1]);
        if (!valveQuads.isEmpty()) {
            sections.add(new Section(ENDERTANK_TEXTURE, valveQuads));
        }
        return sections;
    }

    /** 阀门当前静态角（度）：副本 TE 上没有值时按 0 处理（真渲染器在同一种副本状态下也画 0）。 */
    private static double valveDegrees(Access a, TileEntity te) throws IllegalAccessException {
        Object pressure = a.pressureStateField.get(te);
        if (pressure == null) {
            return 0.0;
        }
        return a.valveRotateField.getDouble(pressure);
    }

    private static int vertexMode(Access a, Object model) throws IllegalAccessException {
        return a.vertexModeField.getInt(model);
    }

    private static Vertex[] readVertices(Access a, Object model) throws IllegalAccessException {
        if (model == null) {
            throw new IllegalStateException("模型字段为空");
        }
        Object[] verts = (Object[]) a.vertsField.get(model);
        if (verts == null || verts.length == 0) {
            return new Vertex[0];
        }
        Vertex[] out = new Vertex[verts.length];
        for (int i = 0; i < verts.length; i++) {
            Object v = verts[i];
            if (v == null) {
                throw new IllegalStateException("模型顶点为空（下标 " + i + "）");
            }
            Object vec = a.vecField.get(v);
            Object uv = a.uvField.get(v);
            out[i] = new Vertex(
                a.xField.getDouble(vec),
                a.yField.getDouble(vec),
                a.zField.getDouble(vec),
                a.uField.getDouble(uv),
                a.vField.getDouble(uv));
        }
        return out;
    }

    // ------------------------------------------------------------------ 写出

    private static void write(List<Section> sections) {
        Tessellator tess = Tessellator.instance;
        tess.setTranslation(0.0, 0.0, 0.0);
        armModelViewBaseline();
        tess.startDrawingQuads();
        TessellatorCaptureState.beginDynamicExtensionVertexPhase();
        try {
            for (Section section : sections) {
                Minecraft.getMinecraft()
                    .getTextureManager()
                    .bindTexture(section.texture);
                for (Quad quad : section.quads) {
                    for (Vertex v : quad.vertices) {
                        tess.addVertexWithUV(v.x, v.y, v.z, v.u, v.v);
                    }
                }
            }
        } finally {
            TessellatorCaptureState.endDynamicExtensionVertexPhase();
        }
        tess.draw();
    }

    /**
     * 两张独立贴图先逼进纹理表：写窗口里只剩重新绑定，窗口内不会因为资源加载失败而留下半份几何。
     * <p>
     * 判据用"纹理表里确实有它"，而不是"绑定没抛错"——{@code bindTexture} 对缺资源也可能安静地绑上占位纹理。
     */
    private static boolean texturesReady() {
        return ensureTextureLoaded(ENDERTANK_TEXTURE) && ensureTextureLoaded(BUTTONS_TEXTURE);
    }

    private static boolean ensureTextureLoaded(ResourceLocation texture) {
        try {
            net.minecraft.client.renderer.texture.TextureManager manager = Minecraft.getMinecraft()
                .getTextureManager();
            manager.bindTexture(texture);
            return manager.getTexture(texture) != null;
        } catch (Throwable t) {
            FMLLog.warning("[SDE] 末影储罐贴图绑定失败（%s）: %s", texture, String.valueOf(t));
            return false;
        }
    }

    /**
     * 钉住 MODELVIEW 基线（入口矩阵的逆）。本类写的是自己算好的世界坐标且不改矩阵，因此捕获层的
     * {@code inv(M0) * M_now} 恰为恒等变换；不钉基线会退到"只套 3x3"的兜底分支，把世界坐标再乘一次相机旋转。
     */
    private static void armModelViewBaseline() {
        FloatBuffer mv0 = BufferUtils.createFloatBuffer(16);
        GL11.glGetFloat(GL11.GL_MODELVIEW_MATRIX, mv0);
        mv0.rewind();
        Matrix4f atEntry = new Matrix4f();
        atEntry.load(mv0);
        Matrix4f inverse = new Matrix4f();
        if (Matrix4f.invert(atEntry, inverse) != null) {
            FloatBuffer invBuf = BufferUtils.createFloatBuffer(16);
            inverse.store(invBuf);
            invBuf.rewind();
            float[] snapshot = new float[16];
            invBuf.get(snapshot);
            TessellatorCaptureState.armDynamicPassModelViewBaselineInverse(snapshot);
        }
    }

    private static String registryIdOf(MeshCaptureBlockPostRenderContext ctx) {
        if (ctx.getBlock() == null) {
            return null;
        }
        GameRegistry.UniqueIdentifier id = GameRegistry.findUniqueIdentifierFor(ctx.getBlock());
        return id == null ? null : id.toString();
    }

    // ------------------------------------------------------------------ 反射访问面

    private static Access access() {
        if (!accessResolved) {
            synchronized (EnderStorageTankFramePostRenderStrategy.class) {
                if (!accessResolved) {
                    access = Access.resolve();
                    accessResolved = true;
                    if (access == null) {
                        FMLLog.warning("[SDE] 末影储罐模型访问面不可用，本策略整条不参与");
                    }
                }
            }
        }
        return access;
    }

    private static final class Section {

        final ResourceLocation texture;
        final List<Quad> quads;

        Section(ResourceLocation texture, List<Quad> quads) {
            this.texture = texture;
            this.quads = quads;
        }
    }

    /**
     * 一次解析、全程复用的反射句柄。解析失败即 {@code null}：宁可整条不参与，也不在半知半解的状态下写几何。
     */
    private static final class Access {

        final Field tankModelField;
        final Field valveModelField;
        final Field buttonsField;
        final Field vertsField;
        final Field vertexModeField;
        final Field vecField;
        final Field uvField;
        final Field xField;
        final Field yField;
        final Field zField;
        final Field uField;
        final Field vField;
        final Field rotationField;
        final Field freqField;
        final Field ownerField;
        final Field pressureStateField;
        final Field valveRotateField;

        private Access(Class<?> rendererClass, Class<?> modelClass, Class<?> vertexClass, Class<?> tankClass)
            throws NoSuchFieldException {
            tankModelField = rendererClass.getDeclaredField("tankModel");
            valveModelField = rendererClass.getDeclaredField("valveModel");
            buttonsField = rendererClass.getDeclaredField("buttons");
            setAccessible(tankModelField);
            setAccessible(valveModelField);
            setAccessible(buttonsField);
            vertsField = modelClass.getField("verts");
            vertexModeField = modelClass.getField("vertexMode");
            vecField = vertexClass.getField("vec");
            uvField = vertexClass.getField("uv");
            Class<?> vecClass = vecField.getType();
            Class<?> uvClass = uvField.getType();
            xField = vecClass.getField("x");
            yField = vecClass.getField("y");
            zField = vecClass.getField("z");
            uField = uvClass.getField("u");
            vField = uvClass.getField("v");
            rotationField = tankClass.getField("rotation");
            freqField = tankClass.getField("freq");
            ownerField = tankClass.getField("owner");
            pressureStateField = tankClass.getField("pressure_state");
            valveRotateField = pressureStateField.getType()
                .getField("a_rotate");
        }

        static Access resolve() {
            try {
                Class<?> rendererClass = load(EnderStorageTankModelProbe.RENDERER_CLASS);
                Class<?> modelClass = load(EnderStorageTankModelProbe.MODEL_CLASS);
                Class<?> vertexClass = load(EnderStorageTankModelProbe.VERTEX_CLASS);
                Class<?> tankClass = load(TANK_TILE_CLASS);
                if (rendererClass == null || modelClass == null || vertexClass == null || tankClass == null) {
                    return null;
                }
                return new Access(rendererClass, modelClass, vertexClass, tankClass);
            } catch (Throwable t) {
                FMLLog.warning("[SDE] 末影储罐模型访问面解析失败: %s", String.valueOf(t));
                return null;
            }
        }

        private static void setAccessible(Field field) {
            try {
                field.setAccessible(true);
            } catch (Throwable ignored) {
                // 拿不到可访问性就交给读取时抛错，由上层整条放弃
            }
        }

        private static Class<?> load(String name) {
            try {
                return Class.forName(name, false, EnderStorageTankFramePostRenderStrategy.class.getClassLoader());
            } catch (Throwable t) {
                return null;
            }
        }
    }
}
