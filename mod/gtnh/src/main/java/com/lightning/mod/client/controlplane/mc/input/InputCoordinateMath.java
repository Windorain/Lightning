package com.lightning.mod.client.controlplane.mc.input;

/**
 * 输入坐标换算的<b>唯一实现点</b>（Gitea #165 收敛项；契约 §2.4 / §5.2 的 {@code coordinates}）。
 *
 * <h2>为什么不直接调 MC/LWJGL</h2>
 * 本类<b>零</b> MC/LWJGL 依赖：只做算术，因此能在纯 JVM 单测里把换算钉死
 * （见 {@code InputCoordinateMathTest} 与 {@code InputCoordinateConvergenceTest}）。
 * 真正读 {@code Display}/{@code Mouse} 的部分在
 * {@code com.lightning.mod.client.controlplane.mc.input.observe.InputRuntimeProbe} 里，读到的数交给本类。
 *
 * <h2>三套坐标与它们<b>实测</b>的精确关系（全部算术都由此推出）</h2>
 * <ol>
 * <li><b>GUI 缩放坐标</b>：{@code ScaledResolution} 下的坐标（原点左上、Y 向下），与
 * {@code GuiScreen.mouseClicked(mouseX, mouseY, ...)} 同口径——{@code input.mouse op:move} 的
 * <b>唯一</b>入参口径；</li>
 * <li><b>SDL 窗口坐标</b>：{@code Mouse.addMoveEvent} 吃的坐标（原点左上、Y 向下）；</li>
 * <li><b>事件行</b>：{@code Mouse.getX()/getEventX()}、{@code Mouse.getY()/getEventY()} 的取值域
 * （原点左下、Y 向上——LWJGL2 口径）。</li>
 * </ol>
 * lwjgl3ify {@code Mouse.addMoveEvent} 逐行：
 *
 * <pre>
 * final float mouseY = event.y() * scale;      // SDL y
 * latestY = Display.getHeight() - (int) mouseY;
 * y = latestY;  lastEventY = latestY;  yEvents[...] = latestY;
 * </pre>
 *
 * ⇒ <b>{@code Mouse.getY() == Mouse.getEventY() == displayHeight - sdlY}</b>
 * （{@code displayHeight} 取 {@code Display.getHeight()}；与 framebuffer 同尺寸时即
 * {@code mc.displayHeight}）。P0 的实测锚点把它钉死：注入 SDL {@code (426,322)} ⇒
 * 实读事件 {@code (426,158)}，而 {@code 480 - 322 = 158} ✔（{@code paths-lwjgl3ify.md}）。
 *
 * <h2>唯一一条换算链（全部方法都是它的分量或它的逆）</h2>
 *
 * <pre>
 * fbX    = round(guiX * displayWidth / scaledWidth)                       （framebufferX）
 * fbY    = round(displayHeight - (guiY + 1) * displayHeight / scaledHeight)（framebufferY）
 * eventX = fbX / S                                                        （eventXFromFramebuffer）
 * eventY = fbY / S                                                        （eventYFromFramebuffer）
 * sdlX   = eventX                                                         （sdlXFromFramebuffer）
 * sdlY   = displayHeight - eventY                                         （sdlYFromEventY，Y 翻转的唯一式子）
 * guiX   = eventX * S * scaledWidth / displayWidth                        （guiXFromEventX，回读）
 * guiY   = scaledHeight - eventY * S * scaledHeight / displayHeight - 1   （guiYFromEventY，回读）
 * </pre>
 *
 * {@code S = Display.getPixelScaleFactor()}（{@link #effectivePixelScale} 把非正读数按 1 处理并留痕）。
 * {@code fbY} 与 {@code Mouse.getY()} 同值域：P0 锚点 {@code guiY=321} ⇒ {@code fbY=158} ⇒
 * {@code sdlY=322} ⇒ {@code eventY=158}，回读 {@code guiY=321}（读回来与请求值一样）。
 *
 * <h2>#165 收敛（本类为什么在 {@code mc.input} 而不是 {@code mc.input.observe}）</h2>
 * 同一份换算曾经有<b>两处独立实现</b>：{@code mc.input.InputCoordinates}（投递侧）与
 * {@code mc.input.observe.InputCoordinateMath}（观察侧）。两处不只是重复，<b>回读口径是镜像的</b>：
 * 被删的那份把回读写成了 {@code guiY = mouseY - (displayHeight - scaledHeight)}，即把
 * {@code Mouse.getY()}/{@code getEventY()}（LWJGL2 左下原点）当成了左上原点的事件行——
 * 在 {@code h == s} 的 1:1 上下文里它对 P0 那组数的回读是 {@code 158}，而本类（与
 * {@code EntityRenderer} 的投影、与实机请求值）给的是 {@code 321}，两者相差 163 行。
 * 观测面靠它自己那套镜像回读「自洽」，所以单测全绿而真值错。收敛方向：纯算术下沉到本层
 * （{@code observe} 是上层观察面，依赖 {@code input} 是正确方向），
 * {@link InputCoordinates} 只保留「上下文值对象 + 回读 JSON」职责并<b>全部委托</b>到这里；
 * {@code observe} 下的旧实现已<b>删除</b>（不留转发壳）。
 *
 * <h2>「回读」为什么用 {@code Mouse.getX/getY} 而不是 {@code getEventX/Y}</h2>
 * 契约 §5.2 的 {@code coordinates.selfCalibrated} 与 §2.4 第 3 条的 {@code readback} 要的是
 * 「{@code move} 之后调用方能自己核对换算」。核对点必须选<b>游戏渲染帧真正用的那个值</b>：
 * 模组 GUI 命中集用的是 {@code Mouse.getX()/getY()}（{@code EntityRenderer.java:1074-1078}
 * → {@code GuiContext.mouseX/Y}），而 {@code getEventX/Y} 只在点击分派里用，且每 tick 被
 * {@code Mouse.next()} 抽干——快照读它会读到「上一 tick 的残留」。前者是<b>当前光标态</b>，
 * 正是「注入有没有落到位置上」应该核对的量。两者在本运行期的值恰好相同（同一条
 * {@code latestY}），但语义不同：**回读取当前光标态**。
 *
 * <h2>整数口径与实数口径（为什么不许两套取整）</h2>
 * 判据那一路（{@code input.mouse op:move} 的 {@code readback}）比的是<b>实数</b>结果
 * （{@link #guiXFromEventX}/{@link #guiYFromEventY}），而观察面（{@code input.state} 的
 * {@code observedNowGui}）要的是整数行。两者都从同一条链派生：整数口径 = 实数结果四舍五入
 * （{@link #scaledMouse}/{@link #readbackGuiY}）。原版投影在 X 上是整数截断，与本类的取整
 * 最多差 1——落在契约 §2.4 第 4 条的 ±1 容差内，但**同一份算术只有一套取整**，免得
 * 「报告的读数」与「判据的读数」再一次分叉。
 *
 * <p>
 * 全部方法都是纯函数、无副作用、无全局状态；非法入参走 {@code null} 返回或显式夹取/归零，
 * <b>不</b>抛异常——快照路径不该因为一个除零把整个 {@code input.state} 打红。投递侧的先验
 * （尺寸/像素密度必须齐备）由 {@link InputCoordinates#usable()} 在调用前拦截，绝不静默投到原点。
 */
