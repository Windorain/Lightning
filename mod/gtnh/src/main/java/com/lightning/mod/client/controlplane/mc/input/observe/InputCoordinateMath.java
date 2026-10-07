package com.lightning.mod.client.controlplane.mc.input.observe;

/**
 * 输入坐标换算的<b>纯函数</b>内核（Gitea #162 冻结件 §2.4、§5.2 的 {@code coordinates}）。
 *
 * <h2>为什么不直接调 MC/LWJGL</h2>
 * 本类<b>零</b> MC/LWJGL 依赖：只做算术，因此能在纯 JVM 单测里把换算钉死
 * （见 {@code InputCoordinateMathTest}）。真正读 {@code Display}/{@code Mouse} 的部分在
 * {@link InputRuntimeProbe} 里，读到的数交给本类。
 *
 * <h2>三套坐标与它们<b>实测</b>的精确关系（全部算术都由此推出）</h2>
 * <ol>
 * <li><b>GUI 缩放坐标</b>：{@code ScaledResolution} 下的坐标（原点左上、Y 向下），与
 * {@code GuiScreen.mouseClicked(mouseX, mouseY, ...)} 同口径——{@code input.mouse op:move} 的
 * <b>唯一</b>入参口径；</li>
 * <li><b>SDL 窗口坐标</b>：{@code Mouse.addMoveEvent} 吃的坐标（原点左下、Y 向上）；</li>
 * <li><b>事件行</b>：{@code Mouse.getY()/getEventY()} 的值域（原点左上、Y 向下）。</li>
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
 * 实读事件 {@code (426,158)}，而 {@code 480 - 322 = 158} ✔。
 *
 * <p>
 * <b>两条换算（口径不同，严禁混用）</b>：
 * <ul>
 * <li><b>投递</b>：目标 GUI 行 → 事件行由 {@link #eventYFromGuiY} 求，再
 * {@link #sdlYFromEventY} 翻转成 {@code addMoveEvent} 的入参；</li>
 * <li><b>回读</b>：{@link #scaledMouse} 逐字对齐 {@code EntityRenderer.java:1077-1078}，
 * 吃掉的是<b>事件行</b>口径（{@code Mouse.getX/getY} 正好就是这一口径）。
 * {@link #readbackGuiY} 是同一式子的 Y 分量包装，供判据与离散逆复用——
 * 曾经把 {@code getY()} 当 SDL 口径再折一次，结果多算一个量级（{@code h=480,s=240,e=30} ⇒ 224
 * 而不是 60），是本类开发期真实踩过的坑，故两条路的入参口径都写进方法名与注释。</li>
 * </ul>
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
 * <p>
 * 全部方法都是纯函数、无副作用、无全局状态；非法入参走 {@code null} 返回或显式夹取，
 * <b>不</b>抛异常——快照路径不该因为一个除零把整个 {@code input.state} 打红。
 */
public final class InputCoordinateMath {

    /** 坐标系标识：GUI 缩放坐标（请求口径）。 */
    public static final String SPACE_GUI_SCALED = "gui-scaled";

    /** 坐标系标识：SDL 窗口坐标（投递口径）。 */
    public static final String SPACE_SDL_WINDOW = "sdl-window";

    /** 坐标系标识：事件行（{@code Mouse.getX/getY} 与 {@code getEventX/getEventY} 的取值域）。 */
    public static final String SPACE_EVENT_QUEUE = "event-queue";

    /** Y 翻转口径的机读文本（契约 §5.2 的 {@code coordinates.yFlip} 原文）。 */
    public static final String Y_FLIP = "eventY = displayHeight - sdlY";

    private InputCoordinateMath() {}

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

    // ------------------------------------------------------------ 回读（事件行 → GUI）

