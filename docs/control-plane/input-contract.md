# 输入手段契约（`input.*` 动作族）

本文定义通用玩家输入设施（`input.*`）的接口、坐标口径、生命周期、执行语义与能力清单。控制面的端点、鉴权、错误码与线程模型见 [contract.md](contract.md)；用例侧的输入固定程序见 [case-file.md §3.2](case-file.md)。

五个动作已注册；`GET /cp/v1/actions` 的 `count` = 48，`contractVersion` = 1.8，五个动作的 `since` 均为 `1.8`。

## 1. 范围与注入面

### 1.1 运行期

| 项 | 值 | 说明 |
|---|---|---|
| Minecraft | 1.7.10 | `mod/gtnh/gradle.properties` 的 `minecraftVersion`；输入分派、`KeyBinding` 语义与 GUI 路由按此版本 |
| Forge | 10.13.4.1614 | 同文件的 `forgeVersion`；决定 `InputEvent` / `GuiScreenEvent` 的可用面 |
| 输入实现 | lwjgl3ify 的 `org.lwjglx.input.*`（`org.lwjgl.input.*` 在其运行期被重定向） | 运行期版本不在仓内声明，实际取值由 `input.state.runtime.lwjgl3ify` 给出 |
| 输入后端 | SDL | `runtime.backend` 为 `"sdl"`；`Mouse.addMoveEvent` 接收 `org.lwjgl.sdl.SDL_MouseMotionEvent`，仓内无 GLFW 入口 |
| 注入线程 | 客户端 tick 线程（1.7.10 单机即渲染线程） | 与 `contract.md` §8 的线程纪律同源 |

上述任一项变动（换 MC 版本、换输入实现版本、换后端或模组包）后，本文的能力声明与 §8 清单需重新核对。

### 1.2 允许的注入面

以下五个方法是本族全部允许的写入口；它们只写 Java 侧的队列，不调用 SDL 函数，因此不动用户桌面的鼠标、不抢焦点：

| 入口 | 承载的参数 |
|---|---|
| `org.lwjglx.input.Keyboard.addRawKeyEvent(Keyboard.KeyEvent)` | `input.key`（含事件自带 `codepoint`） |
| `org.lwjglx.input.Keyboard.addCharEvent(int key, int c)` | `input.text` |
| `org.lwjglx.input.Mouse.addMoveEvent(SDL_MouseMotionEvent)` | `input.mouse` 的 `move` 与 `relative` |
| `org.lwjglx.input.Mouse.addButtonEvent(int button, boolean down)` | `input.mouse` 的 `down`/`up`/`click` |
| `org.lwjglx.input.Mouse.addWheelEvent(double delta)` | `input.mouse` 的 `wheel` |

**不得调用**的入口：`Mouse.setGrabbed`、`Mouse.setCursorPosition`、`Mouse.setNativeCursor`/`setCursorIcon`（均触发 SDL 侧真实光标操作）；直写 `Keyboard.sdlKeyPressedArray`、`Mouse.sdlMouseButtonFlags`（每帧被 SDL 重填，存活不足一帧）；直写或 `clear()` `Keyboard.eventQueue`（绕过 REPEAT 过滤；`clear()` 会清掉静态 seed 哨兵，其后 `getEventKey()` 等对 `peek()` 解引用将 NPE）；自行 `Mouse.next()` 排空队列（与游戏争抢同一队列）；单独使用 `InputEvents.injectKeyEvent`/`injectTextEvent`（不进 vanilla 队列，真实按键是两路都发）；反射改写 `Display.displayFocused` 或强制 `Display.isActive()`（那是开关不是注入）；绕过 `GuiScreen.handleInput` 的旁路（直调 MUI2 的 `ClientScreenHandler`）。

**编译可见性**：lwjgl3ify 的 `-api` 制品不含 `org/lwjglx/**`，且 RFB 重定向只改类名不改方法名。实现因此走 `Class.forName("org.lwjglx.input.Keyboard")` 加反射（字符串字面量不被重映射）。

### 1.3 能力定位

本族的能力是「把事件送到游戏自己的路由并如实报告边界」，不是「任何界面与任何模组都能驱动」。已知结构性断点：

1. 轮询面（`Keyboard.isKeyDown`、`Mouse.isButtonDown`、`GameSettings.isKeyDown`）读 SDL 物理状态数组，不读事件队列，队列注入不改变它们；
2. GUI 存活期 `KeyBinding.pressed` 恒为 `false`（开屏即 `unPressAllKeys()`，且世界闸门不成立）；
3. 1.7.10 Forge 没有 `GuiScreenEvent.KeyboardInputEvent`/`MouseInputEvent`（那是 MUI2 自造的类）；
4. 模组 GUI 的命中集每帧重建且位置来自 `Mouse.getX/getY`，位置与按下必须跨帧；
5. 模组自定义输入事件只在它自己的 `GuiScreen.handleInput` mixin 里 post，绕开这条路没有反应。