public final class InputCoordinateMath {

    /** 坐标系标识：GUI 缩放坐标（请求口径）。 */
    public static final String SPACE_GUI_SCALED = "gui-scaled";

    /** 坐标系标识：SDL 窗口坐标（投递口径）。 */
    public static final String SPACE_SDL_WINDOW = "sdl-window";

    /** 坐标系标识：事件行（{@code Mouse.getX/getY} 与 {@code getEventX/getEventY} 的取值域）。 */
    public static final String SPACE_EVENT_QUEUE = "event-queue";

    /**
     * Y 翻转口径的机读文本（契约 §5.2 的 {@code coordinates.yFlip} 原文）。
     *
     * <p>
     * 与 {@link InputCapabilities#Y_FLIP} <b>同源</b>：冻结字符串的真值只有一处（能力真值表），
     * 本类别名引用它，避免同一句冻结文本出现两个副本。
     */
    public static final String Y_FLIP = InputCapabilities.Y_FLIP;

    /** 像素密度读不到时的哨兵刻度（{@code Display.getPixelScaleFactor} 取不到，或读到非正数）。 */
    public static final double ASSUMED_PIXEL_SCALE = 1.0D;

    private InputCoordinateMath() {}

    /**
     * 像素密度的**唯一**归一化点：非正读数一律按 {@link #ASSUMED_PIXEL_SCALE} 处理
     * （{@code 0} 会让投递坐标除零、让回读变成 {@code NaN}）。
     */
    public static double effectivePixelScale(double pixelScale) {
        return pixelScale > 0.0D ? pixelScale : ASSUMED_PIXEL_SCALE;
    }

