package com.lightning.mod.client.controlplane.mc.capture;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

import javax.imageio.ImageIO;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.EntityRenderer;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.util.ScreenShotHelper;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CameraSpec;
import com.lightning.mod.client.controlplane.core.CameraSpecs;
import com.lightning.mod.client.controlplane.core.CaptureSpec;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.CpLog;

/**
 * 多机位截图执行器（contract.md §4.1 {@code shot.multi}），逐 tick 推进一步的状态机。
 *
 * <h2>一拍一张的时序（每个机位）</h2>
 * <ol>
 * <li>{@code WARMUP}：设 worldTime（如指定）→ 相机就位 → 客户端世界 {@code getBlock} 触碰
 * 机位所在区块，逼出区块加载/网格重建（相机在未加载区块里会拍到空气）；</li>
 * <li>{@code SETTLE}：等 {@link #SETTLE_TICKS} 个 tick，让区块网格与 TESR 出帧、光照收敛；</li>
 * <li>{@code RENDER}/{@code READBACK}（每个 tile 一次）：分辨率覆写 → 隐藏玩家 → 注入相机与投影 →
 * 直接调 {@code EntityRenderer.renderWorld} 渲一帧 → {@code ScreenShotHelper} 落 PNG → 还原
 * （玩家可见性、投影、{@code renderViewEntity}、framebuffer 尺寸都在 {@link FrameScope} 的
 * try/finally 里还原）；</li>
 * <li>{@code COMPOSE}：拼接机位把各 tile 按<b>格位</b>像素级拼成整图（投影偏移法下 overlap 不参与
 * 像素装配，见 {@link #compose}），并保留 {@code <name>.tiles/}；</li>
 * <li>收尾写 {@code shots/<name>.meta.json}（schema {@code lightning.shot-meta/1}）并登记产物：
 * 整图 {@code role=shot}、拼接单片 {@code role=shot-tile}、meta {@code role=shot-meta}。</li>
 * </ol>
 *
 * <h2>每片像素只存一份（拼接机位）</h2>
 * 拼接机位的单片<b>直接</b>落在 {@code shots/<name>.tiles/r<row>c<col>.png}（{@link #shoot} 的落点），
 * 它既是「可单独核对接缝的原始帧」也是唯一产物，登记 {@code role=shot-tile}。不再往 {@code shots/}
 * 另写一份 {@code <name>-r<row>c<col>.png} 中间帧：同一批像素两处落盘只会让 run manifest 与动作结果的
 * {@code artifacts} 出现两条同内容记录，事后无从判断以哪份为准（原先中间帧还不登记，等于白占一份磁盘与
 * 一个语义）。单片命名仍是 {@code r<row>c<col>.png}（1 起），与 meta 的 {@code tile.cols/rows} 对齐。
 *
 * <h2>拍摄帧内隐藏玩家（模型与手持物两条路都要堵）</h2>
 * {@code RenderGlobal.renderEntities} 只跳过 {@code mc.renderViewEntity} <b>自己</b>
 * （反编译源 {@code RenderGlobal.java:524}：{@code entity != this.mc.renderViewEntity || ...}），
 * 而注入的相机不是玩家 ⇒ 稳定化在场景旁的<b>玩家模型</b>会进每个机位的画面。故每片渲染的作用域里
 * {@code mc.thePlayer.setInvisible(true)}、finally 还原原值，逐机位 meta 记 {@code playerHidden}。
 * {@code setInvisible} 只改客户端实体 dataWatcher 的显示标志（{@code Entity.setInvisible} → {@code setFlag(5)}），
 * 不写服务端实体、不动世界状态。渲染侧生效点是 {@code RendererLivingEntity.renderModel:307-328}：
 * 隐身时走「不画」分支（托管世界无队伍 ⇒ {@code EntityPlayer.isInvisibleToPlayer} 返回 true，
 * {@code EntityPlayer.java:2380-2391}）；只有玩家属于「可互见隐身」的队伍时才会退化成 15% alpha 剪影。
 *
 * <p>
 * {@code setInvisible} 只挡「模型」，挡不住<b>手持物/装备</b>：{@code RendererLivingEntity.doRender:229}
 * 的 {@code renderEquippedItems(...)} 在隐身判断<b>之外</b>无条件调用（隐身判断只在它上方的
 * {@code renderModel:307-328} 里），{@code RenderPlayer.renderEquippedItems:182-187} 会把手里的物品
 * 整个画出来（r4 真机实测：玩家手上那本 TConstruct 手册以<b>不透明</b>像素出现在每个机位里，
 * 俯视正交机位里压在石条上，采样色 {@code b89560/9c814a/715c38}，远超 15% alpha 与背景混合的量级）。
 * 修法不是逐件拦，而是在渲染入口取消整个人：{@code MixinRendererLivingEntityShot} 在
 * {@code RendererLivingEntity.doRender} 的 HEAD 处按「本帧是否处于拍摄作用域」并且
 * 「被渲染实体 == {@code mc.thePlayer}」取消整段渲染（作用域判定 = {@link CaptureRenderState}，
 * 装备/护甲/手持物随之一起消失；机制、调用链与副作用逐条排查见该类注释）。
 * 两条拦法互补：{@code setInvisible} 负责影子（{@code Render.java:313} 的 {@code !isInvisible()}）
 * 与旁人视角的剪影分支，mixin 负责手持物。{@code playerHidden} 字段因此仍然只记录
 * 「本帧确实把玩家置为隐身」（它是 {@code setInvisible} 的留痕，不是「画面上一定没有人」的证明）。
 *
 * <h2>视点口径（{@code effectiveEyePos}）</h2>
 * 机位声明的 {@code pos} 经 {@link VirtualCamera}（{@code yOffset = 1.62}）后就是实际视点
 * （推导见 {@link VirtualCamera} 类注释），逐机位 meta 用 {@code effectiveEyePos} 把这条口径写成字段
 * （= 声明 {@code pos}）；原版第一人称相机固有的 0.1 格常量不随声明变化，故不进这个字段。
 *
 * <h2>为什么直接调 {@code renderWorld} 而不是等游戏自己渲</h2>
 * 游戏每帧只渲染一次、且相机是玩家。要在<b>同一 tick 内</b>连续拿到 N 个机位 × M 个 tile 的帧，
 * 必须自己驱动渲染。1.7.10 单机里 tick 线程 == 渲染线程，因此这种「自己渲」与游戏自身的渲染
 * 在同一线程上串行，不存在并发改 GL 状态的问题（contract §4.3.5 的线程口径）。
 *
 * <h2>ScreenShotHelper 的三个已知坑（逐条规避）</h2>
 * <ul>
 * <li>第一参是<b>游戏目录</b>，既不是文件路径也不是我们的产物目录：helper 内部自己拼
 * {@code new File(gameDir, "screenshots")}（反编译源 {@code ScreenShotHelper.java:50}），
 * 传 {@code mc.mcDataDir} 时文件落在 {@code <mcDataDir>/screenshots/}。故落盘分两步：先让 helper 写它
 * 自己的目录，再 move 进 run 目录的 {@code shots/}（{@link #shoot} 对「helper 的落点」与
 * 「直接写产物目录」两个候选都探测一次，兜住补丁/环境差异）；</li>
 * <li>失败也返回非 null（返回的是可点击的错误文本组件，异常被吞进日志）：判据只能是
 * <b>目标文件存在且 size &gt; 0</b>；</li>
 * <li>同名旧文件会被直接覆盖/复用：按快门<b>前</b>先把同名旧图改名进 {@code <name>.png.trash-<ts>}
 * （不删除，只标记）——否则上一轮的图会被当成本轮证据。</li>
 * </ul>
 *
 * <h2>为什么每片都必须重新绑定 framebuffer（纯黑事故 B1 的根因与修法）</h2>
 * 手工渲染这一条路径上，{@code bindFramebuffer} 必须出现在 {@code framebufferClear()} <b>之后</b>：
 * {@code Framebuffer.framebufferClear()} 的最后一句是 {@code unbindFramebuffer()}（反编译源
 * {@code Framebuffer.java:265-279}），它把渲染目标切回默认 framebuffer（窗口）。而读回走的是
 * {@code ScreenShotHelper} 的 {@code glGetTexImage(framebufferMc.framebufferTexture)}（反编译源
 * {@code ScreenShotHelper.java:71-79}，{@code fboEnable=true} 时的唯一路径），读的是那张纹理。
 * 于是「渲染写窗口、读回读 FBO 纹理」时，纹理里只有创建期的清屏色——{@code Minecraft.java:510} 把
 * {@code framebufferColor} 设成 {@code (0,0,0,0)}，于是每个 PNG、每个 tile 都恒为纯黑（真机实测：
 * 1280×720 全 0，2759 字节；4 个 tile 各 1586 字节，且四片 sha256 相同），且 GL 不报错、
 * {@code cameraHeldDuringRender} 为 true、任何全链路判据（尺寸/片数/命名/注入/无异常）都能全绿——
 * 只有 {@code image-not-uniform} 会红。游戏自身路径不受影响：它在 {@code Minecraft.java:1052} 是在
 * {@code bindFramebuffer} 之后直接调 {@code updateCameraAndRender}，中间没有清屏调用。
 *
 * <p>
 * 该缺陷对「FBO 未绑定」这类排查有极强的误导性：{@code arm} 里确实<b>写了</b>
 * {@code bindFramebuffer(true)} 与 {@code framebufferClear()}，读代码像是绑过的。防空手段是把
 * 「帧结束时到底绑着哪个 framebuffer」变成日志（{@link FrameScope#probeRenderTarget} 的一次性
 * 自证：绑定名 + 视口 + 两个读回目标的中心像素 + {@code glGetError}）。实测（未修版）：
 * {@code GL_FRAMEBUFFER_BINDING=0 framebufferObject=1 viewport=[0,0,1280,720] glGetError=0 |
 * 渲染后当前写目标中心像素=#00bcd5ff | framebufferMc 纹理中心像素=#00000000}——帧确实画出了内容，
 * 只是画在窗口（0）而不是 framebufferMc（1）上；修后同一条日志两侧一致，且 PNG 从 2759 字节变
 * 13k/14k/39k 字节、主色占比 90.2% &lt; 0.98 阈值。
 *
 * <h2>投影覆写必须自己切矩阵栈（纯黑事故 B2）</h2>
 * 修完 FBO 绑定后画面已非黑，但三个机位的图<b>仍然长得一模一样</b>（2×2 的四片 sha256 逐位相同）。
 * 原因是 {@link ProjectionOverride} 的写入点（{@code setupCameraTransform} 的 {@code RETURN}）
 * 当前矩阵栈是 MODELVIEW 而不是 PROJECTION，裸 {@code glLoadMatrix} 既没改到投影、又把相机变换
 * 覆盖掉了。推导、实测与修法见 {@link ProjectionOverride#applyToCurrentProjectionMatrix()} 与
 * {@link MixinEntityRendererProjection} 的类注释。
 *
 * <h2>禁止视口拼接</h2>
 * tile 全部靠 {@link ProjectionOverride} 的投影偏移实现，<b>从不</b>移动 GL 视口：
 * {@code EntityRenderer.renderWorld} 每帧强制 {@code glViewport(0,0,displayWidth,displayHeight)}，
 * 视口拼接会被它改回去，接缝必然错位（contract §4.3.4 明令禁止）。
 *
 * <h2>GUI 取证的默认行为（为什么必须是 opt-in）</h2>
 * 本执行器<b>默认</b>只画世界（{@code gui=none}）：不读 {@code mc.currentScreen}、不改
 * {@code GuiScreen.width/height}、不发 {@code DrawScreenEvent}、meta 与结果里不多一个键
 * ⇒ 既有 {@code shot.multi} 调用的产物与 A3 基准逐字节可比。
 * 传 {@code gui="screen"} 才走 {@link #captureScreen}（真 {@code currentScreen} 由游戏自己画入本帧，
 * 含 {@code DrawScreenEvent.Pre/Post}），此时 meta/结果新增 {@code guiCapture} 与
 * {@code guiHidden=false} —— <b>这是刻意的</b>：授权了 GUI 取证却仍报 {@code guiHidden=true}
 * 会让「画面里到底有没有界面」不可判。新增字段对旧哈希/判据的影响见 {@link ShotMultiAction} 的类注释。
 */