每条断点在 `input.state` 都有机读落点（§6），新发现的断点必须补进 §8 的清单。

## 2. 动作与参数

### 2.1 两套输入状态

| 面 | 载体 | 谁读它 | 队列注入能否影响 |
|---|---|---|---|
| 事件队列面 | `Keyboard.eventQueue`（容量 256，静态 seed 一条 RELEASE）、`Mouse.queue`（环形，容量 128） | GUI 回调链、`KeyBinding` 更新链、`KeyInputEvent`/`MouseInputEvent`、Forge `MouseEvent` | 能 |
| 物理轮询面 | `Keyboard.sdlKeyPressedArray`、`Mouse.sdlMouseButtonFlags` | `Keyboard.isKeyDown`、`Mouse.isButtonDown`、`GameSettings.isKeyDown`、MUI `Interactable` | 不能（每帧被 SDL 覆写） |

本族只覆盖事件队列面。依赖轮询面的语义（Shift/Ctrl/Alt 组合、`GuiContainer` 的 Shift 点击、NEI 自建按键状态机、`SyncedKeybind`）不在承诺范围，由 `input.state.pollSurface` 如实标注。因此「组合键」的冻结语义是**事件序**而非修饰键态（§2.7）。

### 2.2 `input.key`

| 参数 | 必填 | 类型 | 口径 |
|---|---|---|---|
| `key` | 是 | `string` 或 `int` | 键位标识：`string` 为游戏键位描述名（如 `key.forward`）；`int` 为 LWJGL 键码（不是 SDL scancode） |
| `action` | 是 | `string` | `down` / `up` / `tap`；取值域外 `CP-VALID-002` |
| `holdTicks` | 否 | `int` | 仅 `action:"tap"` 允许；`1..1200`；缺省 `1` |
| `codepoint` | 否 | `int` | 本事件自带的已提交字符（Unicode 码点，`0..0xFFFF`）；缺省 `0` 表示不携带字符 |

1. **键位标识的权威来源是运行期键位注册表**：`input.state.keyCatalog` 给出完整目录（名 → 键码），调用方以它为准。
2. 未知键位标识或键码越域 ⇒ `CP-VALID-002`，`context.fields` 逐字段说明，`context.registered` 给出完整键位目录。
3. 键码域由 `input.state.keyCodeRange` 给出（当前 `[0, 255]`）。
4. **构造器等价性是实现义务**：`Keyboard.KeyEvent` 的 `key` 字段对 `KEY_ESCAPE`/`HOME`/`NUMLOCK`/`CAPITAL`/`SCROLL`/`LCONTROL`/`LSHIFT`/`LMETA`/`LMENU`/`RCONTROL`/`RSHIFT`/`RMETA`/`RMENU` 改用 `keyNonScancode`；设施必须保证投递后 `Keyboard.getEventKey()` 等于调用方给的值。
5. **不支持重复按键（REPEAT）**：不提供任何 repeat 参数；需要连发用多次 `tap`。
6. `input.key` 是步进动作（工厂注册）：`tap` 的 `holdTicks` 跨 tick。不适用字段（如 `action:"down"` 传 `holdTicks`）显式拒绝 `CP-VALID-002`。

### 2.3 `input.mouse`

| 参数 | 必填 | 类型 | 口径 |
|---|---|---|---|
| `op` | 是 | `string` | `move` / `relative` / `down` / `up` / `click` / `wheel` |
| `x`, `y` | 仅 `move` | `number` | GUI 缩放坐标（§2.4） |
| `dx`, `dy` | 仅 `relative` | `number` | 世界视角增量（§2.5） |
| `button` | `down`/`up`/`click` | `int` | `0`/`1`/`2` = 左/右/中（LWJGL 编号，§2.6） |
| `amount` | 仅 `wheel` | `int` | 滚轮档位（§2.3 第 5 条） |
| `holdTicks` | 仅 `click` | `int` | `1..1200`，缺省 `1` |

逐 `op` 的必填与禁用表（传了禁用参数即 `CP-VALID-002`，逐字段给出理由）：