    // ------------------------------------------------------------ 缩放尺寸

    /**
     * GUI 缩放尺寸（{@code ScaledResolution} 的算术部分，逐行对齐原版构造器）。
     *
     * @param displayWidth  显示宽（像素）
     * @param displayHeight 显示高（像素）
     * @param guiScale      游戏设置里的 GUI Scale（0 = 自动）
     * @return {@code [scaledWidth, scaledHeight, scaleFactor]}
     */
    public static int[] scaledSize(int displayWidth, int displayHeight, int guiScale) {
        int w = Math.max(1, displayWidth);
        int h = Math.max(1, displayHeight);
        int factor;
        if (guiScale > 0) {
            factor = guiScale;
        } else {
            factor = 1;
            while (factor < 1000 && w / (factor + 1) >= 320 && h / (factor + 1) >= 240) {
                factor++;
            }
            if (factor % 2 != 0 && factor != 1) {
                factor--;
            }
        }
        if (factor < 1) {
            factor = 1;
        }
        return new int[] { ceilDiv(w, factor), ceilDiv(h, factor), factor };
    }

    /** 上取整整除（原版用 {@code MathHelper.ceiling_double_int(w / (double) factor)}）。 */
    private static int ceilDiv(int value, int divisor) {
        if (divisor <= 0) {
            return value;
        }
        return (int) Math.ceil(value / (double) divisor);
    }

    // ------------------------------------------------------------ 唯一算术核心（8 个分量）

    /**
     * GUI 缩放 X → framebuffer 像素 X：{@code round(guiX * displayWidth / scaledWidth)}。
     *
     * <p>
     * 尺寸非正（{@code ≤ 0}）是调用方的先验违例：这里归 0 而不是抛/NaN（观察面不该因为一个坏读数
     * 把整个 {@code input.state} 打红）；投递侧由 {@link InputCoordinates#usable()} 先行拦截。
     */
    public static int framebufferX(double guiX, int scaledWidth, int displayWidth) {
        if (scaledWidth <= 0 || displayWidth <= 0) {
            return 0;
        }
        return (int) Math.round(guiX * (double) displayWidth / (double) scaledWidth);
    }

    /**
     * GUI 缩放 Y → framebuffer 像素 Y（{@code Mouse.getY()}
     * 同值域）：{@code round(displayHeight - (guiY+1) * displayHeight / scaledHeight)}。
     */
    public static int framebufferY(double guiY, int scaledHeight, int displayHeight) {
        if (scaledHeight <= 0 || displayHeight <= 0) {
            return 0;
        }
        return (int) Math
            .round((double) displayHeight - (guiY + 1.0D) * (double) displayHeight / (double) scaledHeight);
    }

    /** framebuffer X → 事件行 X：{@code eventX = fbX / S}（X 轴无翻转）。 */
    public static double eventXFromFramebuffer(int framebufferX, double pixelScale) {
        return (double) framebufferX / effectivePixelScale(pixelScale);
    }

    /** framebuffer Y → 事件行 Y：{@code eventY = fbY / S}。 */
    public static double eventYFromFramebuffer(int framebufferY, double pixelScale) {
        return (double) framebufferY / effectivePixelScale(pixelScale);
    }