public final class ShotExecutor {

    /** 机位就位后等待的 tick 数（区块网格重建 + TESR 出帧 + 光照收敛）。 */
    public static final int SETTLE_TICKS = 6;

    /** shot-meta schema。 */
    public static final String SHOT_META_SCHEMA = "lightning.shot-meta/1";

    /** 产物根目录（run 目录内）。 */
    public static final String SHOTS_DIR = "shots";

    /** 渲染故障时的重试上限（每机位每 tile 一次机会）。 */
    private static final int MAX_ATTEMPTS = 2;

    /** {@code gui} 参数取值：不拍 GUI（默认；既有 A3 基准的可比路径）。 */
    public static final String GUI_NONE = "none";

    /** {@code gui} 参数取值：把真实 {@code currentScreen} 画进这一帧（真 GUI 取证）。 */
    public static final String GUI_SCREEN = "screen";

    /** {@code gui} 参数取值域（越域即 {@code CP-VALID-002}）。 */
    private static final String[] GUI_MODES = { GUI_NONE, GUI_SCREEN };

    /** {@code GL_FRAMEBUFFER_BINDING}（EXT 与核心同值 0x8CA6）：当前绑定的 framebuffer 名。 */
    private static final int GL_FRAMEBUFFER_BINDING = 0x8CA6;

    /** 执行输入。 */
    public static final class Input {

        /** 客户端实例。 */
        public Minecraft mc;

        /** 本次 run（产物登记；可为 null——此时只落文件不登记）。 */
        public ArtifactStore artifacts;

        /** run 句柄。 */
        public ArtifactStore.Run run;

        /** 机位表（已校验）。 */
        public List<CameraSpec> cameras = new ArrayList<CameraSpec>();

        /** 会话参数（capture 段；可为 null）。 */
        public CaptureSpec capture;

        /** {@code target} 包围盒（契约 §4.1 的观察目标；仅留痕，不参与相机计算）。 */
        public JsonArray target;

        /** 世界写动作门控的作业 id（{@code capture.end} 的记录口径）。 */
        public String jobId;

        /** 动作名（事件与日志用）。 */
        public String action;

        /** 逐机位进度回调（可为 null）。 */
        public Progress progress;

        /**
         * GUI 取证模式：{@link #GUI_NONE}（默认，保持既有行为逐字节可比）或 {@link #GUI_SCREEN}。
         *
         * <p>
         * 默认值就是 {@code none}：{@code null} 与 {@code none} 同义。既有 {@code shot.multi} 调用方
         * 不传新参数 ⇒ 走原路径（不读 {@code currentScreen}、{@code hideGUI=true}、meta 里
         * {@code guiHidden=true}），A3 基准不受影响。
         */
        public String guiCapture;
    }

    /** 进度回调（0..1 与说明）。 */
    public interface Progress {

        /** 上报进度。 */
        void onProgress(double fraction, String message);
    }

    /**
     * 一个机位的执行状态。
     *
     * <p>
     * 网格（{@link TilePlan}）在 {@code onBegin} 时用<b>当时的真实窗口尺寸</b>算一次并保存下来：
     * 之后无论 {@code mc.displayWidth} 被覆写成多少，本机位的网格与分片尺寸都不再变化——这正是
     * r3 事故（执行器 2×2 vs 投影覆写 1×1）要修掉的「同一件事算两遍、且输入不同源」。
     */
    private static final class CameraRun {

        private final CameraSpec spec;
        /** 有效 tile 网格（唯一网格定义点；可能因像素比例自动追加划分，见 {@link TilePlan}）。 */
        private final TilePlan plan;
        /** 逐 tile 读回的整图（null 元素 = 该 tile 失败）。 */
        private final BufferedImage[][] tiles;
        private int tileIndex;
        private int settle = -1;
        private int attempts;
        /** 本机位渲染期是否隐藏过玩家（meta 留痕；见类注释「拍摄帧内隐藏玩家」）。 */
        private boolean playerHidden;
        /**
         * 最后一次 arm 时投影覆写的参数快照（meta 留痕）。
         *
         * <p>
         * 必须在 {@link FrameScope#arm} 里取：{@code finishCamera} 跑在 tile 作用域关闭之后，
         * 那时 {@link ProjectionOverride#disarm()} 已经执行，现场去问只会拿到 {@code none}。
         */
        private String projectionApplied = "none";
        /**
         * 本机位拍摄时刻的 GUI 消费链读数（{@code gui=screen} 时逐片留痕，见
         * {@link #captureScreen}）；空数组 = 本次未启用 GUI 取证。
         */
        private final JsonArray guiCaptureJson = new JsonArray();
        /** 本次拍摄是否请求了 GUI 取证（{@code gui=screen}）；决定 meta 的 {@code guiHidden} 取值。 */
        private final boolean guiCaptureRequested;
        private final JsonObject result = new JsonObject();

        CameraRun(CameraSpec spec, int baseW, int baseH, boolean guiCaptureRequested) {
            this.spec = spec;
            this.plan = TilePlan.of(spec.width(), spec.height(), spec.tileCols(), spec.tileRows(), baseW, baseH);
            this.tiles = new BufferedImage[plan.rows()][plan.cols()];
            this.guiCaptureRequested = guiCaptureRequested;
        }
    }

    private final Input in;
    private final List<CameraRun> runs = new ArrayList<CameraRun>();

    private boolean begun;
    private int index;
    private int phase;
    private boolean failed;
    private final JsonArray cameraResults = new JsonArray();
    private final JsonArray warnings = new JsonArray();
    private long startedAtMs;

    /** 真实窗口尺寸（覆写前保存；还原时用真值，不读 {@code Display}）。 */
    private int baseWidth;
    private int baseHeight;

    /** 被改过的 gameSettings 原值（帧末还原）。 */
    private float savedFov;
    private int savedThirdPerson;
    /** 拍摄帧里被置真的 {@code hideGUI} 原值（挡住<b>第一人称</b>手持物/选择框，见 {@code renderAndRead}）。 */
    private boolean savedHideGui;
    private boolean settingsSaved;

    /** 渲染注入前的 {@code mc.renderViewEntity}（try/finally 必还原）。 */
    private Object savedRenderViewEntity;

    /** 当前 framebuffer 的实际尺寸（0 = 尚未覆写；用于跳过多余的 FBO 重建）。 */
    private int lastBufferW;
    private int lastBufferH;

    /**
     * 上一帧渲染结束时 {@code mc.renderViewEntity} 是否仍是我们注入的相机。
     *
     * <p>
     * {@code EntityRenderer.renderWorld} 开头会在 renderViewEntity 为 null 时把它设成玩家，
     * 而 {@code orientCamera} 依赖它算相机位置；若别的兼容代码在渲染中途把它改回玩家，画面会
     * 「悄悄变成玩家视角」——这种静默错图最难查。故每次渲染后核验一次并落 meta，异常即告警。
     */
    private boolean cameraHeldDuringRender = true;

    /** 渲染目标自证日志是否已输出（一次拍摄只输出一次，见 {@link FrameScope#probeRenderTarget}）。 */
    private boolean renderTargetProbed;

    /**
     * 「界面绘制自证」是否已经输出过（每次执行器只打一条，见 {@link #captureScreen}）。
     */
    private boolean guiDrawProbed;

    private VirtualCamera camera;

    public ShotExecutor(Input input) {
        this.in = input == null ? new Input() : input;
    }

    /** 逐机位结果（含失败项）。 */
    public JsonArray cameraResults() {
        return Json.copyArray(cameraResults);
    }

    /** 执行期的告警（非致命，落结果）。 */
    public JsonArray warnings() {
        return Json.copyArray(warnings);
    }

    /** 是否已经跑完（成功或失败）。 */
    public boolean finished() {
        return failed || index >= runs.size();
    }

    /**
     * 推进一步。
     *
     * @return null = 未完成（下个 tick 继续）；非 null = 结果 JSON（含逐机位产物引用与实际渲染参数）
     * @throws CpException CP-EXEC-001：渲染/落盘故障；CP-STATE-001：世界或玩家不在位
     */
    public JsonObject tick() throws Exception {
        if (!begun) {
            onBegin();
        }
        if (failed) {
            return result();
        }
        while (index < runs.size()) {
            CameraRun run = runs.get(index);
            switch (phase) {
                case 0:
                    warmUp(run);
                    phase = 1;
                    return null;
                case 1:
                    if (run.settle < 0) {
                        run.settle = SETTLE_TICKS;
                    }
                    if (run.settle-- > 0) {
                        return null;
                    }
                    phase = 2;
                    return null;
                case 2:
                    if (renderNextTile(run)) {
                        phase = 3;
                    }
                    return null;
                default:
                    finishCamera(run);
                    index++;
                    phase = 0;
                    return null;
            }
        }
        cleanup();
        return result();
    }

    // ------------------------------------------------------------ 生命周期

    private void onBegin() {
        begun = true;
        startedAtMs = System.currentTimeMillis();
        Minecraft mc = in.mc;
        if (mc == null || mc.theWorld == null) {
            throw new CpException(ErrorCodes.STATE, "客户端未在世界中，无法拍摄（先 world.rebuild 进入托管世界）");
        }
        baseWidth = mc.displayWidth;
        baseHeight = mc.displayHeight;
        settingsSaved = false;
        camera = new VirtualCamera(mc.theWorld);
        for (CameraSpec spec : in.cameras) {
            runs.add(new CameraRun(spec, baseWidth, baseHeight, GUI_SCREEN.equals(guiMode())));
        }
        ensureRunShotsDir();
        CpLog.info(
            "取证拍摄开始：机位 %d 个（action=%s run=%s），真实窗口 %dx%d",
            Integer.valueOf(runs.size()),
            in.action,
            in.run == null ? "<none>" : in.run.runId(),
            Integer.valueOf(baseWidth),
            Integer.valueOf(baseHeight));
    }