    /**
     * 回读：{@code Mouse.getX()/getY()} → GUI 缩放坐标。
     *
     * <pre>
     * guiX = mouseX * scaledWidth / displayWidth
     * guiY = clampedMouseY - (displayHeight - scaledHeight)     ，clampedMouseY = min(mouseY, displayHeight-1)
     * </pre>
     *
     * <h2>为什么不是「{@code EntityRenderer.java:1078} 的字面照抄」</h2>
     * 那一行是 {@code guiY = scaledHeight - Mouse.getY()*scaledHeight/displayHeight - 1}，
     * 而 {@code Mouse.getY() == displayHeight - sdlY}（类注释的实测关系）。把它代进去化简，得到的
     * 正是上面那两行——唯一的差别是「{@code Mouse.getY()} 可取到 {@code displayHeight}（即
     * SDL {@code sdlY=0}）时，字面式给出 {@code guiY=-1}」。{@code -1} 在 GUI 域外，会让
     * 「请求第 0 行 ⇒ 回读 -1」判失败（差 1，恰好掉出 §2.4 第 4 条的容差），故这里把该端点夹回 0。
     *
     * <p>
     * 结果是一个<b>往返一致</b>的映射：{@link #eventYFromGuiY} 是它的离散逆，
     * 全域落在契约 §2.4 第 4 条的 ±1 内（见 {@code InputCoordinateMathTest} 的逐行断言）。
     * 这也与 P0 实机锚点相符：SDL {@code (426,322)}、{@code h=480}、{@code s=480} ⇒
     * 事件行 {@code 158}、GUI {@code 322}（读回来与请求值一模一样）。
     *
     * @return {@code [guiX, guiY]}；显示尺寸非正时 {@code null}（不得用 0 冒充）
     */
    public static int[] scaledMouse(int mouseX, int mouseY, int scaledWidth, int scaledHeight, int displayWidth,
        int displayHeight) {
        if (displayWidth <= 0 || displayHeight <= 0) {
            return null;
        }
        int guiX = mouseX * scaledWidth / displayWidth;
        int clamped = Math.min(mouseY, displayHeight - 1);
        int guiY = clamped - (displayHeight - scaledHeight);
        return new int[] { guiX, guiY };
    }