    /**
     * 事件行 Y → SDL 窗口坐标 Y：{@code sdlY = displayHeight - eventY}。
     *
     * <p>
     * <b>这是全仓唯一一处写 Y 翻转的地方</b>（契约 §5.2 的 {@code yFlip}）；投递链上的
     * {@link #sdlYFromFramebuffer} 与回读链上的 {@link #eventYFromSdlY} 都只是它的调用方。
     */
    public static double sdlYFromEventY(double eventY, int displayHeight) {
        return (double) displayHeight - eventY;
    }

    /**
     * SDL 窗口坐标 Y → 事件行 Y。
     *
     * <p>
     * 与 {@link #sdlYFromEventY} 是同一个式子（翻转是对合：{@code f(f(x)) == x}），故这里委托，
     * 不复制第二份 {@code displayHeight - x}。
     */
    public static double eventYFromSdlY(double sdlY, int displayHeight) {
        return sdlYFromEventY(sdlY, displayHeight);
    }

    /**
     * 事件行 X → GUI 缩放 X（回读的 X 分量，实数口径）：{@code guiX = eventX * S * scaledWidth / displayWidth}。
     *
     * <p>
     * {@code S != 1} 时先把观测值乘回 framebuffer 口径再走 vanilla 正换算——HiDPI 下的口径
     * <b>未实机校准</b>（契约 §11.2 第 12 条），故换算把 {@code S} 显式带进表达式，实机对不上时
     * 以 {@code input.mouse op:move} 的 {@code readback} 为准。
     */
    public static double guiXFromEventX(double eventX, int scaledWidth, int displayWidth, double pixelScale) {
        if (displayWidth <= 0) {
            return 0.0D;
        }
        return eventX * effectivePixelScale(pixelScale) * (double) scaledWidth / (double) displayWidth;
    }

    /**
     * 事件行 Y → GUI 缩放 Y（回读的 Y 分量，实数口径）。
     *
     * <p>
     * {@code guiY = scaledHeight - eventY * S * scaledHeight / displayHeight - 1}，与
     * {@code EntityRenderer.java:1077-1078} 同式（那一行吃的事件行口径就是 {@code Mouse.getY()}）。
     */
    public static double guiYFromEventY(double eventY, int scaledHeight, int displayHeight, double pixelScale) {
        if (displayHeight <= 0) {
            return 0.0D;
        }
        return (double) scaledHeight
            - eventY * effectivePixelScale(pixelScale) * (double) scaledHeight / (double) displayHeight
            - 1.0D;
    }

    // ------------------------------------------------------------ 投递（由核心派生，无第二份算式）

    /** framebuffer X → SDL 窗口坐标 X（X 轴不翻转：{@code sdlX == eventX}）。 */
    public static double sdlXFromFramebuffer(int framebufferX, double pixelScale) {
        return eventXFromFramebuffer(framebufferX, pixelScale);
    }

    /** framebuffer Y → SDL 窗口坐标 Y（{@code sdlY = displayHeight - fbY / S}）。 */
    public static double sdlYFromFramebuffer(int framebufferY, int displayHeight, double pixelScale) {
        return sdlYFromEventY(eventYFromFramebuffer(framebufferY, pixelScale), displayHeight);
    }

    /** GUI 缩放 X → 事件行 X（整数口径，四舍五入到整像素行）。 */
    public static int eventXFromGuiX(double guiX, int scaledWidth, int displayWidth, double pixelScale) {
        return roundToInt(eventXFromFramebuffer(framebufferX(guiX, scaledWidth, displayWidth), pixelScale));
    }

    /** GUI 缩放 Y → 事件行 Y（整数口径）：投递给 {@code addMoveEvent} 的 SDL Y 由它翻转而来。 */
    public static int eventYFromGuiY(double guiY, int scaledHeight, int displayHeight, double pixelScale) {
        return roundToInt(eventYFromFramebuffer(framebufferY(guiY, scaledHeight, displayHeight), pixelScale));
    }