| `op` | 必填 | 禁止 |
|---|---|---|
| `move` | `x`,`y` | `dx`,`dy`,`button`,`amount`,`holdTicks` |
| `relative` | `dx`,`dy` | `x`,`y`,`button`,`amount`,`holdTicks` |
| `down` | `button` | `x`,`y`,`dx`,`dy`,`amount`,`holdTicks` |
| `up` | `button` | `x`,`y`,`dx`,`dy`,`amount`,`holdTicks` |
| `click` | `button` | `x`,`y`,`dx`,`dy`,`amount` |
| `wheel` | `amount` | `x`,`y`,`dx`,`dy`,`button`,`holdTicks` |

逐 op 语义：

1. `move`：把光标投递到目标 GUI 坐标，不做任何隐式副作用（不隐式移动鼠标、不隐式点按钮、不隐式滚轮）。
2. `relative`：投递世界视角增量（`Mouse.getDX/getDY` 口径）。消费门是 `mc.inGameHasFocus && Display.isActive()`，失焦时不承诺生效；需要确定性转视角请用 `player.look`。
3. `down`/`up`：投递按钮按下/抬起；`down` 进持键表（§3）。
4. `click`：同一 tick 内投递 `down` + `up`（等价 `holdTicks:1`；`holdTicks>1` 则抬起延后到第 N 个后续 tick）。`click` 不做隐式 `move`：要先 `move` 并等 ≥2 tick 再点。
5. `wheel`：只收非零整数档位，`0` 与越界值 `CP-VALID-002`；`|amount| > 8` 亦拒。方向符号由 `input.state.wheel.sign` 声明，`signVerified:false` 表示该口径尚未实机校准（§8）。
6. `input.mouse` 与 `input.key` 是两条独立队列，跨族没有全序保证（§4.3）。

### 2.4 `move` 的坐标口径

1. **入参固定为 GUI 缩放坐标**：原点左上、Y 向下，与 `GuiScreen.mouseClicked(mouseX, mouseY, …)` 同口径（`ScaledResolution` 下的 GUI 坐标）。不接受 framebuffer 像素、SDL 窗口坐标或任意屏幕比例。
2. **换算由设施完成**：`Mouse.addMoveEvent` 的输入是 SDL 窗口坐标（原点左下、Y 向上，乘 `Display.getPixelScaleFactor()`），而 GUI 输入读 `Mouse.getEventX/getEventY`（`eventY = displayHeight - sdlY`，Y 翻转一次、缩放一次）。
3. 换算参数全部由 `input.state.coordinates` 暴露（`scaledWidth`/`scaledHeight`/`displayWidth`/`displayHeight`/`pixelScale`/`yFlip`）；`move` 的返回值回读 `Mouse.getX/getY` 给出 `readback`，供调用方自校准。
4. **`move` 的成功定义只有一条**：`readback` 等于请求值（容差 ±1 的整数量化）。GUI 控件被命中不算 `move` 的成功。
5. **命中集与投递是两件事**：GUI 命中集每帧重建，位置来自 `Mouse.getX/getY`；冻结项为 `input.state.hitSet.minSettleTicks = 2`，即 `move` 后须等 ≥2 tick 再 `down`。单帧内「move + down」不承诺命中目标控件。
6. 注入点击的坐标来源是 `getEventX/getEventY`，而这两个值由 `addMoveEvent` 维护：不先 `move` 就点，点到的是上一次的位置。

### 2.5 相对与绝对

1. `move` 的 `x`/`y` 是绝对 GUI 坐标；`relative` 的 `dx`/`dy` 是相对世界视角增量。二者不可互换、不同时出现。
2. 返回值以字段名自证口径：`move` 回 `requested.space = "gui-scaled"` 与 `deliveredGeometry.space = "sdl-window"`；`relative` 回 `requested.space = "world-look-delta"`。
3. `delivered` 在全族恒为整数计数（写进队列的事件数）；`move` 的坐标回显放在并列的 `deliveredGeometry`（`{space, x, y, pixelScale, displayWidth, displayHeight}`）。

### 2.6 按钮编号

`button` 是 LWJGL 编号 `0/1/2`（左/右/中），不是 SDL 的 `1/2/3`。MC 侧把它当 LWJGL 按钮号使用（`j - 100` 映射到 `KeyBinding`；GUI 侧 `getEventButton()` 直接透传）。范围外取值（含负数与 ≥3）一律 `CP-VALID-002`。

### 2.7 拖动 / 组合键 / 顺序

| 概念 | 表示法 |
|---|---|
| 拖动 | 不新增 op：`down` →（≥1 tick 后）多次 `move` → `up` 的事件序列；中途 `move` 与起止按钮必须跨 tick |
| 组合键 | 修饰键先 `down`，主键 `down`/`up`，修饰键最后 `up`；只保证事件序，依赖 `Keyboard.isKeyDown` 轮询的修饰键判定不承诺 |
| 重复 | 不支持；连发用多次 `tap` |
| 顺序 | 单次请求内按调用方给出的顺序；同族跨请求为队列 FIFO（`Keyboard` 与 `Mouse` 各一条）；跨族无全序保证 |