    /**
     * 上述式子的 Y 分量（回读判据与离散逆的唯一基准）。
     *
     * @param eventY        {@code Mouse.getY()} 值域的事件行
     * @param scaledHeight  缩放后的高
     * @param displayHeight 显示高
     */
    public static int readbackGuiY(int eventY, int scaledHeight, int displayHeight) {
        int[] gui = scaledMouse(0, eventY, 1, scaledHeight, 1, displayHeight);
        return gui == null ? 0 : gui[1];
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

    // ------------------------------------------------------------ 投递（GUI → 事件行 → SDL）

    /** GUI 缩放坐标 → SDL 窗口坐标 X：{@code sdlX = guiX * displayWidth / scaledWidth}。 */
    public static int sdlXFromGuiX(int guiX, int scaledWidth, int displayWidth) {
        if (scaledWidth <= 0) {
            return guiX;
        }
        return guiX * displayWidth / scaledWidth;
    }

    /** GUI 缩放坐标 X → 事件行 X（X 轴无翻转：{@code eventX == sdlX == Mouse.getX()}）。 */
    public static int eventXFromGuiX(int guiX, int scaledWidth, int displayWidth) {
        return sdlXFromGuiX(guiX, scaledWidth, displayWidth);
    }

    /** 事件行 Y → SDL 窗口坐标 Y：{@code sdlY = displayHeight - eventY}（契约 §5.2 的 {@code yFlip}）。 */
    public static int sdlYFromEventY(int eventY, int displayHeight) {
        return displayHeight - eventY;
    }

    /** SDL 窗口坐标 Y → 事件行 Y（{@link #sdlYFromEventY} 的逆）。 */
    public static int eventYFromSdlY(int sdlY, int displayHeight) {
        return displayHeight - sdlY;
    }

    /**
     * GUI 缩放坐标 Y → <b>事件行</b> Y：{@link #readbackGuiY} 的离散逆。
     *
     * <p>
     * 回读式子 {@code guiY = s - e*s/h - 1} 在 Y 上有两处不可消除的离散效应：
     * {@code e = h} 时回读 {@code -1}（不在 GUI 域内），且 {@code h/s} 有余数时各行覆盖的像素行数
     * 不等（2 或 3）。故恒等逆不存在，本方法在候选窗口内逐行用回读式子打分，取<b>误差最小</b>的行
     * （并列时取较小的 {@code e}，保证确定性）：能精确复现请求行时必然取到精确解。
     *
     * <p>
     * 任何「乘除互换 / 行中心 / 两端对齐」的闭式都只是近似，会在部分行落到 ±1 之外——
     * 症状是「投递成功但回读对不上」，故这里以判据本身为准。
     *
     * @param guiY          请求的 GUI 缩放坐标 Y
     * @param scaledHeight  缩放后的高
     * @param displayHeight 显示高
     * @return 使回读落在 ±1（能精确则精确）的事件行 Y
     */
    public static int eventYFromGuiY(int guiY, int scaledHeight, int displayHeight) {
        if (scaledHeight <= 0 || displayHeight <= 0) {
            return 0;
        }
        int target = clampToScale(guiY, scaledHeight);
        // 回读式（见 scaledMouse）是 guiY = clamp(mouseY) - (h - s)，所以恒等逆就是
        // mouseY = guiY + (h - s)；再考虑 clamp 掉的那一格（mouseY >= h）与 h/s 有余数时的行宽
        // 抖动，在 ±2 内取回读误差最小的行。
        int base = clampToDisplay(target + (displayHeight - scaledHeight), displayHeight);
        int best = base;
        int bestError = Math.abs(readbackGuiY(base, scaledHeight, displayHeight) - target);
        for (int delta = 1; delta <= 2; delta++) {
            for (int candidate : new int[] { base - delta, base + delta }) {
                if (candidate < 0 || candidate > displayHeight) {
                    continue;
                }
                int error = Math.abs(readbackGuiY(candidate, scaledHeight, displayHeight) - target);
                if (error < bestError) {
                    best = candidate;
                    bestError = error;
                }
            }
        }
        return best;
    }

    /** GUI 缩放坐标 → {@code Mouse.addMoveEvent} 的 SDL 窗口坐标 {@code [sdlX, sdlY]}。 */
    public static int[] sdlFromGui(int guiX, int guiY, int scaledWidth, int scaledHeight, int displayWidth,
        int displayHeight) {
        if (scaledWidth <= 0 || scaledHeight <= 0) {
            return null;
        }
        int sdlX = sdlXFromGuiX(guiX, scaledWidth, displayWidth);
        int eventY = eventYFromGuiY(guiY, scaledHeight, displayHeight);
        return new int[] { sdlX, sdlYFromEventY(eventY, displayHeight) };
    }

    // ------------------------------------------------------------ 夹取

    /** 事件行 X → GUI 缩放坐标 X（回读的 X 分量）。 */
    public static int guiXFromEventX(int eventX, int scaledWidth, int displayWidth) {
        if (displayWidth <= 0) {
            return 0;
        }
        return eventX * scaledWidth / displayWidth;
    }

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

    // ------------------------------------------------------------ 换算留痕

    /**
     * 一次「请求 → 投递 → 回读」的完整留痕（供 {@code input.mouse op:move} 与
     * {@code shot.multi gui=screen} 共用同一份算术）。
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
                o.addProperty("spaceNote", "两个空间差一格是坐标系的离散效应（事件行与 GUI 行不同步），不是投递失败；" + "GUI 空间才是命中集与 drawScreen 用的那一路");
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
    public static Projection project(int guiX, int guiY, int scaledWidth, int scaledHeight, int displayWidth,
        int displayHeight) {
        return projectAgainstReadback(guiX, guiY, scaledWidth, scaledHeight, displayWidth, displayHeight, -1, -1);
    }

    /**
     * 换算 + 实读回读核对（同一份算术）。
     *
     * @param readbackMouseX 实读 {@code Mouse.getX()}；负值 = 本次没有回读
     * @param readbackMouseY 实读 {@code Mouse.getY()}；负值 = 本次没有回读
     * @return {@link Projection}；显示/缩放尺寸非正时 {@code null}
     */
    public static Projection projectAgainstReadback(int guiX, int guiY, int scaledWidth, int scaledHeight,
        int displayWidth, int displayHeight, int readbackMouseX, int readbackMouseY) {
        int[] sdl = sdlFromGui(guiX, guiY, scaledWidth, scaledHeight, displayWidth, displayHeight);
        if (sdl == null) {
            return null;
        }
        int eventX = eventXFromGuiX(guiX, scaledWidth, displayWidth);
        int eventY = eventYFromSdlY(sdl[1], displayHeight);
        boolean hasReadback = readbackMouseX >= 0 && readbackMouseY >= 0;
        int[] readGui = hasReadback
            ? scaledMouse(readbackMouseX, readbackMouseY, scaledWidth, scaledHeight, displayWidth, displayHeight)
            : null;
        return new Projection(
            guiX,
            guiY,
            eventX,
            eventY,
            sdl[0],
            sdl[1],
            readbackMouseX,
            readbackMouseY,
            readGui == null ? -1 : readGui[0],
            readGui == null ? -1 : readGui[1],
            hasReadback);
    }
}