    /**
     * GUI 缩放坐标 → {@code Mouse.addMoveEvent} 的 SDL 窗口坐标 {@code [sdlX, sdlY]}（整数口径）。
     *
     * @return {@code [sdlX, sdlY]}；缩放尺寸非正时 {@code null}（不许编一组坐标）
     */
    public static int[] sdlFromGui(double guiX, double guiY, int scaledWidth, int scaledHeight, int displayWidth,
        int displayHeight, double pixelScale) {
        if (scaledWidth <= 0 || scaledHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) {
            return null;
        }
        int fbX = framebufferX(guiX, scaledWidth, displayWidth);
        int fbY = framebufferY(guiY, scaledHeight, displayHeight);
        return new int[] { roundToInt(sdlXFromFramebuffer(fbX, pixelScale)),
            roundToInt(sdlYFromFramebuffer(fbY, displayHeight, pixelScale)) };
    }

    // ------------------------------------------------------------ 回读（整数口径）

    /**
     * 回读：{@code Mouse.getX()/getY()}（事件行） → GUI 缩放坐标，整数口径。
     *
     * <p>
     * 实现是实数核心的四舍五入（见类注释「整数口径与实数口径」）：此处<b>不</b>另写一份换算。
     *
     * @return {@code [guiX, guiY]}；显示尺寸非正时 {@code null}（不得用 0 冒充「就在原点」）
     */
    public static int[] scaledMouse(int mouseX, int mouseY, int scaledWidth, int scaledHeight, int displayWidth,
        int displayHeight, double pixelScale) {
        if (displayWidth <= 0 || displayHeight <= 0) {
            return null;
        }
        return new int[] { readbackGuiX(mouseX, scaledWidth, displayWidth, pixelScale),
            readbackGuiY(mouseY, scaledHeight, displayHeight, pixelScale) };
    }

    /** 事件行 X → GUI 缩放 X（{@link #scaledMouse} 的 X 分量，整数口径）。 */
    public static int readbackGuiX(int eventX, int scaledWidth, int displayWidth, double pixelScale) {
        return roundToInt(guiXFromEventX(eventX, scaledWidth, displayWidth, pixelScale));
    }

    /**
     * 事件行 Y → GUI 缩放 Y（回读判据与往返核对的唯一基准，整数口径）。
     *
     * <p>
     * 【实测】{@code Mouse.getY()} 是 LWJGL2 左下原点口径，故这里必须走
     * {@code scaledHeight - eventY * S * scaledHeight / displayHeight - 1}；把它写成
     * 「减去一个常量」会让同一组数在 1:1 上下文回读出镜像行（#165 收敛前的真实缺陷）。
     */
    public static int readbackGuiY(int eventY, int scaledHeight, int displayHeight, double pixelScale) {
        return roundToInt(guiYFromEventY(eventY, scaledHeight, displayHeight, pixelScale));
    }

    /**
     * 一次换算的自校准判定：实读回读是否等于请求坐标（容许 ±1 整数量化）。
     *
     * <p>
     * 契约 §2.4 第 4 条只承认这一个成功定义（<b>不</b>把「GUI 控件被命中」算作成功）。
     * 本方法是那条判据的唯一实现点。
     */
    public static boolean readbackMatches(int requestedGuiX, int requestedGuiY, int readbackGuiX, int readbackGuiY,
        int tolerance) {
        int t = Math.max(0, tolerance);
        return Math.abs(requestedGuiX - readbackGuiX) <= t && Math.abs(requestedGuiY - readbackGuiY) <= t;
    }

    // ------------------------------------------------------------ 夹取

    /** 把值夹到 GUI 缩放轴 {@code [0, scaledExtent-1]}。 */
    public static int clampToScale(int value, int scaledExtent) {
        if (scaledExtent <= 0) {
            return 0;
        }
        if (value < 0) {
            return 0;
        }
        return Math.min(value, scaledExtent - 1);
    }

    /**
     * 把值夹到事件行轴 {@code [0, displayExtent]}。
     *
     * <p>
     * 与 {@link #clampToScale} 分开是<b>故意的</b>：事件行轴的上界是 {@code displayExtent}
     * （{@code Mouse.getY()} 可以达到 {@code displayHeight}），不是 {@code displayExtent-1}，
     * 也不是 GUI 轴的 {@code scaled-1}。混用会把坐标压到左上角附近，症状与「换算写错」完全一样。
     */
    public static int clampToDisplay(int value, int displayExtent) {
        if (displayExtent <= 0) {
            return 0;
        }
        if (value < 0) {
            return 0;
        }
        return Math.min(value, displayExtent);
    }