「修饰键语义不承诺」这一条必须同时出现在 `input.state.pollSurface` 与 `input.key` 的自述里。

### 2.8 `input.text`

| 参数 | 必填 | 类型 | 口径 |
|---|---|---|---|
| `text` | 是 | `string` | 普通文本，逐字符投递（每字符一条事件，顺序即字符串顺序） |

1. **粒度冻结为逐字符**：不得把整串压成一条事件，也不得按单词或行聚合。
2. **字符范围是声明项**：`input.state.text.ranges` 给出闭区间码点表；该表必须反映实际支持的范围。
3. **不支持时显式失败**：请求中出现范围外字符 ⇒ 整条请求 `CP-VALID-002`，`context.fields` 逐字符给出 `{index, char, codepoint, reason}`；不得静默丢弃或替换字符。
4. **空串 ⇒ `CP-VALID-002`**。
5. **编码口径为 UTF-16 码元逐字符**；超出 BMP 的码点若不在声明范围内按上一条显式失败。
6. **能力未就绪时不得假装成功**：当 `text.route.world == false` 且 `text.route.gui == false` 时，任何非空请求一律 `CP-STATE-001`，不返回 `delivered:N` 的成功体。
7. **不得用文本直接改控件值**（不 `setText`、不直写文本框字段）——绕过 `keyTyped`、控件 filter 与光标逻辑等于替换被测对象。

### 2.9 不隐式穿透 GUI

1. 设施不改变 `currentScreen`、不调 `displayGuiScreen`、不调 `setIngameFocus`：「当前走哪条消费链」由游戏按 `currentScreen` 与 `allowUserInput` 决定。
2. 不做「强制世界路径」：不为让事件进 `KeyBinding` 而关界面或改 `allowUserInput`。
3. `input.state.consumer.chain` 报当前消费链（`gui` / `world` / `none`）。
4. 喂给错误的消费者是真实现象，设施如实报告，不静默重路由或重投。
5. 两条消费链都不查焦点（GUI 链的门是 `Mouse.isCreated()`/`Keyboard.isCreated()`，世界链的门是 `currentScreen == null || allowUserInput`），因此失焦不阻塞投递与消费；世界写后果仍受聚焦相关分支影响。

## 3. 生命周期

### 3.1 持键归属

1. 持键表归输入运行时所有，按作业（`jobId`）归属；条目为 `{kind:"key"|"button", id, jobId, heldSinceTick, expiresAtTick}`。
2. 作业收尾只释放本作业的条目；`input.release` 是全清（跨作业），用于驱动或人工清理。
3. `case.run` 内输入步产生的持键归属该 `case.run` 作业，完成、异常或超时统一释放。

### 3.2 有界期限

| 项 | 值 | 行为 |
|---|---|---|
| 单键/单按钮持有上限 | 1200 tick（`holdTicks ∈ [1,1200]`） | 越界 ⇒ 请求 `CP-VALID-002`；已投递的持有到期 ⇒ 设施自动投递抬起并在结果与事件里报 `autoReleased:[{kind,id,heldTicks,reason:"expired"}]` |
| 作业级上限 | 步进动作总超时 5 min / 阶段超时 3 min | 抛 `CP-EXEC-002`，走 §3.4 路径 3 |
| 时间单位 | tick 计数（名义 20 TPS） | 不用毫秒做持有期限；tick 计数不保证与墙钟成正比 |

任何进入持键表的条目必须有 `expiresAtTick`；`holdTicks` 上限与 `player.dig` 的 `MAX_HOLD_TICKS` 同值。

到期结算由既有 `ControlPlaneTickHandler` 每客户端 tick 调一次幂等的 `InputExpiryPump.tick()`（只调 `expireDue()`，不推进 `advanceTick()`），因此 `down` 这类「立即完成但刻意保留持键」的作业不会留下永久按下的键。

### 3.3 重复按下与重复释放

| 情形 | 语义 |
|---|---|
| `down` 一个已在持键表中的键 | 幂等成功：不重复投递第二条件按下事件，返回 `alreadyHeld:true` |
| `up` 一个不在持键表中的键 | 幂等成功：仍投递抬起事件，返回 `wasHeld:false` |
| `input.release`（无持有） | 幂等成功：`{count:0, alreadyIdle:true}`，不是错误 |
| `input.release`（有持有） | 逐条投递抬起，返回逐条明细 |
| 同一键 `tap` 后紧跟 `down` | 合法：`tap` 的抬起已投递并移出持键表 |
| 同一键同一 tick 内 `down` + `up` | 两条事件同 tick 投递，消费序即投递序；边沿型消费者（`KeyBinding.isPressed()`、快捷键）看得到，持续型消费者（移动输入）看不到 |

