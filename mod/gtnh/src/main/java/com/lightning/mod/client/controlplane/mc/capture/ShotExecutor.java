package com.lightning.mod.client.controlplane.mc.capture;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
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

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
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
 * <h2>拍摄帧内隐藏玩家</h2>
 * {@code RenderGlobal.renderEntities} 只跳过 {@code mc.renderViewEntity} <b>自己</b>
 * （反编译源 {@code RenderGlobal.java:524}：{@code entity != this.mc.renderViewEntity || ...}），
 * 而注入的相机不是玩家 ⇒ 稳定化在场景旁的<b>玩家模型</b>会进每个机位的画面。故每片渲染的作用域里
 * {@code mc.thePlayer.setInvisible(true)}、finally 还原原值，逐机位 meta 记 {@code playerHidden}。
 * {@code setInvisible} 只改客户端实体 dataWatcher 的显示标志（{@code Entity.setInvisible} → {@code setFlag(5)}），
 * 不写服务端实体、不动世界状态。渲染侧生效点是 {@code RendererLivingEntity.renderModel:307-328}：
 * 隐身时走「不画」分支（托管世界无队伍 ⇒ {@code EntityPlayer.isInvisibleToPlayer} 返回 true，
 * {@code EntityPlayer.java:2380-2391}）；只有玩家属于「可互见隐身」的队伍时才会退化成 15% alpha 剪影。
 *
 * <h2>视点口径（{@code effectiveEyePos}）</h2>
 * 机位声明的 {@code pos} 经 {@link VirtualCamera}（{@code yOffset = 1.62}）后就是实际视点
 * （推导见 {@link VirtualCamera} 类注释），逐机位 meta 用 {@code effectiveEyePos} 把这条口径写成字段
 * （= 声明 {@code pos}）；原版第一人称相机固有的 0.1 格常量不随声明变化，故不进这个字段。
 *
 * <h2>为什么直接调 {@code renderWorld} 而不是等游戏自己渲</h2>
 * 游戏每帧只渲染一次、且相机是玩家。要在<b>同一 tick 内</b>连续拿到 N 个机位 × M 个 tile 的帧，
 * 必须自己驱动渲染。1.7.10 单机里 tick 线程 == 渲染线程，因此这种「自己渲」与游戏自身的渲染
 * 在同一线程上串行，不存在并发改 GL 状态的问题（contract §4.2.5 的线程口径）。
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
 * <h2>禁止视口拼接</h2>
 * tile 全部靠 {@link ProjectionOverride} 的投影偏移实现，<b>从不</b>移动 GL 视口：
 * {@code EntityRenderer.renderWorld} 每帧强制 {@code glViewport(0,0,displayWidth,displayHeight)}，
 * 视口拼接会被它改回去，接缝必然错位（contract §4.2.4 明令禁止）。
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
    }

    /** 进度回调（0..1 与说明）。 */
    public interface Progress {

        /** 上报进度。 */
        void onProgress(double fraction, String message);
    }

    /** 一个机位的执行状态。 */
    private static final class CameraRun {

        private final CameraSpec spec;
        /** 有效 tile 网格（可能因像素比例自动追加划分，见 {@link TilePlan}）。 */
        private final TilePlan plan;
        /** 逐 tile 读回的整图（null 元素 = 该 tile 失败）。 */
        private final BufferedImage[][] tiles;
        private int tileIndex;
        private int settle = -1;
        private int attempts;
        /** 本机位渲染期是否隐藏过玩家（meta 留痕；见类注释「拍摄帧内隐藏玩家」）。 */
        private boolean playerHidden;
        private final JsonObject result = new JsonObject();

        CameraRun(CameraSpec spec, int baseW, int baseH) {
            this.spec = spec;
            this.plan = TilePlan.of(spec, baseW, baseH);
            this.tiles = new BufferedImage[plan.gridRows][plan.gridCols];
        }
    }

    /**
     * 单个机位的渲染分片计划（投影偏移 tiling 的有效网格）。
     *
     * <p>
     * 网格口径与 {@link ProjectionOverride#resolveGrid} <b>同源</b>（投影覆写自己也用那份代码）：
     * 投影偏移法要求「每片的渲染像素恰好等于它在整图里的格位」，因此分片尺寸由网格反推，
     * 不允许两边各算一套。{@link #matches} 在每次 arm 之后核对一次，不一致即判渲染故障
     * （宁可失败，也不出一张网格对不上却看着正常的图）。
     *
     * <p>
     * 需要知道的语义：<b>tile 段的意思是「把几个低分辨率渲染拼成一张图」</b>——每片的渲染分辨率
     * 由网格决定（{@code resolution/cols × resolution/rows}），拼起来才是请求分辨率。声明 2×2 而
     * 「每片分辨率 : 真实窗口」的像素比在 x/y 上不一致时，有效网格会按像素比<b>追加</b>分片；
     * {@code shot-meta} 里 {@code tile.cols/rows} 记实际网格、{@code requestedCols/requestedRows}
     * 记声明值，事后一眼能看出有没有被改写。
     */
    private static final class TilePlan {

        private final boolean tiled;
        private final int gridCols;
        private final int gridRows;
        private final int pieceW;
        private final int pieceH;
        private final int extraW;
        private final int extraH;

        private TilePlan(boolean tiled, int gridCols, int gridRows, int totalW, int totalH) {
            this.tiled = tiled;
            this.gridCols = Math.max(1, gridCols);
            this.gridRows = Math.max(1, gridRows);
            this.pieceW = totalW / this.gridCols;
            this.pieceH = totalH / this.gridRows;
            this.extraW = totalW - pieceW * this.gridCols;
            this.extraH = totalH - pieceH * this.gridRows;
        }

        static TilePlan of(CameraSpec spec, int baseW, int baseH) {
            int reqCols = Math.max(1, spec.tileCols());
            int reqRows = Math.max(1, spec.tileRows());
            int renderW = Math.max(1, spec.width() / reqCols);
            int renderH = Math.max(1, spec.height() / reqRows);
            int[] extra = ProjectionOverride.resolveGrid(renderW, renderH, baseW, baseH);
            int cols = reqCols * extra[0];
            int rows = reqRows * extra[1];
            return new TilePlan(cols > 1 || rows > 1, cols, rows, spec.width(), spec.height());
        }

        int gridCols() {
            return gridCols;
        }

        int gridRows() {
            return gridRows;
        }

        boolean tiled() {
            return tiled;
        }

        /** 该列分片的渲染宽（余数归末列）。 */
        int spanX(int col) {
            return col == gridCols - 1 ? pieceW + extraW : pieceW;
        }

        /** 该行分片的渲染高（余数归末行）。 */
        int spanY(int row) {
            return row == gridRows - 1 ? pieceH + extraH : pieceH;
        }

        /** 该列分片在整图中的像素起点。 */
        int offsetX(int col) {
            return pieceW * col;
        }

        /** 该行分片在整图中的像素起点。 */
        int offsetY(int row) {
            return pieceH * row;
        }

        /** 该列分片在整图中的像素跨度（= 渲染宽）。 */
        int frameSpanX(int col) {
            return spanX(col);
        }

        /** 该行分片在整图中的像素跨度（= 渲染高）。 */
        int frameSpanY(int row) {
            return spanY(row);
        }

        boolean matches(int cols, int rows) {
            return gridCols == cols && gridRows == rows;
        }

        /** 留痕文本。 */
        String describe() {
            return gridCols + "x" + gridRows + (tiled ? "" : " (single)");
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
            runs.add(new CameraRun(spec, baseWidth, baseHeight));
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
            mc.theWorld.setWorldTime(in.capture.worldTime());
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
        int total = run.plan.gridCols() * run.plan.gridRows();
        if (run.tileIndex >= total) {
            return true;
        }
        int col = run.tileIndex % run.plan.gridCols() + 1;
        int row = run.tileIndex / run.plan.gridCols() + 1;
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
        int bufW = plan.spanX(col - 1);
        int bufH = plan.spanY(row - 1);
        if (!settingsSaved) {
            savedFov = mc.gameSettings.fovSetting;
            savedThirdPerson = mc.gameSettings.thirdPersonView;
            settingsSaved = true;
        }
        // 投影参数：正交机位自己算矩阵，透视机位把 FOV 交给原版管线（再由覆写做像素级偏移）
        if (!spec.isOrtho()) {
            mc.gameSettings.fovSetting = clampFov(spec.fov());
        }
        mc.gameSettings.thirdPersonView = 0;
        String renderMode = CameraSpecs.resolveRenderMode(spec, in.capture);
        String lighting = CameraSpecs.resolveLighting(spec, in.capture);
        if (CaptureSpec.RENDER_MODE_LIT.equals(renderMode) || CaptureSpec.LIGHTING_NEUTRAL_FLAT.equals(lighting)) {
            // contract §4.2.6 的「参与光照 / 中性光照」在本版是如实留痕的<b>观测档位</b>：
            // 世界光照管线本身不做替换（v1 未引入光照注入渲染通道），逐图 meta 与
            // observation.runtimeReads 都会标注 lightingApplied=false，避免事后把
            // 「标注了参与光照」误读成「画面真的被打了中性光」。
            warnOnce("lightingApplied=false（v1 不做光照注入，仅留痕 renderMode/lighting 档位）");
        }

        FrameScope scope = new FrameScope();
        try {
            scope.arm(spec, plan, bufW, bufH, col, row, run);
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
            double farPlane = Math.max(256.0d, mc.gameSettings.renderDistanceChunks * 16.0d * 2.0d);
            ProjectionOverride.arm(
                spec.isOrtho() ? ProjectionOverride.TYPE_ORTHO : ProjectionOverride.TYPE_PERSPECTIVE,
                spec.fov(),
                spec.orthoHeight(),
                baseWidth,
                baseHeight,
                bufW,
                bufH,
                plan.spanX(col - 1),
                plan.spanY(row - 1),
                col,
                row,
                farPlane);
            // 网格自检：执行器的分片计划必须与投影覆写解出的有效网格一致，否则会出现
            // 「每片都对、拼起来错」的静默错图（比渲染失败更难查），故当场判失败。
            if (!plan.matches(ProjectionOverride.effectiveTileCols(), ProjectionOverride.effectiveTileRows())) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    "tile 网格自检失败：执行器 " + plan.gridCols()
                        + "x"
                        + plan.gridRows()
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
        r.addProperty("worldTime", in.mc.theWorld == null ? -1L : in.mc.theWorld.getWorldTime());
        r.addProperty("tile", Boolean.valueOf(plan.tiled()));
        r.addProperty("tileCols", plan.gridCols());
        r.addProperty("tileRows", plan.gridRows());
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
            meta.addProperty("renderMode", Json.optString(r, "renderMode", null));
            meta.addProperty("lighting", Json.optString(r, "lighting", null));
            meta.addProperty("lightingApplied", Boolean.FALSE);
            meta.addProperty("worldTime", Json.optLong(r, "worldTime", -1L));
            meta.add("resolution", resolutionJson(composed.getWidth(), composed.getHeight()));
            meta.add("requestedResolution", resolutionJson(spec.width(), spec.height()));
            meta.add("renderBufferResolution", resolutionJson(plan.spanX(0), plan.spanY(0)));
            meta.addProperty("projection", spec.projection());
            meta.addProperty("projectionApplied", ProjectionOverride.describe());
            meta.addProperty("cameraHeldDuringRender", Boolean.valueOf(cameraHeldDuringRender));
            JsonObject tile = new JsonObject();
            tile.addProperty("cols", plan.gridCols());
            tile.addProperty("rows", plan.gridRows());
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
                plan.tiled() ? plan.gridCols() + "x" + plan.gridRows() : "no");
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
        for (int row = 0; row < plan.gridRows(); row++) {
            int spanH = plan.spanY(row);
            for (int col = 0; col < plan.gridCols(); col++) {
                int spanW = plan.spanX(col);
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
                paste(out, tile, plan.offsetX(col), plan.offsetY(row));
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

    /** 供诊断：当前 shots 目录（未关联 run 时返回 null）。 */
    public Path shotsRoot() {
        return in.run == null ? null : shotsDir();
    }
}