    /** 整数口径的统一取整点（{@code Math.round(double)} → {@code int}；{@code NaN} 归 0）。 */
    private static int roundToInt(double v) {
        if (Double.isNaN(v)) {
            return 0;
        }
        if (v > Integer.MAX_VALUE) {
            return Integer.MAX_VALUE;
        }
        if (v < Integer.MIN_VALUE) {
            return Integer.MIN_VALUE;
        }
        return (int) Math.round(v);
    }

    // ------------------------------------------------------------ 换算留痕

    /**
     * 一次「请求 → 投递 → 回读」的完整留痕（供 {@code input.mouse op:move} 与
     * {@code input.state.coordinates} 共用同一份算术）。
     */
    public static final class Projection {

        /** 请求的 GUI 缩放坐标。 */
        public final int guiX;
        /** 请求的 GUI 缩放坐标。 */
        public final int guiY;
        /** 换算后的事件行坐标（{@code Mouse.getEventX/Y} 值域）。 */
        public final int eventX;
        /** 换算后的事件行坐标。 */
        public final int eventY;
        /** 投递给 {@code Mouse.addMoveEvent} 的 SDL 窗口坐标。 */
        public final int sdlX;
        /** 投递给 {@code Mouse.addMoveEvent} 的 SDL 窗口坐标。 */
        public final int sdlY;
        /** 实读 {@code Mouse.getX()}（事件行口径）；{@code -1} = 本次未读。 */
        public final int readbackMouseX;
        /** 实读 {@code Mouse.getY()}（事件行口径）；{@code -1} = 本次未读。 */
        public final int readbackMouseY;
        /** 回读换算出的 GUI 缩放坐标 X（命中集与 {@code drawScreen} 用的那一路）。 */
        public final int readbackGuiX;
        /** 回读换算出的 GUI 缩放坐标 Y。 */
        public final int readbackGuiY;
        /** 是否有实读回读参与。 */
        public final boolean hasReadback;

        Projection(int guiX, int guiY, int eventX, int eventY, int sdlX, int sdlY, int readbackMouseX,
            int readbackMouseY, int readbackGuiX, int readbackGuiY, boolean hasReadback) {
            this.guiX = guiX;
            this.guiY = guiY;
            this.eventX = eventX;
            this.eventY = eventY;
            this.sdlX = sdlX;
            this.sdlY = sdlY;
            this.readbackMouseX = readbackMouseX;
            this.readbackMouseY = readbackMouseY;
            this.readbackGuiX = readbackGuiX;
            this.readbackGuiY = readbackGuiY;
            this.hasReadback = hasReadback;
        }

        /** 是否有实读回读；无回读时自校准<b>不可判</b>（{@code null}，不是 {@code false}）。 */
        public Boolean selfCalibrated(int tolerance) {
            if (!hasReadback) {
                return null;
            }
            return Boolean.valueOf(readbackMatches(guiX, guiY, readbackGuiX, readbackGuiY, tolerance));
        }

        /** 回读的 GUI 缩放坐标 X（由 {@link #scaledMouse} 从实读值得出）。 */
        public int readbackGuiX() {
            return readbackGuiX;
        }

        /** 回读的 GUI 缩放坐标 Y（命中集用的就是这一路）。 */
        public int readbackGuiY() {
            return readbackGuiY;
        }

        /** 回读与请求在<b>事件行</b>空间是否相等（±{@code tolerance}）。 */
        public Boolean eventSpaceMatches(int tolerance) {
            if (!hasReadback) {
                return null;
            }
            int t = Math.max(0, tolerance);
            return Boolean.valueOf(Math.abs(eventX - readbackMouseX) <= t && Math.abs(eventY - readbackMouseY) <= t);
        }