### 3.4 清理路径

| # | 路径 | 触发点 | 行为 | 承诺强度 |
|---|---|---|---|---|
| 1 | 正常完成 | 同步动作 `execute` 正常返回 / 步进动作 `advance` 返回非 null | 释放本作业全部持键；`action:"down"` / `op:"down"` 刻意保留该持有点 | 承诺（`down` 保留见左） |
| 2 | 动作异常 | `execute`/`advance` 抛异常 | 释放本作业持键 | 承诺 |
| 3 | 步进超时 | `checkTimeouts` 抛 `CP-EXEC-002` | 同上 | 承诺 |
| 4 | 显式 `input.release` | 调用方请求 | 立即全清（跨作业），幂等 | 承诺 |
| 5 | 进程正常退出 | JVM shutdown hook | 尽力投递抬起（`InputRuntimeImpl.releaseAllForShutdown()`） | 尽力 |
| — | 进程崩溃 | — | 状态随 JVM 消失 | 不承诺 |
| — | 离图 / 断连 / 关服（进程未退出） | — | 无可用钩子 | 不承诺 |
| — | 作业取消 | — | 无取消能力，该路径不存在 | 不存在 |

路径 5 的清理体由 `ControlPlaneBootstrap` 注册到 `ControlPlaneServer.runShutdownCleanup()`（整段吞异常、只 WARN 一次）；它必须走 `releaseAllForShutdown()`（同一份释放实现，只跳过 tick 线程断言），`releaseAll()` 跨线程仍然抛。清理体不得新增 `ClientTickEvent` 订阅者、不得抢线程、不得在主线程外碰 GL。

### 3.5 只清设施所持状态

释放只投递「设施自己投递过、且仍在持键表里」的抬起事件。不得调 `KeyBinding.unPressAllKeys()`/`unpressKey()`（那是进 GUI 的原版语义，会清掉真实用户状态）；不得 `Keyboard.eventQueue.clear()`，也不得清任何非本设施投递的事件；不得改 SDL 物理状态，因此释放后 `Keyboard.isKeyDown`/`Mouse.isButtonDown` 不受影响。

### 3.6 物理输入冲突

全链没有来源校验：任何能写这两个队列的进程内代码都等价于真实按键。因此：

1. 设施只写队列：不改 SDL 物理状态、不抢焦点、不改 `displayFocused`、不改 `pauseOnLostFocus`、不调 §1.2 的禁用入口。
2. 与真实物理输入不仲裁、不屏蔽：同一 tick 内两类事件在同一队列里按到达序混合消费，设施不区分、不重投。
3. 冲突必须如实报告：返回值带 `physicalConcurrent`。键盘侧可判（`Keyboard.getNumKeyboardEvents()` 是公开深度探针，seed 基线为 1）；鼠标侧无公开探针，只能报 `"unobservable"`，不得编造 `false`。
4. 持有键与游戏内绑定态不一致时必须报告：`input.state.held[].gameBindingPressed` 回读对应 `KeyBinding` 的 `pressed`；不得「检测到不一致就重新投递」。

## 4. 执行语义

### 4.1 四个可观测边界

| 边界 | 定义 | 判据 | 谁能证明 |
|---|---|---|---|
| 受理 | 通过鉴权、授权、`confirm`、参数校验并进入队列 | HTTP 200（同步）或 202 + `jobId`；作业态 `queued` | 调用方 |
| 排队 | `JobQueue.submit` 成功 | 作业态 `queued`；互斥下再提交得 `CP-BUSY-001` | 调用方 |
| 已投递 | 事件已写入 `Keyboard.eventQueue` / `Mouse.queue` | 键盘侧：`getNumKeyboardEvents()` 深度增量等于投递数；鼠标侧无公开探针，只能由设施记账，须标注「不可独立复核」 | 设施（键盘侧可复核） |
| 已处理 | 下一个 `runTick` 把事件交给消费者之后 | 键盘侧：队列深度回落到 seed 基线 | 只有独立读面能证 |

**投递成功不等于业务成功**：`delivered` 的语义仅是「写进队列的事件数」；「消费者是否处理」必须由独立观察面取得。返回值不出现 `observed`/`success` 这类业务断言；`consumed` 只能是 `null` + 说明文本。

### 4.2 注入点与消费时刻