    /** 机位就位 + 强制区块加载 + 设 worldTime。 */
    private void warmUp(CameraRun run) {
        Minecraft mc = in.mc;
        CameraSpec spec = run.spec;
        if (in.capture != null && in.capture.hasWorldTime() && mc.theWorld != null) {
            // 光照基准必须设在服务端世界：客户端 setWorldTime 会被集成服务端每 20 tick 的
            // S03PacketTimeUpdate 覆写回服务器时间（真机实证 worldTime 在拂晓/正午间随机跳，
            // 同用例亮度可差 2/3——契约「worldTime 决定拍摄光照基准」因此曾是空话）。
            // 与 world.info 同源教训：世界真相在 MinecraftServer 侧。客户端同步设一次只是
            // 让本帧立即生效，服务端设定后下一次广播会把它巩固下来。
            long t = in.capture.worldTime();
            try {
                net.minecraft.server.MinecraftServer server = net.minecraft.server.MinecraftServer.getServer();
                if (server != null && server.worldServers != null
                    && server.worldServers.length > 0
                    && server.worldServers[0] != null) {
                    server.worldServers[0].setWorldTime(t);
                }
            } catch (Throwable tErr) {
                warn("服务端 worldTime 设定失败（光照基准可能漂移）: " + tErr);
            }
            mc.theWorld.setWorldTime(t);
        }
        double[] pos = spec.pos();
        camera.place(pos[0], pos[1], pos[2], spec.yaw(), spec.pitch());
        // 触碰机位所在区块：未加载的区块渲染出来是空气，先让客户端世界把这块建出来
        try {
            mc.theWorld.getBlock((int) Math.floor(pos[0]), clampY(pos[1]), (int) Math.floor(pos[2]));
        } catch (Throwable t) {
            warn("机位 " + spec.name() + " 触碰区块失败（可能拍到空气）: " + t);
        }
        report(run, "warmup");
        CpLog.info(
            "机位 %s 就位：pos=(%.3f,%.3f,%.3f) yaw=%.2f pitch=%.2f %s resolution=%dx%d tile=%dx%d overlap=%.3f",
            spec.name(),
            Double.valueOf(pos[0]),
            Double.valueOf(pos[1]),
            Double.valueOf(pos[2]),
            Double.valueOf(spec.yaw()),
            Double.valueOf(spec.pitch()),
            spec.isOrtho() ? "projection=ortho orthoHeight=" + spec.orthoHeight()
                : "projection=perspective fov=" + spec.fov(),
            Integer.valueOf(spec.width()),
            Integer.valueOf(spec.height()),
            Integer.valueOf(spec.tileCols()),
            Integer.valueOf(spec.tileRows()),
            Double.valueOf(spec.tileOverlap()));
    }