        /** 机读留痕：三套坐标 + 回读（同口径）+ 两个空间的校准结论。 */
        public com.google.gson.JsonObject toJson() {
            com.google.gson.JsonObject o = new com.google.gson.JsonObject();
            o.add("requested", space(SPACE_GUI_SCALED, guiX, guiY));
            o.add("eventQueue", space(SPACE_EVENT_QUEUE, eventX, eventY));
            o.add("delivered", space(SPACE_SDL_WINDOW, sdlX, sdlY));
            if (hasReadback) {
                com.google.gson.JsonObject raw = space(SPACE_EVENT_QUEUE, readbackMouseX, readbackMouseY);
                raw.addProperty("source", "Mouse.getX/getY（当前光标态；值域 = displayHeight - sdlY）");
                o.add("readback", raw);
                o.add("readbackGui", space(SPACE_GUI_SCALED, readbackGuiX, readbackGuiY));
                o.addProperty("selfCalibrated", selfCalibrated(1));
                o.addProperty("selfCalibratedSpace", SPACE_GUI_SCALED);
                o.addProperty("eventSpaceMatches", eventSpaceMatches(1));
                o.addProperty(
                    "spaceNote",
                    "GUI 空间才是命中集与 drawScreen 用的那一路：事件行 = displayHeight - sdlY（LWJGL2 左下原点），"
                        + "与 GUI 行（左上原点）不是同一套刻度，h > s 时同一 GUI 行覆盖 h/s 个事件行 ⇒ "
                        + "「回读等于请求值」只在 GUI 空间成立");
            } else {
                o.addProperty("readback", (String) null);
                o.addProperty("selfCalibrated", (Boolean) null);
                o.addProperty("readbackNote", "未取到 Mouse.getX/getY ⇒ 自校准不可判（null，不是 false）");
            }
            o.addProperty("yFlip", Y_FLIP);
            return o;
        }

        private static com.google.gson.JsonObject space(String space, int x, int y) {
            com.google.gson.JsonObject o = new com.google.gson.JsonObject();
            o.addProperty("space", space);
            o.addProperty("x", x);
            o.addProperty("y", y);
            return o;
        }
    }

    /** 换算一组 GUI 坐标（无回读）。 */
    public static Projection project(double guiX, double guiY, int scaledWidth, int scaledHeight, int displayWidth,
        int displayHeight, double pixelScale) {
        return projectAgainstReadback(
            guiX,
            guiY,
            scaledWidth,
            scaledHeight,
            displayWidth,
            displayHeight,
            pixelScale,
            -1,
            -1);
    }

    /**
     * 换算 + 实读回读核对（同一份算术）。
     *
     * @param readbackMouseX 实读 {@code Mouse.getX()}；负值 = 本次没有回读
     * @param readbackMouseY 实读 {@code Mouse.getY()}；负值 = 本次没有回读
     * @return {@link Projection}；缩放/显示尺寸非正时 {@code null}
     */
    public static Projection projectAgainstReadback(double guiX, double guiY, int scaledWidth, int scaledHeight,
        int displayWidth, int displayHeight, double pixelScale, int readbackMouseX, int readbackMouseY) {
        if (scaledWidth <= 0 || scaledHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) {
            return null;
        }
        int fbX = framebufferX(guiX, scaledWidth, displayWidth);
        int fbY = framebufferY(guiY, scaledHeight, displayHeight);
        int eventX = roundToInt(eventXFromFramebuffer(fbX, pixelScale));
        int eventY = roundToInt(eventYFromFramebuffer(fbY, pixelScale));
        int sdlX = roundToInt(sdlXFromFramebuffer(fbX, pixelScale));
        int sdlY = roundToInt(sdlYFromFramebuffer(fbY, displayHeight, pixelScale));
        boolean hasReadback = readbackMouseX >= 0 && readbackMouseY >= 0;
        int[] readGui = hasReadback
            ? scaledMouse(
                readbackMouseX,
                readbackMouseY,
                scaledWidth,
                scaledHeight,
                displayWidth,
                displayHeight,
                pixelScale)
            : null;
        return new Projection(
            roundToInt(guiX),
            roundToInt(guiY),
            eventX,
            eventY,
            sdlX,
            sdlY,
            readbackMouseX,
            readbackMouseY,
            readGui == null ? -1 : readGui[0],
            readGui == null ? -1 : readGui[1],
            hasReadback);
    }
}