1. 投递发生在客户端 `TickEvent.ClientTickEvent` 的 `Phase.END`。
2. `runTick` 的输入分派段在本 tick 内早于 END 阶段，因此在 tick N 的 END 投递的事件只能在 tick N+1 的 `runTick` 输入段被消费。下游不得假设同 tick 生效。
3. 设施不新增 `ClientTickEvent` 订阅者；推进由步进动作的每 tick `advance` 承担。

### 4.3 时间单位与顺序

1. 时间单位是 tick（`holdTicks`、`deliveredAtTick`、`expiresAtTick`、`minSettleTicks` 均为 tick 计数）。
2. 顺序：单次请求内按调用方给出的顺序；同族跨请求为队列 FIFO；跨族（键与鼠标）无全序保证。
3. 「先 move 再 down」「先 down 修饰键再 down 主键」这类跨阶段意图必须用 `holdTicks`、分次调用或至少 1 tick 间隔表达；位置类的间隔下限是 2 tick。

### 4.4 完成屏障

1. 动作的完成 = 事件已投递，且 `delivered` 等于实际投递条数。条数不等于请求数 ⇒ 逐条给 `rejected` 并整条请求失败，不得部分成功仍报为通过。「实际投递」是扣除被幂等抑制者之后的条数（重复 `down` 抑制由 `alreadyHeld`/`wasHeld` 单列）。因此判定口径是：成功当且仅当请求的每一条事件都「投递了或被幂等抑制」，且没有一条被 `rejected`。
2. 没有「等消费者处理完」的屏障；需要跨 tick 收敛的调用方必须显式表达（`holdTicks` + 独立读面 + `criteria`）。
3. 队列满（`Keyboard.eventQueue` 容量 256）⇒ `CP-STATE-001`，`context` 带 `queue`/`depth`/`capacity`。`addRawKeyEvent` 对队列满静默丢事件，因此设施必须先探深度（`getNumKeyboardEvents()`），不依赖底层报错。

### 4.5 HTTP 超时不取消作业

`?sync=true&timeoutMs=N` 超时返回 HTTP 202 + `{jobId, timedOut:true}`，作业继续执行（`contract.md` §3.1）。调用方不得把同步等待超时理解为输入已停止：持键仍在，须显式 `input.release` 或等本作业收尾才释放。本族不新增取消端点。

## 5. 错误语义

本族不新增错误码，复用四个：

| 码 | HTTP | 用法 |
|---|---|---|
| `CP-VALID-002` | 400 | 参数、取值、不适用字段、字符范围外、键位未注册、滚轮零档或越界；`context.fields` 逐字段（字符类逐字符） |
| `CP-STATE-001` | 409 | 前置状态不满足：能力未就绪、队列满、`faulted` 态下的请求 |
| `CP-EXEC-002` | 504 | 步进动作超时（`holdTicks` 跨 tick 推进被总/阶段超时打断）；`context` 带 `stage`/`stageElapsedMs` |
| `CP-CONFIRM-001` | 400 | 可写动作缺 `"confirm": true`（`input.state` 是 `observe`，不要求） |

「投递成功但没生效」不是错误（由 `consumer` 与独立读面判读）；「队列满」与「能力未就绪」同属前置状态不满足。

## 6. 能力发现：`input.state`

`input.state` 是 `observe` 级同步动作，一次调用返回快照；快照必须在客户端 tick 线程取。它是本族唯一的能力声明口：任何「本族能不能做 X」的答案只能来自它的字段。