    /** 渲染下一个 tile；全部完成返回 true。 */
    private boolean renderNextTile(CameraRun run) {
        CameraSpec spec = run.spec;
        TilePlan plan = run.plan;
        int total = plan.tileCount();
        if (run.tileIndex >= total) {
            return true;
        }
        int col = run.tileIndex % plan.cols() + 1;
        int row = run.tileIndex / plan.cols() + 1;
        try {
            BufferedImage image = renderAndRead(run, col, row);
            run.tiles[row - 1][col - 1] = image;
            run.tileIndex++;
            run.attempts = 0;
        } catch (Throwable t) {
            run.attempts++;
            if (run.attempts >= MAX_ATTEMPTS) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    "机位 " + spec.name() + " 第 " + row + " 行第 " + col + " 列 tile 渲染失败（已重试 " + run.attempts + " 次）: " + t,
                    Json.object(
                        "camera",
                        spec.name(),
                        "tileCol",
                        Integer.valueOf(col),
                        "tileRow",
                        Integer.valueOf(row)));
            }
            warn("机位 " + spec.name() + " tile(" + col + "," + row + ") 渲染失败，重试: " + t);
        }
        report(run, "render");
        return false;
    }

    /**
     * 单 tile 的完整渲染 → 读回 → 落盘（帧内状态在 finally 里必还原）。
     *
     * @return 读回的图像（整 tile 分辨率）
     */
    private BufferedImage renderAndRead(CameraRun run, int col, int row) throws Exception {
        Minecraft mc = in.mc;
        CameraSpec spec = run.spec;
        TilePlan plan = run.plan;
        int bufW = plan.spanX(col);
        int bufH = plan.spanY(row);
        if (!settingsSaved) {
            savedFov = mc.gameSettings.fovSetting;
            savedThirdPerson = mc.gameSettings.thirdPersonView;
            savedHideGui = mc.gameSettings.hideGUI;
            settingsSaved = true;
        }
        // 投影参数：正交机位自己算矩阵，透视机位把 FOV 交给原版管线（再由覆写做像素级偏移）
        if (!spec.isOrtho()) {
            mc.gameSettings.fovSetting = clampFov(spec.fov());
        }
        mc.gameSettings.thirdPersonView = 0;
        // 关掉 HUD 级渲染：renderWorld 末尾的 renderHand → renderItemInFirstPerson 会把<b>手持物</b>
        // 画进每一张取证图（真机实测：TConstruct 手册占满右下角；而它因为自己重建投影/模型视图矩阵，
        // 反而比身后的世界还清楚）。hideGUI 是这条路径上的开关（反编译源 EntityRenderer.java:794 的
        // `!this.mc.gameSettings.hideGUI`），顺带关掉方块选择框（:1325 同一开关）。它是玩家设置，
        // 与 fovSetting/thirdPersonView 一样在 close() 里还原。
        mc.gameSettings.hideGUI = true;
        String renderMode = CameraSpecs.resolveRenderMode(spec, in.capture);
        String lighting = CameraSpecs.resolveLighting(spec, in.capture);
        if (CaptureSpec.RENDER_MODE_LIT.equals(renderMode) || CaptureSpec.LIGHTING_NEUTRAL_FLAT.equals(lighting)) {
            // contract §4.3.6 的「参与光照 / 中性光照」在本版是如实留痕的<b>观测档位</b>：
            // 世界光照管线本身不做替换（v1 未引入光照注入渲染通道），逐图 meta 与
            // observation.runtimeReads 都会标注 lightingApplied=false，避免事后把
            // 「标注了参与光照」误读成「画面真的被打了中性光」。
            warnOnce("lightingApplied=false（v1 不做光照注入，仅留痕 renderMode/lighting 档位）");
        }

        FrameScope scope = new FrameScope();
        try {
            scope.arm(spec, plan, bufW, bufH, col, row, run);
            if (GUI_SCREEN.equals(guiMode())) {
                // 真 GUI 取证（opt-in）：在 renderWorld 之后、读回之前，让<b>游戏自己</b>把
                // currentScreen 画进同一个 framebuffer。不合成、不伪造控件（见 captureScreen 注释）。
                captureScreen(run, bufW, bufH);
            }
            File produced = shoot(bufW, bufH, spec, plan, col, row);
            BufferedImage image = ImageIO.read(produced);
            if (image == null) {
                throw new IOException("读回截图失败（ImageIO 返回 null）: " + produced.getAbsolutePath());
            }
            if (image.getWidth() != bufW || image.getHeight() != bufH) {
                throw new IOException(
                    "读回尺寸与预期不符: " + image.getWidth() + "x" + image.getHeight() + " != " + bufW + "x" + bufH);
            }
            if (plan.tiled()) {
                // 单片由 shoot() 直接落在 <name>.tiles/r<row>c<col>.png，这里只登记（每片像素只存一份，
                // 不再往 shots/ 另写同名中间帧；见类注释「每片像素只存一份」）
                register(rel(produced.toPath()), "shot-tile");
            }
            return image;
        } finally {
            scope.close();
        }
    }

    /**
     * 读整帧 RGBA（当前绑定的读目标，左下原点）；失败返回 {@code null}（探针不改变渲染结果）。
     */
    private static byte[] readFrameRgba(int w, int h) {
        try {
            int width = Math.max(1, w);
            int height = Math.max(1, h);
            ByteBuffer buf = BufferUtils.createByteBuffer(width * height * 4);
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
            GL11.glReadPixels(0, 0, width, height, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buf);
            byte[] out = new byte[width * height * 4];
            buf.get(out);
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 帧指纹（FNV-1a 64 位）。
     *
     * <p>
     * 刻意不用 {@code MessageDigest}：本探针只需要「两次读回是否逐字节相同」这一个判断，
     * 用不依赖 JCA provider 的确定性散列更省事，且失败面更小（加密散列在取证链里的位置见
     * {@code ArtifactStore} 的 sha256，那是产物清单的职责，不是这里的）。
     */
    private static String frameHash(byte[] rgba) {
        if (rgba == null) {
            return "n/a";
        }
        long h = 0xcbf29ce484222325L;
        for (byte b : rgba) {
            h ^= (b & 0xFFL);
            h *= 0x100000001b3L;
        }
        String hex = Long.toHexString(h);
        StringBuilder sb = new StringBuilder();
        for (int i = hex.length(); i < 16; i++) {
            sb.append('0');
        }
        return sb.append(hex)
            .toString();
    }

    /** 两次读回之间有多少像素不同；无法比较（任一为 null 或尺寸不同）返回 -1。 */
    private static int countChangedPixels(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) {
            return -1;
        }
        int n = 0;
        for (int i = 0; i + 3 < a.length; i += 4) {
            if (a[i] != b[i] || a[i + 1] != b[i + 1] || a[i + 2] != b[i + 2] || a[i + 3] != b[i + 3]) {
                n++;
            }
        }
        return n;
    }

    /** 读一个像素（当前绑定读目标；左下原点），返回 {@code #AARRGGBB}；失败返回 {@code n/a}。 */
    private static String readPixelHex(int x, int y) {
        try {
            ByteBuffer pixel = BufferUtils.createByteBuffer(4);
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
            GL11.glReadPixels(x, y, 1, 1, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixel);
            int r = pixel.get(0) & 0xFF;
            int g = pixel.get(1) & 0xFF;
            int b = pixel.get(2) & 0xFF;
            int a = pixel.get(3) & 0xFF;
            int argb = (a << 24) | (r << 16) | (g << 8) | b;
            String hex = Integer.toHexString(argb);
            StringBuilder sb = new StringBuilder("#");
            for (int i = hex.length(); i < 8; i++) {
                sb.append('0');
            }
            return sb.append(hex)
                .toString();
        } catch (Throwable t) {
            return "n/a";
        }
    }

    /** 一个 GL 能力开关的文本（{@code on/off}）。 */
    private static String glBool(int cap) {
        try {
            return GL11.glGetBoolean(cap) ? "on" : "off";
        } catch (Throwable t) {
            return "?";
        }
    }

    /**
     * GL 状态快照：只取与「手工驱动渲染后还能不能把东西画进本 framebuffer」直接相关的那几项。
     *
     * <p>
     * 这组状态是「界面画了但画面里没有」这类事故的分界点：{@code colorMask=0000}、空的
     * {@code scissorBox}、恒失败的模板测试、或绘制期被换掉的 {@code binding}，都会让
     * {@code drawScreen} 正常返回、GL 不报错、而像素一个都不改。
     */
    private static String glStateSnapshot() {
        try {
            int binding = GL11.glGetInteger(GL_FRAMEBUFFER_BINDING);
            IntBuffer vp = BufferUtils.createIntBuffer(4);
            GL11.glGetInteger(GL11.GL_VIEWPORT, vp);
            ByteBuffer mask = BufferUtils.createByteBuffer(4);
            GL11.glGetBoolean(GL11.GL_COLOR_WRITEMASK, mask);
            IntBuffer sbox = BufferUtils.createIntBuffer(4);
            GL11.glGetInteger(GL11.GL_SCISSOR_BOX, sbox);
            // glGetError 会清标志，故放在最后读
            int err = GL11.glGetError();
            return "binding=" + binding
                + " viewport=["
                + vp.get(0)
                + ","
                + vp.get(1)
                + ","
                + vp.get(2)
                + ","
                + vp.get(3)
                + "] colorMask="
                + (mask.get(0) & 1)
                + (mask.get(1) & 1)
                + (mask.get(2) & 1)
                + (mask.get(3) & 1)
                + " scissorTest="
                + glBool(GL11.GL_SCISSOR_TEST)
                + " scissorBox=["
                + sbox.get(0)
                + ","
                + sbox.get(1)
                + ","
                + sbox.get(2)
                + ","
                + sbox.get(3)
                + "] depthTest="
                + glBool(GL11.GL_DEPTH_TEST)
                + " depthMask="
                + glBool(GL11.GL_DEPTH_WRITEMASK)
                + " blend="
                + glBool(GL11.GL_BLEND)
                + " alphaTest="
                + glBool(GL11.GL_ALPHA_TEST)
                + " stencilTest="
                + glBool(GL11.GL_STENCIL_TEST)
                + " cullFace="
                + glBool(GL11.GL_CULL_FACE)
                + " lighting="
                + glBool(GL11.GL_LIGHTING)
                + " tex2d="
                + glBool(GL11.GL_TEXTURE_2D)
                + " glError="
                + err;
        } catch (Throwable t) {
            return "n/a (" + t + ")";
        }
    }

    /**
     * 界面绘制自证：把「让游戏画 {@code currentScreen} 这一步到底有没有改到本帧像素」写进产物与日志。
     *
     * <h2>为什么需要它（#205 事故）</h2>
     * 真机实测出现过这样一组产物：同一个机位、同一时刻，{@code gui:"screen"} 与 {@code gui:"none"}
     * 两次拍摄的 PNG <b>逐字节相同</b>（sha256 一致、53514 字节），而 meta 里 {@code drawn=true}、
     * {@code screen=GuiContainerCreative}、{@code DrawScreenEvent.Pre} 未被 cancel、无异常记录——
     * 也就是说「界面被画了」这句自述在像素层面完全不成立，而全链路判据（尺寸/片数/命名/哈希/无异常）
     * 照样全绿。r4 纯黑事故的教训是「渲染黑与读回黑不可区分」，这里是同一类失效模式的另一面：
     * <b>「调用返回正常」与「像素确实改了」不可区分</b>。
     *
     * <p>
     * 本探针把分界点直接写下来：绘制前/后的<b>整帧指纹</b>与<b>改动像素数</b>、两端的 GL 状态快照
     * （绑定、colorMask、scissor、深度、模板…）、以及未被绑定的<b>窗口 framebuffer</b> 中心像素
     * （用于区分「画去了窗口」与「压根没画进去」）。这些字段进 meta 的 {@code guiCapture[]}，
     * 因此「画面里到底有没有界面」第一次有了可复核的机读证据，而不是只看 {@code drawn} 这一个布尔。
     *
     * <p>
     * 采样不写 GL 状态（只重置一次 {@code GL_PACK_ALIGNMENT}，{@code ScreenShotHelper} 自己也会设），
     * 故不改变渲染结果；失败的探针只记 {@code n/a}，绝不把拍摄判失败。
     */
    private void appendGuiDrawProbe(JsonObject rec, String cameraName, int bufW, int bufH, byte[] frameBefore,
        String stateBefore) {
        try {
            byte[] frameAfter = readFrameRgba(bufW, bufH);
            int total = bufW * bufH;
            int changed = countChangedPixels(frameBefore, frameAfter);
            rec.addProperty("frameHashBefore", frameHash(frameBefore));
            rec.addProperty("frameHashAfter", frameHash(frameAfter));
            rec.addProperty("changedPixels", Integer.valueOf(changed));
            rec.addProperty(
                "changedRatioPct",
                Double.valueOf(changed < 0 || total <= 0 ? -1.0d : (changed * 100.0d) / total));
            rec.addProperty("glStateBefore", stateBefore);
            rec.addProperty("glStateAfter", glStateSnapshot());
            // 「画去哪了」的另一半：窗口 framebuffer 的中心像素。绑 0 → 采样 → 绑回，两侧都在 finally 里复位。
            String windowPixel = "n/a";
            Framebuffer fb = in.mc == null ? null : in.mc.getFramebuffer();
            if (fb != null) {
                try {
                    fb.unbindFramebuffer();
                    windowPixel = readPixelHex(bufW / 2, bufH / 2);
                } finally {
                    fb.bindFramebuffer(false);
                }
            }
            rec.addProperty("windowFramebufferCenterPixel", windowPixel);
            if (!guiDrawProbed) {
                guiDrawProbed = true;
                CpLog.info(
                    "界面绘制自证（一次性，机位 %s）：帧指纹 %s → %s，改动像素 %d/%d（%.4f%%）" + " | 窗口 framebuffer 中心像素=%s | 绘制前：%s | 绘制后：%s",
                    cameraName,
                    frameHash(frameBefore),
                    frameHash(frameAfter),
                    Integer.valueOf(changed),
                    Integer.valueOf(total),
                    Double.valueOf(changed < 0 || total <= 0 ? -1.0d : (changed * 100.0d) / total),
                    windowPixel,
                    stateBefore,
                    glStateSnapshot());
            }
            if (changed == 0) {
                warnOnce(
                    "gui=screen 的界面绘制没有改变本帧任何一个像素（改动像素 0）⇒ 该帧不能作为「画面里有界面」的证据；"
                        + "逐字段自证见 meta 的 guiCapture[]，根因口径见 Gitea #205");
            }
        } catch (Throwable t) {
            CpLog.warn("界面绘制自证探针失败（不影响拍摄）: %s", String.valueOf(t));
        }
    }

    /**
     * 真 GUI 取证：把 {@code mc.currentScreen} 让<b>游戏自己</b>画进当前 framebuffer（opt-in）。
     *
     * <h2>为什么这样写（对齐原版渲染路径）</h2>
     * 原版 {@code EntityRenderer.updateCameraAndRender} 的顺序是
     * {@code renderWorld} → HUD（{@code ingameGUI.renderGameOverlay}）→
     * {@code DrawScreenEvent.Pre} → {@code currentScreen.drawScreen(k, l, partialTicks)} →
     * {@code DrawScreenEvent.Post}（反编译源 {@code EntityRenderer.java:1091-1138}），其中
     * {@code k = Mouse.getX() * scaledWidth / displayWidth}、
     * {@code l = scaledHeight - Mouse.getY() * scaledHeight / displayHeight - 1}（同文件 {@code :1077-1078}）。
     * 本方法<b>逐条照抄</b>那一小段（含两个事件），因为 MUI2 的输入/绘制链挂在
     * {@code DrawScreenEvent.Pre} 上（它自己把事件 cancel 掉再画），少发一个事件就等于绕过它。
     *
     * <p>
     * 明确<b>不做</b>的事：不 {@code displayGuiScreen}、不调 {@code setWorldAndResolution}、
     * 不反射调任何控件的 {@code onMousePressed}/{@code draw}、不合成任何按钮像素。画面里出现的
     * 一定是「游戏在那一刻本来会画的东西」。
     *
     * <h2>为什么按帧缩放临时改写 {@code GuiScreen.width/height}</h2>
     * 分片拍摄会把 framebuffer 覆写成单片尺寸（如 960×540），而界面持有的是窗口尺寸下的
     * {@code width/height}（如 854×480）。原版在窗口变化时靠 {@code Minecraft.resize()} →
     * {@code setWorldAndResolution} 重建界面，但那会调每个控件的 {@code initGui} —— 在取证帧里
     * 重建界面既慢又会改控件状态（属于「替游戏做决定」）。故只把两个<b>尺寸字段</b>临时改成与本帧
     * framebuffer 自洽的值（在 try/finally 里还原），控件自身状态一律不动。
     * 这一处副作用（改两个 public int 字段一帧）写进 {@code guiCaptureJson.notes} 供调用方判读。
     *
     * <h2>为什么不开 HUD</h2>
     * {@code ingameGUI.renderGameOverlay} 是<b>另一个</b>可选面（HUD/聊天/十字准星）。本版只做
     * {@code currentScreen}（真界面），HUD 面留作后续增量：默认路径 {@code hideGUI=true} 保持
     * 既有行为不变，开 HUD 会让「世界本体」之外的像素来源多一条，判据要先想清楚再开。
     */
    private void captureScreen(CameraRun run, int bufW, int bufH) {
        Minecraft mc = in.mc;
        JsonObject rec = new JsonObject();
        rec.addProperty("mode", GUI_SCREEN);
        rec.addProperty("tileBuffer", bufW + "x" + bufH);
        net.minecraft.client.gui.GuiScreen screen = mc.currentScreen;
        if (screen == null) {
            rec.addProperty("screen", (String) null);
            rec.addProperty("drawn", Boolean.FALSE);
            rec.addProperty("note", "拍摄时刻 mc.currentScreen 为 null ⇒ 本帧没有可画的界面（这是如实读数，不是失败）");
            run.guiCaptureJson.add(rec);
            warnOnce("gui=screen 但拍摄时刻 currentScreen 为 null：本帧未画任何界面（shots/*.png 仍是纯世界）");
            return;
        }
        rec.addProperty(
            "screen",
            screen.getClass()
                .getName());
        rec.addProperty("allowUserInput", Boolean.valueOf(screen.allowUserInput));
        int savedWidth = screen.width;
        int savedHeight = screen.height;
        boolean sizeRewritten = false;
        try {
            // 【#205 根因修法】与游戏自身同源：GUI/HUD 的**正交投影**由 setupOverlayRendering() 建立。
            // 游戏在 renderWorld 之后先画 HUD（GuiIngame.renderGameOverlay 开头就调它）、再画界面；
            // 本执行器按设计跳过 HUD（见方法注释「为什么不开 HUD」）⇒ 这一步必须自己补上。
            // 缺它时 drawScreen 发出的几何落在**相机投影**下、整段被视锥裁掉：调用正常返回、
            // GL 状态前后完全一致、glGetError=0、像素零改动——实测 changedPixels=0、帧指纹前后相同
            // （自证探针见 appendGuiDrawProbe；现场数据与根因口径见 Gitea #205）。
            in.mc.entityRenderer.setupOverlayRendering();
            // 界面尺寸吃的是**缩放后**尺寸（ScaledResolution），不是 framebuffer 像素尺寸：
            // 原实现把 buffer 尺寸写进 screen.width/height，与上面同属「把像素尺寸当界面尺寸」的口径错。
            net.minecraft.client.gui.ScaledResolution sr = new net.minecraft.client.gui.ScaledResolution(
                in.mc,
                Math.max(1, bufW),
                Math.max(1, bufH));
            int sw = Math.max(1, sr.getScaledWidth());
            int sh = Math.max(1, sr.getScaledHeight());
            screen.width = sw;
            screen.height = sh;
            sizeRewritten = true;
            // 缩放鼠标坐标：与 EntityRenderer.java:1077-1078 同式。
            // 【实测】Mouse.getX/getY 是 SDL 窗口空间（原点左下）口径——lwjgl3ify 的
            // Mouse.addMoveEvent 里 `latestY = Display.getHeight() - sdlY`，getY() 与 getEventY()
            // 都是这一支；原版那两个式子吃的就是这个口径，故此处<b>照抄</b>而不是自己再折一次。
            int mouseX = readMouseDisplayX();
            int mouseY = readMouseDisplayY();
            int guiMouseX = mouseX < 0 ? 0 : mouseX * sw / Math.max(1, bufW);
            int guiMouseY = mouseY < 0 ? 0 : sh - mouseY * sh / Math.max(1, bufH) - 1;
            JsonObject mouse = new JsonObject();
            mouse.addProperty("displayX", mouseX);
            mouse.addProperty("displayY", mouseY);
            mouse.addProperty("mouseSpace", "sdl-window（Mouse.getX/getY 的实测口径）");
            mouse.addProperty("guiX", guiMouseX);
            mouse.addProperty("guiY", guiMouseY);
            mouse.addProperty("source", "Mouse.getX/getY（渲染帧口径，与 EntityRenderer.java:1077-1078 同源；命中集读的是同一路）");
            rec.add("mouse", mouse);
            rec.addProperty("partialTicks", Double.valueOf(partialTicks()));
            // 界面绘制自证（#205）：绘制前取整帧指纹与 GL 状态，绘制后再取一次并在 meta 里给出改动像素数
            byte[] frameBefore = readFrameRgba(bufW, bufH);
            String stateBefore = glStateSnapshot();
            boolean canceled = false;
            net.minecraftforge.client.event.GuiScreenEvent.DrawScreenEvent.Pre pre = new net.minecraftforge.client.event.GuiScreenEvent.DrawScreenEvent.Pre(
                screen,
                guiMouseX,
                guiMouseY,
                partialTicks());
            // 1.7.10 的 MinecraftForge.EVENT_BUS.post 返回 void（不可用返回值判 cancel）；
            // 与原版 EntityRenderer.java:1136 同一条口径：post 之后读 event.isCanceled()。
            net.minecraftforge.common.MinecraftForge.EVENT_BUS.post(pre);
            canceled = pre.isCanceled();
            if (!canceled) {
                screen.drawScreen(guiMouseX, guiMouseY, partialTicks());
            } else {
                rec.addProperty("drawScreenSkipped", Boolean.TRUE);
                rec.addProperty(
                    "drawScreenSkippedNote",
                    "DrawScreenEvent.Pre 被 cancel（模组 GUI 自绘路径，如 MUI2）⇒ 由该监听者完成本帧绘制");
            }
            net.minecraftforge.common.MinecraftForge.EVENT_BUS.post(
                new net.minecraftforge.client.event.GuiScreenEvent.DrawScreenEvent.Post(
                    screen,
                    guiMouseX,
                    guiMouseY,
                    partialTicks()));
            rec.addProperty("drawn", Boolean.TRUE);
            appendGuiDrawProbe(rec, run.spec.name(), bufW, bufH, frameBefore, stateBefore);
        } catch (Throwable t) {
            rec.addProperty("drawn", Boolean.FALSE);
            rec.addProperty("error", describe(t));
            warnOnce("gui=screen 绘制界面失败（本帧仍是纯世界图）: " + describe(t));
        } finally {
            if (sizeRewritten) {
                screen.width = savedWidth;
                screen.height = savedHeight;
            }
        }
        if (sizeRewritten) {
            rec.addProperty(
                "notes",
                "本帧用 setupOverlayRendering() 建立界面正交投影，并把 screen.width/height 临时改为本片 framebuffer 的**缩放后**尺寸（ScaledResolution 口径）以自洽，已在 finally 还原；"
                    + "控件自身状态未改动");
        }
        run.guiCaptureJson.add(rec);
    }

    /** 解析后的 GUI 取证模式（{@code null} ⇒ 默认 {@link #GUI_NONE}）。 */
    private String guiMode() {
        String v = in.guiCapture;
        return v == null || v.isEmpty() ? GUI_NONE : v;
    }

    /** 实读 {@code Mouse.getX()}；读不到返回 -1（调用方据此落 0 并在留痕里说明）。 */
    private static int readMouseDisplayX() {
        return readMouseAxis("getX");
    }

    /** 实读 {@code Mouse.getY()}。 */
    private static int readMouseDisplayY() {
        return readMouseAxis("getY");
    }

    /**
     * 反射读一个 {@code Mouse} 轴。
     *
     * <p>
     * 走反射而非静态引用：lwjgl3ify 的 {@code -api} 制品不含 {@code org.lwjglx.**}，而
     * {@code Class.forName} 的字符串字面量不被 RFB 重映射（契约 §1.2 的编译可见性讨论）。
     */
    private static int readMouseAxis(String method) {
        for (String cn : new String[] { "org.lwjglx.input.Mouse", "org.lwjgl.input.Mouse" }) {
            try {
                Class<?> c = Class.forName(cn, false, ShotExecutor.class.getClassLoader());
                Object v = c.getMethod(method)
                    .invoke(null);
                if (v instanceof Number) {
                    return ((Number) v).intValue();
                }
            } catch (Throwable t) {
                // 试下一个候选
            }
        }
        return -1;
    }

    /**
     * 按快门：落 PNG（校验文件存在且非空），返回产物文件。
     *
     * <p>
     * 落点：拼接机位 = {@code shots/<name>.tiles/r<row>c<col>.png}（与 tile 网格逐片对应），
     * 非拼接机位 = {@code shots/<name>.png}（随后由 {@link #finishCamera} 覆盖为拼接/整图产物，
     * 两者像素相同）。之所以要经 helper 自己的目录中转一步，见类注释「ScreenShotHelper 的三个已知坑」。
     */
    private File shoot(int bufW, int bufH, CameraSpec spec, TilePlan plan, int col, int row) throws Exception {
        Minecraft mc = in.mc;
        Path targetPath = plan.tiled() ? tilesDir(spec.name()).resolve(tileName(col, row))
            : shotsDir().resolve(spec.name() + ".png");
        Files.createDirectories(targetPath.getParent());
        String stagingName = stagingName(spec, col, row);
        // helper 的实际落点（<mcDataDir>/screenshots/）与「直接写产物目录」的兜底落点：两处都清残留
        File helperFile = new File(screenshotsDirOfHelper(mc), stagingName);
        File fallbackFile = shotsDir().resolve(stagingName)
            .toFile();
        clearStale(helperFile);
        clearStale(fallbackFile);
        // 坑 1：第一参是游戏目录（helper 自己拼 screenshots/），第二参才是文件名
        ScreenShotHelper.saveScreenshot(mc.mcDataDir, stagingName, bufW, bufH, mc.getFramebuffer());
        // 坑 2：失败也返回非 null ⇒ 判据只能是「文件存在且 size > 0」
        File staged = isUsable(helperFile) ? helperFile : isUsable(fallbackFile) ? fallbackFile : null;
        if (staged == null) {
            throw new IOException(
                "截图调用返回了但文件不存在或为空: " + helperFile.getAbsolutePath() + " / " + fallbackFile.getAbsolutePath());
        }
        File target = targetPath.toFile();
        // 坑 3：同名旧文件先改名标记（不删除）
        if (target.exists()) {
            File trash = new File(target.getParentFile(), target.getName() + ".trash-" + System.currentTimeMillis());
            Files.move(target.toPath(), trash.toPath(), StandardCopyOption.REPLACE_EXISTING);
            CpLog.info("同名旧图已标记（不删除）: %s → %s", target.getName(), trash.getName());
        }
        Files.move(staged.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        if (!isUsable(target)) {
            throw new IOException("截图落盘后校验失败: " + target.getAbsolutePath());
        }
        return target;
    }

    /**
     * 中转临时截图名（{@code <name>-r<row>c<col>.partial.png}）。
     *
     * <p>
     * 固定用「机位名 + 行列 + .partial」，既不与最终产物（{@code <name>.png} / {@code tiles/r<row>c<col>.png}）
     * 同名，也不与 {@link #finishCamera} 拼图用的 {@code <name>.partial.png} 撞名。
     */
    private static String stagingName(CameraSpec spec, int col, int row) {
        return spec.name() + "-r" + row + "c" + col + STAGING_SUFFIX + ".png";
    }

    /** {@code ScreenShotHelper} 实际写文件的目录：{@code <mcDataDir>/screenshots}。 */
    private static File screenshotsDirOfHelper(Minecraft mc) {
        File base = mc == null || mc.mcDataDir == null ? new File(".") : mc.mcDataDir;
        return new File(base, "screenshots");
    }

    /** 临时截图残留清理（上次异常退出可能留下同名临时件）。 */
    private static void clearStale(File f) throws IOException {
        if (f.exists() && !f.delete() && f.exists()) {
            throw new IOException("临时截图删除失败: " + f.getAbsolutePath());
        }
    }

    /** 文件存在且非空——{@code ScreenShotHelper} 的唯一可用判据（见类注释坑 2）。 */
    private static boolean isUsable(File f) {
        return f != null && f.isFile() && f.length() > 0L;
    }

    /** 一个 tile 的覆写作用域（enter/exit 成对，异常路径也必还原）。 */
    private final class FrameScope {

        private boolean armed;

        /** 隐藏前的玩家可见性（null = 本帧没动过，close 不还原）。 */
        private Boolean savedPlayerInvisible;

        private void arm(CameraSpec spec, TilePlan plan, int bufW, int bufH, int col, int row, CameraRun run)
            throws Exception {
            Minecraft mc = in.mc;
            // framebuffer 尺寸覆写：先按目标尺寸建 FBO，再把 displayWidth/Height 指向同一尺寸。
            // 尺寸没变时不重建（同机位相邻 tile 尺寸一致；重建一次要重新分配纹理与深度缓冲）。
            FramebufferOverride.begin(bufW, bufH);
            if (lastBufferW != bufW || lastBufferH != bufH) {
                lastBufferW = bufW;
                lastBufferH = bufH;
                mc.displayWidth = bufW;
                mc.displayHeight = bufH;
                mc.getFramebuffer()
                    .createBindFramebuffer(bufW, bufH);
            }
            Framebuffer framebuffer = mc.getFramebuffer();
            framebuffer.bindFramebuffer(true);
            framebuffer.framebufferClear();
            // 必须重新绑定：framebufferClear() 的末尾是 unbindFramebuffer()（反编译源
            // Framebuffer.java:278），它把渲染目标踢回<b>默认 framebuffer（窗口）</b>。少了这一次
            // 绑定，整帧就画进窗口，而读回读的是 framebufferMc 的纹理——那张纹理自创建起只被
            // framebufferColor（Minecraft.java:510 设为全 0 黑）清过 ⇒ 截图/单片像素恒为纯黑，
            // 且 GL 不报错、渲染不留痕（r4 事故根因，见类注释「为什么每片都必须重新绑定」）。
            framebuffer.bindFramebuffer(true);
            double farPlane = Math.max(256.0d, mc.gameSettings.renderDistanceChunks * 16.0d * 2.0d);
            // 投影覆写只接收「本机位的 TilePlan + 本片格位 + 本片 framebuffer 尺寸」：
            // 网格与真实窗口尺寸的关系早在 CameraRun 构造时（onBegin 的真实窗口）就结算完了，
            // 这里不再传窗口尺寸，投影侧也就没有任何「自己再算一遍网格」的输入（r3 事故修法）。
            ProjectionOverride.arm(
                spec.isOrtho() ? ProjectionOverride.TYPE_ORTHO : ProjectionOverride.TYPE_PERSPECTIVE,
                spec.fov(),
                spec.orthoHeight(),
                bufW,
                bufH,
                plan,
                col,
                row,
                farPlane);
            // 网格自检：执行器的分片计划必须与投影覆写解出的有效网格一致，否则会出现
            // 「每片都对、拼起来错」的静默错图（比渲染失败更难查），故当场判失败。
            // 修法后两边同源（都是 plan 这一个实例），本检查退化为防御性断言：它挡的是
            // 「将来有人在某一侧重算网格」这类回归，故保留。
            if (!plan.matches(ProjectionOverride.effectiveTileCols(), ProjectionOverride.effectiveTileRows())) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    "tile 网格自检失败：执行器 " + plan.describe()
                        + " vs 投影覆写 "
                        + ProjectionOverride.effectiveTileCols()
                        + "x"
                        + ProjectionOverride.effectiveTileRows()
                        + "（分辨率与窗口像素比不自洽）",
                    Json.object(
                        "camera",
                        spec.name(),
                        "requestedCols",
                        Integer.valueOf(spec.tileCols()),
                        "requestedRows",
                        Integer.valueOf(spec.tileRows()),
                        "buffer",
                        bufW + "x" + bufH,
                        "base",
                        baseWidth + "x" + baseHeight));
            }
            // 投影参数快照要在覆写态内取（finishCamera 跑在作用域关闭之后，那时已是 none）
            run.projectionApplied = ProjectionOverride.describe();
            savedRenderViewEntity = mc.renderViewEntity;
            mc.renderViewEntity = camera;
            armed = true;
            // 隐藏真实玩家（只动客户端显示标志）：renderEntities 只跳过 renderViewEntity 自己，
            // 不隐藏就会把稳定化在场景旁的玩家模型拍进每个机位（见类注释「拍摄帧内隐藏玩家」）
            run.playerHidden |= hidePlayer(mc);
            EntityRenderer renderer = mc.entityRenderer;
            renderer.renderWorld(partialTicks(), System.nanoTime());
            // 渲染后核验：相机没有被渲染路径内的其它逻辑改回玩家
            if (mc.renderViewEntity != camera) {
                cameraHeldDuringRender = false;
                warnOnce(
                    "渲染期间 renderViewEntity 被改为 " + (mc.renderViewEntity == null ? "<null>"
                        : mc.renderViewEntity.getClass()
                            .getName())
                        + "（机位可能没生效，请核对 shots/<name>.png）");
            }
            // 渲染目标自证（每次拍摄只输出一次，见 probeRenderTarget）：
            // 「这一帧画进了哪个 framebuffer」与「读回的那份中心像素是什么」当场落日志——
            // r4 事故里这两个问题都没有任何留痕，只能靠事后体量（PNG 2759 字节）反推。
            if (!renderTargetProbed) {
                renderTargetProbed = true;
                probeRenderTarget(framebuffer, bufW, bufH, spec, col, row);
            }
        }

        /**
         * 渲染目标自证：把「帧画进了哪个 framebuffer / 读回那份是不是全黑」落成一条一次性日志。
         *
         * <h2>为什么需要它（r4 事故）</h2>
         * 截图纯黑时，「渲染黑」与「读回黑」在结果上完全一样（都是 PNG 全 0），而全链路判据
         * （尺寸/片数/命名/相机注入/无异常）可以<b>全绿</b>——r4 就是这样：3 机位绿灯、PNG 全黑。
         * 本探针把两者的分界点直接写下来：
         * <ol>
         * <li>{@code glGetInteger(GL_FRAMEBUFFER_BINDING)}：帧结束时绑定的 framebuffer 名。
         * 与 {@code framebufferMc.framebufferObject} 不等 ⇒ 帧画去了别处（窗口），读回必然不是它；</li>
         * <li>{@code glGetInteger(GL_VIEWPORT)}：证实视口覆写（{@code MixinMinecraftResolution} 的
         * {@code glViewport} 重定向 + {@code FramebufferOverride}）确实生效；</li>
         * <li>采样「当前绑定」与「framebufferMc 纹理」两个 framebuffer 的中心像素：
         * 前者有内容、后者全 0 = 渲染没进 FBO（读回黑）；两者都全 0 = 渲染本身是黑的；</li>
         * <li>{@code glGetError}：GL 错误码（framebufferClear 丢绑定时为 0——这条路径静默）。</li>
         * </ol>
         *
         * <p>
         * 只在采样到结构性缺陷（绑定名不符）时告警；像素全黑只记录不告警——「画面该不该有内容」
         * 是<b>用例判据</b>（{@code image-not-uniform}）的职责，渲染层对空场景（虚空世界、夜里、
         * 镜头埋进方块）无权判红。采样改不动渲染结果：读回不写 GL 状态，只重置一次
         * {@code GL_PACK_ALIGNMENT}（{@code ScreenShotHelper} 自己也会设）。
         */
        private void probeRenderTarget(Framebuffer framebuffer, int bufW, int bufH, CameraSpec spec, int col, int row) {
            try {
                int binding = GL11.glGetInteger(GL_FRAMEBUFFER_BINDING);
                int glError = GL11.glGetError();
                IntBuffer viewport = BufferUtils.createIntBuffer(4);
                GL11.glGetInteger(GL11.GL_VIEWPORT, viewport);
                int cx = Math.max(0, Math.min(bufW, framebuffer.framebufferTextureWidth) / 2 - 1);
                int cy = Math.max(0, Math.min(bufH, framebuffer.framebufferTextureHeight) / 2 - 1);
                int here = samplePixel(cx, cy);
                framebuffer.bindFramebuffer(false);
                int inFbo = samplePixel(cx, cy);
                CpLog.info(
                    "渲染目标自证（一次性，机位 %s tile %d,%d）：GL_FRAMEBUFFER_BINDING=%d framebufferObject=%d viewport=[%d,%d,%d,%d] glGetError=%d"
                        + " | 渲染后当前写目标中心像素=%s | framebufferMc 纹理中心像素=%s",
                    spec.name(),
                    Integer.valueOf(col),
                    Integer.valueOf(row),
                    Integer.valueOf(binding),
                    Integer.valueOf(framebuffer.framebufferObject),
                    Integer.valueOf(viewport.get(0)),
                    Integer.valueOf(viewport.get(1)),
                    Integer.valueOf(viewport.get(2)),
                    Integer.valueOf(viewport.get(3)),
                    Integer.valueOf(glError),
                    hexPixel(here),
                    hexPixel(inFbo));
                if (binding != framebuffer.framebufferObject) {
                    warnOnce(
                        "渲染目标自证失败：帧结束时绑定的是 framebuffer " + binding
                            + "，不是 framebufferMc("
                            + framebuffer.framebufferObject
                            + ")——这一帧画进了别处，读回的纹理不会有本帧内容（r4 纯黑事故的口径）");
                }
            } catch (Throwable t) {
                CpLog.warn("渲染目标自证探针失败（不影响拍摄）: %s", String.valueOf(t));
            }
        }

        /** 读一个像素（{@code x,y} 为 framebuffer 坐标，左下原点），返回 {@code ARGB}；失败返回 0。 */
        private int samplePixel(int x, int y) {
            try {
                ByteBuffer pixel = BufferUtils.createByteBuffer(4);
                GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
                GL11.glReadPixels(x, y, 1, 1, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixel);
                int r = pixel.get(0) & 0xFF;
                int g = pixel.get(1) & 0xFF;
                int b = pixel.get(2) & 0xFF;
                int a = pixel.get(3) & 0xFF;
                return (a << 24) | (r << 16) | (g << 8) | b;
            } catch (Throwable t) {
                return 0;
            }
        }

        /** 像素的十六进制文本（{@code #AARRGGBB}，日志用）。 */
        private String hexPixel(int argb) {
            String hex = Integer.toHexString(argb);
            StringBuilder sb = new StringBuilder("#");
            for (int i = hex.length(); i < 8; i++) {
                sb.append('0');
            }
            return sb.append(hex)
                .toString();
        }

        /**
         * 隐藏真实玩家（只动客户端实体 dataWatcher 的显示标志，不碰服务端实体/世界状态）。
         *
         * @return 是否确实处于「玩家不可见」状态（玩家本来就隐形也算）
         */
        private boolean hidePlayer(Minecraft mc) {
            if (mc.thePlayer == null) {
                warnOnce("世界中没有玩家实体，无法在拍摄帧里隐藏玩家模型");
                return false;
            }
            savedPlayerInvisible = Boolean.valueOf(mc.thePlayer.isInvisible());
            mc.thePlayer.setInvisible(true);
            return true;
        }

        /** 还原玩家可见性（先于其它渲染态还原：这是最容易被用户直接看到的副作用）。 */
        private void restorePlayerVisibility(Minecraft mc) {
            if (savedPlayerInvisible != null && mc.thePlayer != null) {
                mc.thePlayer.setInvisible(savedPlayerInvisible.booleanValue());
            }
            savedPlayerInvisible = null;
        }

        private void close() {
            Minecraft mc = in.mc;
            try {
                restorePlayerVisibility(mc);
                ProjectionOverride.disarm();
                FramebufferOverride.end();
                if (armed && savedRenderViewEntity instanceof net.minecraft.entity.EntityLivingBase) {
                    mc.renderViewEntity = (net.minecraft.entity.EntityLivingBase) savedRenderViewEntity;
                } else if (armed) {
                    mc.renderViewEntity = mc.thePlayer;
                }
                if (mc.displayWidth != baseWidth || mc.displayHeight != baseHeight) {
                    mc.displayWidth = baseWidth;
                    mc.displayHeight = baseHeight;
                    mc.getFramebuffer()
                        .createBindFramebuffer(baseWidth, baseHeight);
                }
                // 真实尺寸已还原：清掉「已知 framebuffer 尺寸」缓存，下次覆写必然重建
                lastBufferW = 0;
                lastBufferH = 0;
                if (settingsSaved) {
                    mc.gameSettings.fovSetting = savedFov;
                    mc.gameSettings.thirdPersonView = savedThirdPerson;
                    mc.gameSettings.hideGUI = savedHideGui;
                }
            } catch (Throwable t) {
                CpLog.error(t, "还原渲染状态失败（已尽力还原 displayWidth/投影/renderViewEntity/玩家可见性）");
            } finally {
                armed = false;
                savedRenderViewEntity = null;
                savedPlayerInvisible = null;
            }
        }
    }

    /** 单个机位收尾：拼接（如需要）+ 写 meta + 登记产物。 */
    private void finishCamera(CameraRun run) {
        CameraSpec spec = run.spec;
        TilePlan plan = run.plan;
        JsonObject r = run.result;
        r.addProperty("name", spec.name());
        r.add("spec", spec.toJson());
        r.addProperty("renderMode", CameraSpecs.resolveRenderMode(spec, in.capture));
        r.addProperty("lighting", CameraSpecs.resolveLighting(spec, in.capture));
        r.addProperty("lightingApplied", Boolean.FALSE);
        r.addProperty("playerHidden", Boolean.valueOf(run.playerHidden));
        // 第一人称手持物/选择框在本帧被 hideGUI 挡掉（见 renderAndRead）：画面里不该有第一人称持物，
        // 否则「本色」取证图会被道具模型占掉一角。注意这是**另一条**路径：第三人称玩家模型手里的东西
        // 由 MixinRendererLivingEntityShot 取消整段 doRender 来解决（见类注释「拍摄帧内隐藏玩家」）。
        //
        // gui=screen（opt-in 的真 GUI 取证）时 HUD 级渲染仍被挡掉，但 currentScreen 自己会画进本帧
        // （见 captureScreen）⇒ 该字段的语义从「画面里没有 GUI」收窄成「画面里没有 HUD」，
        // 故如实写 false，并用 guiCapture 逐片给出实际画了什么。
        r.addProperty("guiHidden", Boolean.valueOf(!run.guiCaptureRequested));
        r.addProperty("worldTime", in.mc.theWorld == null ? -1L : in.mc.theWorld.getWorldTime());
        if (run.guiCaptureRequested && run.guiCaptureJson.size() > 0) {
            r.add("guiCapture", Json.copyArray(run.guiCaptureJson));
        }
        r.addProperty("tile", Boolean.valueOf(plan.tiled()));
        r.addProperty("tileCols", plan.cols());
        r.addProperty("tileRows", plan.rows());
        r.addProperty("requestedTileCols", spec.tileCols());
        r.addProperty("requestedTileRows", spec.tileRows());
        r.addProperty("tileOverlap", Double.valueOf(spec.tileOverlap()));
        try {
            BufferedImage composed = plan.tiled() ? compose(spec, run) : run.tiles[0][0];
            if (composed == null) {
                throw new IOException("没有可拼接的 tile 图像");
            }
            Path png = shotsDir().resolve(spec.name() + ".png");
            Path tmp = shotsDir().resolve(spec.name() + STAGING_SUFFIX + ".png");
            ImageIO.write(composed, "png", tmp.toFile());
            Files.move(tmp, png, StandardCopyOption.REPLACE_EXISTING);
            if (!Files.isRegularFile(png) || Files.size(png) <= 0L) {
                throw new IOException("拼接产物为空: " + png);
            }
            r.addProperty("file", rel(png));
            r.addProperty("width", composed.getWidth());
            r.addProperty("height", composed.getHeight());
            r.addProperty("bytes", Long.valueOf(Files.size(png)));
            r.addProperty("ok", Boolean.TRUE);
            register(rel(png), "shot");
            if (plan.tiled()) {
                r.addProperty("tilesDir", rel(tilesDir(spec.name())));
            }
            // meta 写盘（schema lightning.shot-meta/1）
            JsonObject meta = new JsonObject();
            meta.addProperty("schema", SHOT_META_SCHEMA);
            meta.addProperty("runId", in.run == null ? null : in.run.runId());
            meta.addProperty("camera", spec.name());
            meta.add("spec", spec.toJson());
            // 口径声明：yOffset=1.62 之后声明 pos 就是实际视点（推导见 VirtualCamera 类注释）；
            // 原版第一人称相机固有的 0.1 格常量不随声明变化，故不进这个字段
            meta.add("effectiveEyePos", vec3(spec.pos()));
            meta.addProperty("playerHidden", Boolean.valueOf(run.playerHidden));
            meta.addProperty("guiHidden", Boolean.valueOf(!run.guiCaptureRequested));
            if (run.guiCaptureRequested && run.guiCaptureJson.size() > 0) {
                // 真 GUI 取证的逐片读数（消费链 + 缩放 + 鼠标回读）；默认路径下本键不出现，
                // 故既有 shot-meta 的形状在 gui=none 时逐字节不变（见类注释「GUI 取证的默认行为」）。
                meta.add("guiCapture", Json.copyArray(run.guiCaptureJson));
            }
            meta.addProperty("renderMode", Json.optString(r, "renderMode", null));
            meta.addProperty("lighting", Json.optString(r, "lighting", null));
            meta.addProperty("lightingApplied", Boolean.FALSE);
            meta.addProperty("worldTime", Json.optLong(r, "worldTime", -1L));
            meta.add("resolution", resolutionJson(composed.getWidth(), composed.getHeight()));
            meta.add("requestedResolution", resolutionJson(spec.width(), spec.height()));
            meta.add("renderBufferResolution", resolutionJson(plan.pieceWidth(), plan.pieceHeight()));
            meta.addProperty("projection", spec.projection());
            // 投影实际生效的参数快照：必须在覆写态内取（见 CameraRun#projectionApplied）。
            // 这里若现场去问 ProjectionOverride，作用域早已关闭，只会得到 none。
            meta.addProperty("projectionApplied", run.projectionApplied);
            meta.addProperty("cameraHeldDuringRender", Boolean.valueOf(cameraHeldDuringRender));
            JsonObject tile = new JsonObject();
            tile.addProperty("cols", plan.cols());
            tile.addProperty("rows", plan.rows());
            tile.addProperty("requestedCols", spec.tileCols());
            tile.addProperty("requestedRows", spec.tileRows());
            tile.addProperty("overlap", Double.valueOf(spec.tileOverlap()));
            tile.addProperty("method", "projection-offset");
            tile.addProperty("perTile", Boolean.valueOf(plan.tiled()));
            meta.add("tile", tile);
            meta.add("baseDisplay", resolutionJson(baseWidth, baseHeight));
            meta.addProperty(
                "generatedAt",
                TimeSource.system()
                    .isoNow());
            meta.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - startedAtMs));
            Path metaPath = shotsDir().resolve(spec.name() + ".meta.json");
            Files.write(
                metaPath,
                Json.toPretty(meta)
                    .getBytes(StandardCharsets.UTF_8));
            r.addProperty("metaFile", rel(metaPath));
            register(rel(metaPath), "shot-meta");
            CpLog.info(
                "机位 %s 完成：%s（%dx%d，%s 字节，tile=%s）",
                spec.name(),
                Json.optString(r, "file", "?"),
                Integer.valueOf(composed.getWidth()),
                Integer.valueOf(composed.getHeight()),
                Json.optString(r, "bytes", "0"),
                plan.tiled() ? plan.describe() : "no");
        } catch (Throwable t) {
            r.addProperty("ok", Boolean.FALSE);
            r.addProperty("error", describe(t));
            warn("机位 " + spec.name() + " 落盘/拼接失败: " + describe(t));
            CpLog.error(t, "机位 %s 落盘失败", spec.name());
        }
        cameraResults.add(r);
    }

    /** 收尾：还原 gameSettings 与显示尺寸。 */
    private void cleanup() {
        Minecraft mc = in.mc;
        try {
            if (settingsSaved && mc != null && mc.gameSettings != null) {
                mc.gameSettings.fovSetting = savedFov;
                mc.gameSettings.thirdPersonView = savedThirdPerson;
                mc.gameSettings.hideGUI = savedHideGui;
            }
            if (mc != null && (mc.displayWidth != baseWidth || mc.displayHeight != baseHeight)) {
                mc.displayWidth = baseWidth;
                mc.displayHeight = baseHeight;
                mc.getFramebuffer()
                    .createBindFramebuffer(baseWidth, baseHeight);
            }
            lastBufferW = 0;
            lastBufferH = 0;
            FramebufferOverride.end();
            ProjectionOverride.disarm();
        } catch (Throwable t) {
            CpLog.warn("拍摄收尾还原失败: %s", String.valueOf(t));
        }
    }

    /** 收尾兜底（动作异常退出时由调用方调用）。 */
    public void abort() {
        try {
            cleanup();
        } catch (Throwable t) {
            CpLog.warn("拍摄中断收尾失败: %s", String.valueOf(t));
        } finally {
            FramebufferOverride.emergencyRestore();
        }
    }

    // ------------------------------------------------------------ 拼接

    /**
     * 投影偏移 tiling 的像素级拼接。
     *
     * <p>
     * <b>为什么这里没有裁 overlap 边</b>：投影偏移法把每个 tile 的投影像素级地缩放到「整图里它那一格」
     * （{@link ProjectionOverride} 的推导），因此 {@code cols×rows} 个 tile 的输出像素<b>恰好</b>把整图
     * 分割完，相邻 tile 没有共享像素——裁边反而会丢掉本应存在的像素。契约允许的 overlap 在偏移法下
     * <b>不参与像素装配</b>，只影响「接缝余量」的期望；因此本方法把每个 tile 的整幅栅格按其格位贴入，
     * 并校验尺寸严格等于格位尺寸（不等即视为渲染故障，失败而不是静默产出错图）。
     *
     * <p>
     * 接缝正确性由 {@link ShotExecutor} 逐 tile 落盘的 {@code <name>.tiles/} 帧保留：事后可单独核对
     * 相邻帧的边缘像素是否连续——这比「拼完看起来没缝」更可审计。
     */
    private BufferedImage compose(CameraSpec spec, CameraRun run) throws IOException {
        int w = spec.width();
        int h = spec.height();
        TilePlan plan = run.plan;
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        // TilePlan 的格位一律 1 起（与投影覆写同口径），这里循环变量 0 起，故 +1 使用
        for (int row = 0; row < plan.rows(); row++) {
            int spanH = plan.spanY(row + 1);
            for (int col = 0; col < plan.cols(); col++) {
                int spanW = plan.spanX(col + 1);
                BufferedImage tile = run.tiles[row][col];
                if (tile == null) {
                    throw new IOException("tile(" + (col + 1) + "," + (row + 1) + ") 缺失，无法拼接");
                }
                if (tile.getWidth() != spanW || tile.getHeight() != spanH) {
                    throw new IOException(
                        "tile(" + (col + 1)
                            + ","
                            + (row + 1)
                            + ") 尺寸与格位不符: "
                            + tile.getWidth()
                            + "x"
                            + tile.getHeight()
                            + " != "
                            + spanW
                            + "x"
                            + spanH
                            + "（投影偏移法下 overlap 不参与像素装配，尺寸必须严格相等）");
                }
                paste(out, tile, plan.offsetX(col + 1), plan.offsetY(row + 1));
            }
        }
        return out;
    }

    private static void paste(BufferedImage dest, BufferedImage src, int x, int y) {
        int w = Math.min(src.getWidth(), dest.getWidth() - x);
        int h = Math.min(src.getHeight(), dest.getHeight() - y);
        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) {
                dest.setRGB(x + i, y + j, src.getRGB(i, j));
            }
        }
    }

    // ------------------------------------------------------------ 结果

    private JsonObject result() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SHOT_META_SCHEMA);
        o.addProperty("action", in.action);
        o.addProperty("runId", in.run == null ? null : in.run.runId());
        o.addProperty("cameraCount", runs.size());
        int ok = 0;
        for (int i = 0; i < cameraResults.size(); i++) {
            if (Json.optBool(
                cameraResults.get(i)
                    .getAsJsonObject(),
                "ok",
                false)) {
                ok++;
            }
        }
        o.addProperty("shotCount", ok);
        o.addProperty("failedCount", runs.size() - ok);
        o.add("cameras", Json.copyArray(cameraResults));
        if (in.target != null) {
            o.add("target", Json.copyArray(in.target));
        }
        if (in.capture != null) {
            o.add("capture", in.capture.toJson());
        }
        o.addProperty("baseDisplayWidth", baseWidth);
        o.addProperty("baseDisplayHeight", baseHeight);
        o.addProperty("guiCapture", guiMode());
        o.addProperty("settingsRestored", Boolean.valueOf(settingsSaved));
        o.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - startedAtMs));
        if (warnings.size() > 0) {
            o.add("warnings", Json.copyArray(warnings));
        }
        return o;
    }

    /** 逐机位进度（按机位粒度，节流交给调用方）。 */
    private void report(CameraRun run, String phase) {
        if (in.progress == null) {
            return;
        }
        int total = Math.max(1, runs.size());
        double per = 1.0d / total;
        double within = "warmup".equals(phase) ? 0.3d : "render".equals(phase) ? 0.7d : 0.9d;
        try {
            in.progress.onProgress(index * per + per * within, run.spec.name() + " " + phase);
        } catch (Throwable t) {
            CpLog.warn("进度上报失败: %s", String.valueOf(t));
        }
    }

    // ------------------------------------------------------------ 工具

    private void warn(String message) {
        Json.add(warnings, message);
        CpLog.warn("%s", message);
    }

    private void warnOnce(String message) {
        for (int i = 0; i < warnings.size(); i++) {
            if (message.equals(
                warnings.get(i)
                    .getAsString())) {
                return;
            }
        }
        warn(message);
    }

    /** 产物根目录内的 shots/。 */
    private Path shotsDir() {
        if (in.run == null) {
            throw new CpException(ErrorCodes.STATE, "未关联 run 目录，无法落截图产物");
        }
        return in.run.dir()
            .resolve(SHOTS_DIR);
    }

    private Path tilesDir(String name) {
        return shotsDir().resolve(name + ".tiles");
    }

    private void ensureRunShotsDir() {
        try {
            Files.createDirectories(shotsDir());
        } catch (IOException e) {
            throw CpException.io("创建截图目录失败: " + shotsDir(), e);
        }
    }

    private void register(String relPath, String role) {
        if (in.artifacts == null || in.run == null) {
            return;
        }
        try {
            in.artifacts.registerArtifact(in.run, relPath, role);
        } catch (CpException e) {
            warn("登记产物失败 " + relPath + ": " + e.detail());
        }
    }

    private String rel(Path p) {
        return in.run.dir()
            .relativize(p)
            .toString()
            .replace('\\', '/');
    }

    private static String tileName(int col, int row) {
        return "r" + row + "c" + col + ".png";
    }

    private static JsonArray resolutionJson(int w, int h) {
        JsonArray a = new JsonArray();
        Json.add(a, Integer.valueOf(w));
        Json.add(a, Integer.valueOf(h));
        return a;
    }

    /** {@code [x,y,z]}（meta 的 {@code effectiveEyePos} 用，与 {@code spec.pos} 同形）。 */
    private static JsonArray vec3(double[] v) {
        JsonArray a = new JsonArray();
        Json.add(a, Double.valueOf(v[0]));
        Json.add(a, Double.valueOf(v[1]));
        Json.add(a, Double.valueOf(v[2]));
        return a;
    }

    private static int clampY(double y) {
        int v = (int) Math.floor(y);
        return v < 0 ? 0 : (v > 255 ? 255 : v);
    }

    private static float clampFov(double fov) {
        double v = Math.max(CameraSpec.MIN_FOV, Math.min(CameraSpec.MAX_FOV, fov));
        return (float) v;
    }

    /**
     * 渲染插值系数（区块/TESR 的插值口径与原版帧一致）。
     *
     * <p>
     * {@code Minecraft.timer} 是私有字段且 1.7.10 没有公开 getter，故走反射取
     * {@code renderPartialTicks}；取不到时退回 1.0（整帧，最不容易看出插值抖动）。
     * 反射句柄缓存在静态字段里——这里每 tile 都要调一次，不能每次查找。
     */
    private static float partialTicks() {
        try {
            if (TIMER == null) {
                return 1.0F;
            }
            Object timer = TIMER.get(Minecraft.getMinecraft());
            if (timer == null) {
                return 1.0F;
            }
            java.lang.reflect.Field pt = PARTIAL_TICKS;
            if (pt == null) {
                pt = timer.getClass()
                    .getField("renderPartialTicks");
                PARTIAL_TICKS = pt;
            }
            return pt.getFloat(timer);
        } catch (Throwable t) {
            return 1.0F;
        }
    }

    /** {@code Minecraft.timer} 反射句柄（静态缓存）。 */
    private static final java.lang.reflect.Field TIMER;

    /** {@code Timer.renderPartialTicks} 反射句柄（静态缓存）。 */
    private static java.lang.reflect.Field PARTIAL_TICKS;

    static {
        java.lang.reflect.Field timer = null;
        try {
            timer = Minecraft.class.getDeclaredField("timer");
            timer.setAccessible(true);
        } catch (Throwable t) {
            timer = null;
        }
        TIMER = timer;
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "<null>";
        }
        StringBuilder sb = new StringBuilder(
            t.getClass()
                .getName());
        if (t.getMessage() != null) {
            sb.append(": ")
                .append(t.getMessage());
        }
        StackTraceElement[] st = t.getStackTrace();
        if (st != null && st.length > 0) {
            sb.append(" @ ")
                .append(st[0].toString());
        }
        return sb.toString();
    }

    /** 产物文件名冲突与「半成品」标记的后缀。 */
    private static final String STAGING_SUFFIX = ".partial";

    /** 供调用方拼 run 内相对路径（{@code shots/<name>.png}）。 */
    public static String shotRelPath(String name) {
        return SHOTS_DIR + "/" + name + ".png";
    }

    /** 见 {@link #shotRelPath}。 */
    public static String metaRelPath(String name) {
        return SHOTS_DIR + "/" + name + ".meta.json";
    }

    /** 见 {@link #shotRelPath}。 */
    public static String tilesRelDir(String name) {
        return SHOTS_DIR + "/" + name + ".tiles";
    }

    /** 契约版本（结果留痕）。 */
    public static String contractVersion() {
        return Contract.VERSION;
    }

    /**
     * 校验并归一化 {@code gui} 参数（唯一的取值域判定点；越域即 {@code CP-VALID-002}）。
     *
     * <p>
     * 缺省（{@code null} / {@link com.google.gson.JsonNull} / 空串）归一成 {@link #GUI_NONE}。
     * 不适用/未知取值一律显式拒绝——「静默忽略不适用字段」是本仓已定的失效模式。
     *
     * <h2>为什么必须显式处理 {@link JsonElement}（实机缺陷修复，Gitea #165 / #164）</h2>
     * 生产调用路径传进来的是 {@code Json.get(params, "gui")} 的**返回值**，即 gson 的
     * {@link JsonPrimitive}，而<b>不是</b> {@code String}。原实现直接
     * {@code String.valueOf(raw)}：对 {@code JsonPrimitive("screen")} 得到的是它的
     * <b>JSON 表示</b>{@code "\"screen\""}（带引号）⇒ 永远落在取值域外 ⇒
     * <b>{@code gui:"screen"} 从来就不可能被接受</b>（离线测试只喂 {@code String}，因此全绿；
     * 这正是「测试全绿但能力不可用」的形态，由实机验收判据 W7b 擒获）。
     *
     * <p>
     * 修法：显式按类型解包，并且**拒绝非字符串标量**（数字/布尔不许静默强转成字符串——
     * {@code contract.md} §2.1 的「类型即判据，不做隐式转换」）。非标量（对象/数组）同样显式拒绝。
     *
     * @param raw 原始参数值（可为 {@code null}；{@code String} 与 {@link JsonElement} 两种形态都接受）
     * @return {@link #GUI_NONE} 或 {@link #GUI_SCREEN}
     * @throws CpException CP-VALID-002：取值域外、类型不符（非标量/非字符串）
     */
    public static String resolveGuiMode(Object raw) {
        if (raw == null) {
            return GUI_NONE;
        }
        String v;
        if (raw instanceof JsonElement) {
            JsonElement e = (JsonElement) raw;
            if (e.isJsonNull()) {
                return GUI_NONE;
            }
            if (!e.isJsonPrimitive()) {
                throw CpException.param(
                    "参数取值非法: gui",
                    "gui",
                    "gui 只接受字符串；收到 " + (e.isJsonObject() ? "对象" : "数组") + "（只许 " + guiChoices() + "）");
            }
            JsonPrimitive p = e.getAsJsonPrimitive();
            if (!p.isString()) {
                throw CpException
                    .param("参数取值非法: gui", "gui", "gui 只接受字符串；收到非字符串标量 " + p + "（本仓禁止静默强转，见 contract.md §2.1）");
            }
            v = p.getAsString()
                .trim();
        } else {
            v = String.valueOf(raw)
                .trim();
        }
        if (v.isEmpty()) {
            return GUI_NONE;
        }
        for (String m : GUI_MODES) {
            if (m.equals(v)) {
                return m;
            }
        }
        throw CpException.param("参数取值非法: gui", "gui", "只许 " + guiChoices() + "（收到 \"" + v + "\"）");
    }

    /** {@code gui} 的取值域（人读形式，供拒绝消息用）。 */
    private static String guiChoices() {
        StringBuilder sb = new StringBuilder();
        for (String m : GUI_MODES) {
            if (sb.length() > 0) {
                sb.append('|');
            }
            sb.append(m);
        }
        return sb.toString();
    }

    /** 供诊断：当前 shots 目录（未关联 run 时返回 null）。 */
    public Path shotsRoot() {
        return in.run == null ? null : shotsDir();
    }
}