| 字段 | 类型 | 语义 |
|---|---|---|
| `implemented` | bool | 本族是否已实现（注册完成即 `true`）；`false` 时各能力字段必须自洽 |
| `state` | string 或 null | 状态机当前态 `idle`/`holding`/`releasing`/`faulted`；读不到时 `null` + `stateNote` |
| `family` | string | 恒 `"input"` |
| `means` | string | 恒 `"input"`（手段归因，§9 第 3 条） |
| `runtime` | object | `{mc, forge, lwjgl3ify, backend, injectors[], contractVersion}`；`injectors` 只列实际解析成功的入口名 |
| `actions` | array | 已注册的输入动作名；`implemented:false` 时为空数组 |
| `keyCatalog` | object | 键位目录 `{name → keyCode}`，运行期注册表实读 |
| `keyCodeRange` | `[int,int]` 或 null | 合法 LWJGL 键码闭区间；`null` 表示读不到，此时 `notImplemented` 追加说明 |
| `pollSurface` | string | 轮询面不受本族影响的说明 |
| `text` | object | `{supported, ranges:[{from,to}], delivery:"per-character", unsupportedBehavior:"explicit-fail", route:{world, gui, verified, note?}}` |
| `coordinates` | object | `{space, scaledWidth, scaledHeight, displayWidth, displayHeight, pixelScale, yFlip, selfCalibrated, selfCalibratedNote?, selfCalibration{...}}`；`selfCalibrated` 与 `input.mouse` 的 `move` 回读结论是同一个量，尚无 `move` 时为 `false` 并附说明 |
| `wheel` | object | `{unit:"notch", integerOnly:true, sign:"positive=backward", amountMax:8, signVerified:false, signNote}` |
| `consumer` | object | `{chain:"gui"|"world"|"none", currentScreen, allowUserInput, displayActive, inGameHasFocus, captureArmed}`；`chain` 读不到时 `null` + `chainNote` |
| `hitSet` | object | `{minSettleTicks:2, note}` |
| `queues` | object | `{keyboardDepth, keyboardSeedBaseline:1, keyboardCapacity:256, mouseDepth:"unobservable", deliveredThisJob, deliveredThisSession}` |
| `held` | object | `{count, items:[{kind, id, jobId, heldTicks, expiresInTicks, gameBindingPressed}]}` |
| `physical` | object | `{concurrent, mouseConcurrent, keyboardProbe, keyboardSeedBaseline, reason, mouseNote}`；鼠标侧恒 `"unobservable"` |
| `lifecycle` | object | `{cleanupPaths:[{id, strength:"promised"|"best-effort"}], crash:"not-promised", worldUnload:"no-hook", cancel:"unavailable"}` |
| `limits` | object | `{holdTicksMax:1200, wheelAmountMax:8, minSettleTicks:2}` |
| `capabilities` | object | 契约常量声明：`{requiresConfirm:false, tier:"observe", consumerChainReadOwner, hitSetOwner, rollback:"none", wheelSignCalibration:"pending-machine-check", pollSurfaceCovered:false}` |
| `thread` | object | 快照所在线程：`{snapshotThread, requiredThread:"client-tick", verified, note?}` |
| `errors` | array | 本族会返回的错误码清单（4 条，§5），不含 `CP-VALID-001` |
| `notImplemented` | array | 已冻结但未实现或未验证的项（§8），再追加本次探针读不到才知道的动态缺口；去重、保序 |
| `warnings` | array | 仅非空时出现：探针自身的诊断 |

字段只增不改；`implemented:false` 时 `actions` 为空数组、`keyCatalog` 为空对象、`text.ranges` 为空、`held.count` 为 0、`notImplemented` 非空，不用默认值把未知伪装成「已具备但当前为 0」。

## 7. 状态机

输入运行时是每进程唯一的单实例状态机；持有条目按作业归属。表中「必须显式失败」的情形一律 `CP-STATE-001`（`input.state` 的线程失败形态在 `context.state` 给出当前态），不得静默 no-op。

| 当前态 | 触发 | 允许的迁移 | 不允许的迁移 |
|---|---|---|---|
| `idle` | `input.key`（`down`/`up`/`tap`）、`input.mouse`（`down`/`click`）、`input.text` | → `holding`（产生持有点）或留在 `idle`（纯 `up`/`move`/`wheel`/`text`） | — |
| `idle` | `input.release` | 留在 `idle`（幂等成功，`alreadyIdle:true`） | — |
| `idle` | `input.state` | 留在 `idle`（只读） | — |
| `holding` | 再次 `down` 同一键或按钮 | 留在 `holding`（`alreadyHeld:true`） | — |
| `holding` | `down` 另一个键或按钮 | 留在 `holding`（持有点 +1） | — |
| `holding` | `input.release` | → `releasing` → `idle` | — |
| `holding` | 作业正常完成 | → `releasing` → `idle`（路径 1） | — |
| `holding` | 作业异常 | → `releasing` → `idle`（路径 2） | — |
| `holding` | 步进超时 | → `releasing` → `idle`（路径 3） | — |
| `holding` | 单键 `holdTicks` 到期 | 还有持有点则留在 `holding` 并报 `autoReleased`；最后一个到期则 → `releasing` → `idle` | — |
| `holding` | 持有条目无 `expiresAtTick`（实现缺陷） | — | 立即 `faulted`（无期限持有被禁止） |
| `holding` | `input.state` | 留在 `holding`（只读） | — |
| `holding` | 进程正常退出 | → 进程终止（路径 5，尽力） | — |
| `holding` | 进程崩溃 / 离图（进程未退出） / 作业取消 | — | 不承诺；无钩子；无该触发 |
| `releasing` | 新触发（任何 `input.*`） | 一 tick 内完成并落到 `idle` | 该态只在一 tick 内存在，外部请求到不了；若内部缺陷导致到达 ⇒ `CP-STATE-001` |
| `releasing` | 投递抬起失败（队列满等） | → `faulted` | 不得静默留在 `releasing` |
| `faulted` | `input.release` | → `idle`（无条件复位，接受丢事件） | — |
| `faulted` | 其它任何 `input.*` 请求 | — | 必须显式失败 `CP-STATE-001`（`context.state:"faulted"` + `reason` + 已释放明细） |
| `faulted` | `input.state` | 留在 `faulted`（只读，须报 `state:"faulted"`） | — |
| 任意态 | 队列深度与自身记账不一致，且差值无法由本设施或真实输入解释 | → `faulted` | 不自动重投 |

状态定义：`idle` = 持键表为空且无未决投递；`holding` = 持键表非空；`releasing` = 正在投递抬起事件（瞬态）；`faulted` = 设施所持状态与实际队列不一致。进入 `faulted` 必须发一条事件流水。

当前机读落点：`input.state` 的成功体必报顶层 `state`；`input.state` 的线程失败形态在 `context.state` 给出当前态。投递类失败信封里当前态只出现在 `context.hint` 的文本中，没有单列的 `context.state` 字段。

## 8. 未实现与不承诺项

以下 13 项已冻结但未实现或未验证，不得当作已具备：

| # | 项 |
|---|---|
| 1 | GUI 文本路由未打通：`addCharEvent` 与键事件自带 `codepoint` 两条都未到达 ⇒ `input.text` 的 `supported:false`、`route:{world:false,gui:false}`，任何非空请求 `CP-STATE-001` |
| 2 | `input.key` 的 `codepoint` 通路未验证（只有键位那一半被实机证过） |
| 3 | 鼠标侧无队列深度公开探针 ⇒ 鼠标的「已投递」不可独立复核，`physicalConcurrent` 鼠标侧只能 `"unobservable"` |
| 4 | 无取消能力（`core` 层无 `cancel`、端点表无取消端点） |
| 5 | 无世界卸载/断连/关服钩子 ⇒ 离图不触发释放，契约不承诺 |
| 6 | 不承诺崩溃后清理 |
| 7 | 轮询面不覆盖，组合键只保证事件序 |
| 8 | `input.mouse op:relative` 的失焦生效未验证 |
| 9 | 坐标换算的自校准只覆盖两种窗口/尺度上下文；`Display.getPixelScaleFactor` 读不到时回落为 `1.0` 并进 `warnings`，HiDPI 真实像素缩放未单独校准 |
| 10 | 无 `read.input` 读面：注入是否生效缺第二观测面（`input.state` 是能力面，不是业务读面） |
| 11 | 场景守卫 armed 期间每 tick `displayGuiScreen(null)` 会关掉聊天框一类界面 |
| 12 | 组合键事件序的严格全序只由队列 FIFO 结构性声明承担；队列满的 `CP-STATE-001` 容量预检在公开动作面上不可触达（单作业每 tick 最多投一条），该码存在但调用方观测不到 |
| 13 | 滚轮符号口径未实机校准（`input.state.wheel.signVerified:false`），不得据 `sign` 下方向判据 |

本清单与 `input.state.notImplemented` 同源（机读真值来源是 `InputCapabilities.NOT_IMPLEMENTED`）：实现一项就同时删除两处，条数由 `InputCapabilitiesDocParityTest` 强制相等。

不在本接口范围且不预留参数：IME/组合输入/预编辑串、剪贴板、手柄与触摸、多客户端并发、作业取消语义、离图清理语义。

## 9. 与 L0/L1/L2 的关系

1. **两个维度**：`contract.md` 的 L0/L1/L2 回答「谁做、经由什么能力面做」；本族的输入手段回答「谁把事件放进游戏」。二者正交：L0/L1/L2 是能力面，输入手段是投递面。「用输入手段驱动世界」不产生 L1 结论。
2. **三个层级的断言分别标注**：输入成功（`delivered` + `consumer.chain` + 队列深度回落）不能证明世界变化；操作目标正确由独立读面判定；流程成立只有 L2（`case.run` + `criteria`）可以宣称。三者的结论不互替。
3. **`means` 归因**：本族所有返回值带 `means:"input"`，与 `layer`、`semantics` 并列而非替代。本族不携带 `layer` 字段（值恒 `null`）：`layer` 的取值域是 L0/L1/L2，输入手段不属于其中任何一层，`contract.md` §7.7 的「`layer` 与 `semantics` 成对」在此登记为显式例外。
4. **与 `player.*` 的关系是补集**：`player.*` 直接走 `PlayerControllerMP`/`NetHandler`，其范围外正是 GUI 内非槽位按钮点击；输入手段补这条缺口，不是 `player.*` 的替代品。同一件事用两条手段做时必须分层标注、结论不互替。
