# 输入手段契约（`input.*` 动作族，接口冻结）

> 本文是**通用玩家输入设施**的接口冻结件（Gitea #162 / T1）。下游 **T2-A（运行时）**、
> **T2-B（观察）**、**T3（集成）** 三方并行工作以本文为**唯一依据**；任何一方不得单方面改本文冻结的形状。
>
> **与 `contract.md` 的分工**：`contract.md` 仍是控制面**权威契约**（端点、动作模型、错误码、权限、
> 线程与边界、L0/L1/L2 能力面）。本文只冻结**输入手段族**的接口形状与规则，**不并入** `contract.md`
> ——后者已 800+ 行，且输入族触及的共享文件（`ActionRegistrar` / `ActionDescriptor` / `CaseRunAction` /
> `CaseValidator`）与动作计数、契约版本两道机械断言直接耦合，混排会让「哪条规则改了哪个断言」不可审。
> 实现合并时：`contract.md` §4 新增一节（候选 `§4.12 输入手段族`）并同步动作计数，`case-file.md` §3.2
> 按 §9.2 改写同步性口径，本文随之降级为**实现说明的引用件**。
>
> **状态（v1.8 起：已实现、已注册；下列历史段落保留以免「当时的判据」被抹掉）**：
> 本文冻结的五个动作**已注册**（`GET /cp/v1/actions` 的 `count` = **48**），`contractVersion` = **1.8**，
> 五个动作的 `since` 均写实为 `1.8`。实现合并在 Gitea #165，注册与计数同步见 §1.4。
> 文末 §11.2 是**仍未实现/未验证**的清单（逐条，已按本批删除已完成项）。
> 本文现在同时是**实现说明的引用件**（`contract.md` §4.12 指向它）。
>
> **历史记录（T1 冻结时的形态，勿删）**：冻结时五个动作全部未实现——未注册、无描述符，
> `count` 为 `43`、`contractVersion` 为 `1.7`；当时仓里有两道机械断言（`ReadCaptureOfflineTest` 断言总数、
> 并断言 `contractVersion >= 每个动作的 since`），因此 T1 若写入 `since` 或宣称已实现会当场判红，
> 故全文 `since` 当时一律写「**实现合并时前进（候选 `1.8`）**」。
>
> **标注法**：`【实测】` = P0 已实机证实或源码逐行可证（不重复推导过程）；`【要求】` = 本契约对实现的
> **义务**（可实现性由 T2 自证）；`【未实现】` = 本单冻结但未实现/未验证；`【禁令】` = 明令禁止的做法。
> 本文只写结论性规则，不写研究过程。

---

## 1. 范围与版本限定

### 1.1 覆盖的运行期（超出即不受本契约保护）

| 项 | 值 | 说明 |
|---|---|---|
| Minecraft | **1.7.10** | 输入分派行号、KeyBinding 语义、GUI 路由全按此版本 |
| Forge | **10.13.4.1614** | 决定 `InputEvent` / `GuiScreenEvent` 的可用面 |
| lwjgl3ify | **3.0.8** | 运行期实载版本（非本地源码的 3.0.25）；`org.lwjgl.input.*` 被重定向为 `org.lwjglx.input.*` |
| 输入后端 | **SDL**（`lwjgl-sdl:3.4.0`） | **不是 GLFW**；不存在 `glfwSetKeyCallback` 一类入口（零命中） |
| 注入所在 | 客户端 **tick 线程**（1.7.10 单机即渲染线程） | 与 `contract.md` §1.8 / §9 的线程纪律同源 |

`【要求】` 上述任一项变动（换 MC 版本、换 lwjgl3ify 版本、换后端、模组包变更）都必须重跑 §11.2
的未实现/未验证清单里标注为「实机判据」的项，**不得**沿用本文的能力声明。

### 1.2 唯一允许的注入面（白名单，逐条）

`【实测】` 以下五个方法是本契约**全部**允许的写入口；它们只写 Java 侧队列/数组，**不调用任何 SDL 函数**，
因而不动用户桌面的鼠标、不抢焦点：

| 入口 | 承载的动作参数 |
|---|---|
| `org.lwjglx.input.Keyboard.addRawKeyEvent(Keyboard.KeyEvent)` | `input.key`（含同一事件自带 `codepoint`） |
| `org.lwjglx.input.Keyboard.addCharEvent(int key, int c)` | `input.text`（纯字符事件） |
| `org.lwjglx.input.Mouse.addMoveEvent(SDL_MouseMotionEvent)` | `input.mouse` 的 `move`（位置）与 `relative`（世界视角增量） |
| `org.lwjglx.input.Mouse.addButtonEvent(int button, boolean down)` | `input.mouse` 的 `down`/`up`/`click` |
| `org.lwjglx.input.Mouse.addWheelEvent(double delta)` | `input.mouse` 的 `wheel` |

`【禁令】` 下列入口**一律不得调用**，理由逐条落在代码注释与 review checklist 上：

| 禁用的入口/做法 | 理由 |
|---|---|
| `Mouse.setGrabbed(boolean)` | 走 `SDL_WarpMouseInWindow` + `SDL_SetWindowRelativeMouseMode`：真实抓取系统光标、切换相对模式 |
| `Mouse.setCursorPosition(int,int)` | 走 `SDL_WarpMouseInWindow`：**真的搬动用户桌面光标** |
| `Mouse.setNativeCursor` / `setCursorIcon` | 走 `SDL_CreateSystemCursor` / `SDL_SetCursor`：改系统光标 |
| 直写 `Keyboard.sdlKeyPressedArray` | 该指针是 SDL 内部 keystate 数组，每帧 `SDL_PumpEvents` 按 SDL 自身状态重填，**存活 < 1 帧**（实测无效） |
| 直写 `Mouse.sdlMouseButtonFlags` | 每轮 pump 用 `nSDL_GetMouseState` 整体覆写（实测无效） |
| 直写 `Keyboard.eventQueue`（含 `clear()`） | 绕过 REPEAT 过滤与调试日志，语义与真实按键不一致；`clear()` 会清掉静态 seed 哨兵 ⇒ 此后 `getEventKey()/getEventCharacter()/isRepeatEvent()` 全部对 `peek()` 解引用 **NPE** |
| 自行 `Mouse.next()` 排空队列 | 会与游戏抢占同一队列（先手赢），让游戏看不到这些事件 |
| 单独使用 `InputEvents.injectKeyEvent/injectTextEvent` | **不进** vanilla 队列，只到 `KeyboardListener` 与实现该接口的 `currentScreen`；真实按键是「两路都发」，只发这一路 ≠ 真按键 |
| 反射改写 `Display.displayFocused` / 强制 `Display.isActive()` | 那是**开关**不是注入：会连带改掉失焦暂停菜单与全屏自动退出行为 |
| 绕过 `GuiScreen.handleInput` 的旁路（如直调 MUI2 的 `ClientScreenHandler.getMuiScreen()` → `updateState` → `onMousePressed`） | 绕过 MUI2 自己的 `MouseInputEvent`/`KeyboardInputEvent` 与 `Input` 记账；**不算通用输入手段**，本期不进契约面 |

`【要求】` 编译可见性由 T2-A 自证：lwjgl3ify 的 `-api` 制品**不含** `org/lwjglx/**`（只在运行期 `-dev` jar 里），
且 RFB 重定向**只改类名不改方法名**（写 `org.lwjgl.input.Keyboard.addRawKeyEvent` 编译不过）。
**推荐 `Class.forName("org.lwjglx.input.Keyboard")` + 反射**（字符串字面量不被 RFB 重映射），
或新增 `compileOnly` 的 lwjgl3ify `dev` 依赖——二者取一，由 T2-A 决定并在实现里注明。

### 1.3 能力定位：**不承诺**对任意未来模组永久完备

`【实测】` 1.7.10 + 本模组包存在**结构性断点**，通用输入手段**不可能**全部覆盖，因此本族的能力定位是
「**到达游戏自己的路由 + 如实报告边界**」，不是「任何界面/任何模组都能驱动」。已实测的断点（不逐条复述机理）：

1. `Keyboard.isKeyDown` / `Mouse.isButtonDown` 这类**轮询面**不读事件队列（读 SDL 物理数组）⇒ 队列注入不改变它们；
2. GUI 存活期 `KeyBinding.pressed` 恒 `false`（进 GUI 即 `unPressAllKeys()`，且世界闸门不成立）；
3. 1.7.10 Forge **没有** `GuiScreenEvent.KeyboardInputEvent` / `MouseInputEvent`（那是 MUI2 自造的类）；
4. 模组 GUI 的**命中集每帧重建**且位置来自 `Mouse.getX/getY` ⇒ 位置与按下必须**跨帧**；
5. 模组自定义输入事件只在**它自己的** `GuiScreen.handleInput` mixin 里 post ⇒ 绕开这条路彻底没反应。

`【要求】` 每条断点都必须在 `input.state` 里有机读落点（§5），且新发现的断点必须**补进 §11.2**，
不得只写在本文件之外。

### 1.4 与契约版本的关系

1. `【已履行】` 本族五个动作的 `since` 写实为 **`1.8`**（Gitea #165），且与 `contractVersion` 前进**同批**——
   原来的写法是「只能写『实现合并时前进（候选 `1.8`）』，写入具体版本号的动作在 `contractVersion` 同步前进
   之前一律不许合并」（否则动作计数与版本单调两道断言红）。
2. `【已履行】` 实现合并那一次提交**同时**改了：`ActionRegistrar` 的计数注释（「43 个」→「48 个」字面）、
   `contract.md` §4 的计数与新增小节（§4.12）、**两处**动作计数断言
   （`ReadCaptureOfflineTest` 与 `InputCapabilitiesTest`）、`Contract.VERSION`（1.7→1.8）。
   <b>注意 T1 原文只列了三处</b>（漏了 `InputCapabilitiesTest` 的动作计数与 `ACTIONS_REGISTERED` 断言），
   本批据实补上——照 T1 原文改会漏一处而当场红。
3. `【要求】` 版本按字符串/浮点比较 ⇒ 禁止出现 `1.10` 这类值（会排到 `1.6` 之前）。

### 1.5 不承诺清单（本期范围外，逐条）

1. **GUI 文本路由**：【未实现】P0 实测未打通（`GuiChat.fieldText` 可读且为空，`addCharEvent` 与
   「键事件自带 codepoint」两条都没到达）。`input.text` 的能力声明必须如实为空（§2.9）。
2. **IME / 组合输入 / 预编辑串**：本期不做，也不预留参数。
3. **剪贴板**（粘贴/复制）：本期不做。
4. **手柄 / 触摸**：本期不做。
5. **多客户端并发**（多 token、多实例）：本期不做；本族的持键表按进程内单实例建模。
6. **轮询面**（`Keyboard.isKeyDown` / `Mouse.isButtonDown` / `GameSettings.isKeyDown`）：见 §2.10。
7. **「输入手段」以外的自动化链**：`contract.md` §9 已定「控制面是唯一驱动世界的自动化」，
   本族不新增任何 tick 订阅者（§9.3），因此没有「与别的链争 tick」的情形。

---

## 2. 输入表示

### 2.0 全篇地基：游戏侧有**两套互不相通**的输入状态

`【实测】`

| 面 | 载体 | 谁读它 | 队列注入能否影响 |
|---|---|---|---|
| **事件队列面** | `Keyboard.eventQueue`（容量 256，静态 seed 一条 RELEASE）、`Mouse.queue`（环形，容量 128） | `Keyboard.next()/getEvent*`、`Mouse.next()/getEvent*`：GUI 回调链、`KeyBinding` 更新链、`KeyInputEvent`/`MouseInputEvent`、Forge `MouseEvent` | **能** |
| **物理轮询面** | `Keyboard.sdlKeyPressedArray`、`Mouse.sdlMouseButtonFlags` | `Keyboard.isKeyDown`、`Mouse.isButtonDown`、`GameSettings.isKeyDown`（修饰键、Shift 点击、NEI 快捷键、MUI `Interactable`） | **不能**（每帧被 SDL 覆写） |

`【要求】` 本契约只覆盖**事件队列面**。因此：

1. 任何依赖轮询面的语义（Shift/Ctrl/Alt 组合、`GuiContainer` 的 Shift 点击、NEI 自建按键状态机、
   `SyncedKeybind`）**不在承诺范围**，必须在 `input.state` 的 `pollSurface` 字段如实标注；
2. `【禁令】` 不得为了「让轮询面也生效」去写那两个 SDL 字段——实测存活 <1 帧，且属于 §1.2 的禁令表；
3. 「组合键」的冻结语义因此是**事件序**而非**修饰键态**（§2.8）。

### 2.1 键位与字符**分离**建模

`【要求】` 两条独立入口，**不得互相代替**：

| 入口 | 语义 | 用在 |
|---|---|---|
| `input.key` + 可选 `codepoint` | 一个**键事件**，可选地**自带**一个已提交字符 | 「按键即字符」的路径（GUI 的 `keyTyped(char,int)` 同时拿到字符与键码） |
| `input.text` | **纯字符**事件序列（逐字符一条） | 普通文本（与键位无关的字符流） |

理由：1.7.10 侧这是两个不同的数据源（事件自带的 `getEventCharacter()` vs `addCharEvent` 的字符），
真实按键是**两路都发**。合并成一个入口会让「只到位一路」不可判别。

`【要求】` 哪一条真正到达消费者**必须由实机判定**并在 `input.state.text.route` 声明；
本单：`world:false`、`gui:false`（§11.2 第 4 条）。

### 2.2 `input.key` 的参数

| 参数 | 必填 | 类型 | 口径 |
|---|---|---|---|
| `key` | ✅ | `string \| int` | **键位标识**：`string` 形态 = 游戏键位描述名（如 `key.forward`、`key.sneak`）；`int` 形态 = **LWJGL 键码**（不是 SDL scancode） |
| `action` | ✅ | `string` | 只许 `down` / `up` / `tap`（取值域外一律 `CP-VALID-002`） |
| `holdTicks` | ❌ | `int` | **仅 `action:"tap"` 允许**；`1..1200`（与 `player.dig` 的 `MAX_HOLD_TICKS` 同口径，避免同一动作面出现两套上界）；缺省 `1` |
| `codepoint` | ❌ | `int` | 本事件自带的已提交字符（Unicode 码点）；`0..0xFFFF`；**缺省 `0` = 本事件不携带字符** |

`【要求】`：

1. **键位标识的权威来源是运行期键位注册表**（`GameSettings` 的 KeyBinding 描述名），
   不是本文手抄的清单。`input.state.keyCatalog` 必须给出完整目录（名 → 键码），调用方以它为准。
   本文示例里出现的名字（`key.forward` 等）只是**实测用过**的两个（`key.forward`、`key.sneak`），
   不构成清单。
2. **未知键位标识 / 键码越域 ⇒ `CP-VALID-002`**，`context.fields` 逐字段说明，
   `context.registered` 给出完整键位目录（不得只报「未知」）。
3. 键码域由 `input.state.keyCodeRange` 给出（本单候选 `[0, 255]`；实现时必须由运行期
   `Keyboard.KEY_*` 全集校验后写死，不得靠猜）。
4. **`【实测】` 的构造器陷阱是实现的义务**：`Keyboard.KeyEvent` 的 `key` 字段对
   `KEY_ESCAPE/HOME/NUMLOCK/CAPITAL/SCROLL/LCONTROL/LSHIFT/LMETA/LMENU/RCONTROL/RSHIFT/RMETA/RMENU`
   会改用 `keyNonScancode`。`【要求】` 设施**必须保证**投递后 `Keyboard.getEventKey()` 等于调用方给的
   `key`（对这些键给两个参数同值）；该等价性是**实现的义务，不是调用方的义务**——调用方不需要知道这条。
5. `【要求】` **重复按键（REPEAT）本期不支持**：不提供任何 REQUEST/repeat 参数。理由：3.0.8 的
   `addRawKeyEvent` 过滤 REPEAT 且 `INPUT_ALWAYS_REPEAT_KEYS` 该版本不存在（常量池零命中）；
   1.7.10 的 `KeyBinding` 通路也不看 repeat。需要连发请用多次 `tap`。
6. **`input.key` 是步进动作**（工厂注册）：`action:"tap"` 的 `holdTicks` 天然跨 tick。
   不适用字段（如 `action:"down"` 传 `holdTicks`）**必须显式拒绝** `CP-VALID-002`，
   不许静默忽略——「不适用字段静默忽略」是本仓已定的失效模式。

### 2.3 `input.mouse` 的参数与逐 `op` 适用面

| 参数 | 必填 | 类型 | 口径 |
|---|---|---|---|
| `op` | ✅ | `string` | `move` / `relative` / `down` / `up` / `click` / `wheel` |
| `x`, `y` | 仅 `move` | `number` | **GUI 缩放坐标**（见 §2.4） |
| `dx`, `dy` | 仅 `relative` | `number` | 世界视角增量（见 §2.5） |
| `button` | `down`/`up`/`click` | `int` | `0`/`1`/`2` = 左/右/中（**LWJGL 编号**，见 §2.6） |
| `amount` | 仅 `wheel` | `int` | 滚轮档位（见 §2.7） |
| `holdTicks` | 仅 `click` | `int` | `1..1200`，缺省 `1` |

`【要求】` **逐 op 的必填/禁用表**（传了禁用参数即 `CP-VALID-002`，逐字段给出理由）：

| `op` | 必填 | 禁止（传了即拒） |
|---|---|---|
| `move` | `x`,`y` | `dx`,`dy`,`button`,`amount`,`holdTicks` |
| `relative` | `dx`,`dy` | `x`,`y`,`button`,`amount`,`holdTicks` |
| `down` | `button` | `x`,`y`,`dx`,`dy`,`amount`,`holdTicks` |
| `up` | `button` | `x`,`y`,`dx`,`dy`,`amount`,`holdTicks` |
| `click` | `button` | `x`,`y`,`dx`,`dy`,`amount` |
| `wheel` | `amount` | `x`,`y`,`dx`,`dy`,`button`,`holdTicks` |

`【要求】` 逐 op 语义：

1. `move`：把光标投递到目标 GUI 坐标。**不**做任何隐式的坐标/按钮/滚轮副作用（一次动作一件事）。
2. `relative`：投递世界视角增量（`Mouse.getDX/getDY` 口径）。其**消费门**是
   `mc.inGameHasFocus && Display.isActive()` ⇒ **失焦时不承诺生效**，而无人值守的常态正是失焦
   （P0 全程 `Display.isActive()=False`）。`input.state` 必须如实报 `displayActive`；
   需要「确定性转视角」请用现有的 `player.look`，不要靠本 op（§10 第 1 条）。
3. `down`/`up`：投递按钮按下/抬起。`down` 进持键表（§3）。
4. `click`：**同一 tick 内**投递 `down` + `up`（等价 `holdTicks:1`，`holdTicks>1` 则抬起延后到第 N 个后续 tick）。
   `【要求】` `click` **不做隐式 move**——要点头部必须先 `move` 并**等 ≥2 tick**（§2.4）。
5. `wheel`：投递滚轮档位。`【实测】` 生产者侧是**累积取整**（`<1` 的 delta 可能完全不产出事件）⇒
   冻结为**只收整数**，非整数一律 `CP-VALID-002`。方向口径 = MC 的 `getEventDWheel` 语义（正档 =
   原版「向后/向下」的同一符号），**不**定义「向上为正」这类直觉口径。`【实测】` 业务后果不承诺：
   Angelica 的 zoom 键按下时会把滚轮值改成 0 转给 zoom ⇒ 事件投递成功 ≠ 物品栏/界面响应。
6. `input.mouse` 与 `input.key` 是**独立队列**：跨族**没有**全序保证（§4.3）。

### 2.4 `move` 的坐标口径（由设施换算，调用方不猜）

`【要求】`：

1. **入参口径固定为 GUI 缩放坐标**：原点左上、Y 向下，与 `GuiScreen.mouseClicked(mouseX, mouseY, ...)`
   收到的坐标同口径（即 `ScaledResolution` 下的 GUI 坐标）。**不接受** framebuffer 像素、
   **不接受** SDL 窗口坐标、**不接受**任意「屏幕比例」。
2. **换算由设施完成**。`【实测】` 底层 `Mouse.addMoveEvent` 吃的是 **SDL 窗口坐标**（原点左下、Y 向上，
   且乘 `Display.getPixelScaleFactor()`），而 GUI 输入用的是 `Mouse.getEventX/getEventY`（Y 由
   `height - eventY*height/displayHeight - 1` 换算）⇒ 存在一次 Y 翻转与一次缩放。
   P0 实机定案：注入 SDL `(426,322)` ⇒ 实读事件 `(426,158)`（该次 `displayHeight=480`），
   即 `eventY = displayHeight - sdlY`。
3. `【要求】` 换算的**全部参数必须由 `input.state` 暴露**（`coordinates` 对象：`scaledWidth/scaledHeight/
   displayWidth/displayHeight/pixelScale/yFlip`），并且 `move` 的返回值必须**回读** `Mouse.getX/getY`
   给出 `readback`，使调用方可以自己核对换算（自校准）。
4. `【要求】` `move` 的**成功定义**只有一条：`readback` 等于请求值（容许 ±1 的整数量化）。
   **不**把「GUI 控件被命中」算作 `move` 的成功——那是另一个边界（§2.4.5）。
5. **GUI 命中集与投递是两件事**：`【实测】` GUI 命中集**每帧重建**，位置来自 `Mouse.getX/getY`；
   MUI2 有 **≥2 帧**的管线延迟，MUI1 需要 **≥1 tick** 重建。`【要求】` 冻结为
   **`input.state.hitSet.minSettleTicks = 2`**，且文档/自述必须写明「`move` 后必须等 ≥2 tick 再 `down`」。
   单帧内「move + down」**不承诺**命中目标控件。
6. `【实测】` 注入点击的坐标来源是 `getEventX/getEventY`，而这两个值由 `addMoveEvent` 维护 ⇒
   **不先 `move` 就点，点到的是上一次的位置**。`【要求】` 该事实必须写进 `input.mouse` 的自述描述，
   不得只写在本文件。

### 2.5 相对与绝对的区分（不得混用）

1. `move` 的 `x/y` 是**绝对 GUI 坐标**；`relative` 的 `dx/dy` 是**相对世界视角增量**。
   二者**不可互换**、**不同时出现**（§2.3 的禁用表）。
2. `【要求】` 返回值里的字段名必须能自证口径：`move` 回 `requested.space = "gui-scaled"` 与
   `deliveredGeometry.space = "sdl-window"`；`relative` 回 `requested.space = "world-look-delta"`。
   调用方只看 JSON 就能判断自己给的是哪一套。
3. `【要求】`（**§6.2 早期示例的勘误，v1.8 起为正文口径**）`delivered` 在**全族**恒为
   **整数计数**（它的定义处是 §4.1 第 1/2 条：「写进队列的事件数」）；`move` 的坐标回显因此**不**放在
   `delivered` 里，而是放在并列的 `deliveredGeometry`（`{space:"sdl-window", x, y, pixelScale,
   displayWidth, displayHeight}`）。理由：同一个字段两种类型会让机器消费者无从解析，而
   `delivered` 的语义在 §4.1 已经冻结；坐标回显是另一件事（自校准用的换算结果）。
   `【实测】` §6.2 的 `move` 成功示例**曾**把 `delivered` 写成坐标对象 —— 那是契约自身的不一致，
   本批已按实现改为「整数 + `deliveredGeometry`」，两处口径从此只有一个。

### 2.6 按钮编号

`【要求】` `button` 是 **LWJGL 编号** `0/1/2`（左/右/中），**不是** SDL 的 `1/2/3`。
理由：MC 侧把它当 LWJGL 按钮号用（`j - 100` → KeyBinding；GUI 侧 `getEventButton()` 直接透传），
生产者侧的 SDL→LWJGL 转换只在 lwjgl3ify 内部做一次。范围外（含负数、≥3 的越域值）一律 `CP-VALID-002`。

### 2.7 滚轮单位与方向

1. 单位 = **档（notch）**，`amount` 为**非零整数**；`0` 一律 `CP-VALID-002`（零档无意义，不许当 no-op 绿）。
2. 符号口径由 `input.state.wheel.sign` 声明（`"positive=backward"`），**实现时必须由
   原版 `changeCurrentItem` 的行为实机校准后写死**。
   `【未实现】`（v1.8 现状，#166 DR-2）该义务**未完成**：`input.state.wheel` 同时给出
   `signVerified:false` + `signNote`（「符号口径尚未由原版 `changeCurrentItem` 的实机行为校准」）
   ⇒ 调用方**不得**据 `sign` 下方向判据（正档究竟是不是「向后/向下」还没有实机判据）。
   该缺口与「组合键事件序与队列满无独立实机判据」并列登记在 §11.2（第 12/13 条），
   并**必须**同时出现在 `input.state.notImplemented`（同源，见 §11.2 末条）。
3. `|amount| > 8` 一律 `CP-VALID-002`（防一次请求灌爆界面滚动；上界由 `input.state.limits.wheelAmountMax` 给出）。

### 2.8 拖动 / 组合键 / 重复 / 顺序

| 概念 | 冻结表示法 |
|---|---|
| **拖动** | 不新增 op。表示法 = `down` → （≥1 tick 后）多次 `move` → `up` 的**事件序列**。`【要求】` 拖动期间的中途 `move` 与起止按钮必须**跨 tick**（同 tick 内的 move 会被 `Mouse.poll()` 的 clamp 与命中集重建吞掉） |
| **组合键** | 表示法 = 修饰键先 `down`，主键 `down`/`up`，修饰键最后 `up`。`【要求】` 必须写明「组合键只保证**事件序**；依赖 `Keyboard.isKeyDown` 轮询的修饰键判定（Shift 点击等）**不承诺**」（§2.0） |
| **重复** | 不支持（§2.2 第 5 条）；要连发用多次 `tap` |
| **顺序** | 单次请求内 = 调用方给出的顺序（字段语义）；同族跨请求 = 队列 FIFO（`Keyboard`/`Mouse` 各一条）；**跨族（键 vs 鼠标）无全序保证**（§4.3） |

`【要求】` 修饰键的语义不承诺这一条**必须**出现在 `input.state.pollSurface` 与
`input.key` 的自述描述里——它是最容易被误认为「已具备」的能力。

### 2.9 文本（`input.text`）

| 参数 | 必填 | 类型 | 口径 |
|---|---|---|---|
| `text` | ✅ | `string` | 普通文本；**逐字符投递**（每字符一条事件，顺序即字符串顺序） |

`【要求】`：

1. **投递粒度冻结为「逐字符」**：设施不得把整串压成一条事件，也不得按「单词/行」聚合。
2. **字符范围为声明项**：`input.state.text.ranges` 给出**闭区间码点表**（形如 `[{"from":32,"to":126}]`）。
   `【要求】` 该表必须反映**实际支持的字符范围**，不得写「全 Unicode」这类不可判定的声明；
   实现时若只验到 ASCII 可打印区，就只能声明这一段。
3. **不支持时的行为冻结为「显式失败」**：请求中出现范围外字符 ⇒ **整条请求** `CP-VALID-002`，
   `context.fields` **逐字符**给出 `{index, char, codepoint, reason}`。
   `【禁令】` 不得静默丢弃该字符后继续投递其余字符，不得替换成 `?`/空格/占位符。
4. **空串 ⇒ `CP-VALID-002`**（空请求是无效的，不许静默成功——恒绿假成功是明确要防的失效模式）。
5. **粒度与编码**：按 UTF-16 码元（Java `char`）逐字符；超出 BMP 的码点（代理对）若不在声明范围内，
   按第 3 条显式失败。`【要求】` 该口径必须写进自述。
6. **能力未就绪时不得假装成功**：当 `input.state.text.route.world == false && route.gui == false` 时，
   任何非空 `input.text` 请求一律 **`CP-STATE-001`**（能力未就绪），**不得**返回 `delivered:N` 的绿。
7. `【禁令】` 文本**不得**用来直接改控件值（不得直接 `setText` / 直接写文本框字段）——理由见 §8.2。

### 2.10 输入**不得**隐式穿透 GUI 到世界

`【要求】`：

1. 设施**不改变** `currentScreen`、**不调用** `displayGuiScreen`、**不调** `setIngameFocus`。
   「当前往哪条消费链」由**游戏自己**按 `currentScreen` 与 `allowUserInput` 决定。
2. 设施**不**做「强制世界路径」：不为了「让事件进 KeyBinding」去关界面或改 `allowUserInput`。
3. `input.state` **必须**报当前消费链（`consumer.chain` = `gui` / `world` / `none`，见 §5）。
4. **喂给错误的消费者是真实现象**（`pauseOnLostFocus:true` 时事件只到 `GuiIngameMenu.keyTyped`，
   不进 `KeyBinding`）⇒ `【要求】` 设施**如实报告**，不静默重路由、不静默重投。
5. `【实测】` 两条消费链都不查焦点（GUI 链的 gate 只是 `Mouse.isCreated()`/`Keyboard.isCreated()`，
   世界链的 gate 是 `currentScreen == null || allowUserInput`）⇒ 失焦不阻塞投递与消费，
   但**世界写后果**仍然受聚焦相关分支影响（§2.3 第 2 条）。

---

## 3. 生命周期

### 3.1 持有的归属

1. `【要求】` 持键表（held keys）归**输入运行时**所有，按**作业**（`jobId`）归属；条目记录
   `{kind:"key"|"button", id, jobId, heldSinceTick, expiresAtTick}`。
2. `【要求】` 作业收尾只释放**本作业**的条目；`input.release` 是**全清**（跨作业），用于驱动/人工兜底。
3. `【要求】` `case.run` 内的输入步产生的持键归属**该 `case.run` 作业**：`case.run` 完成/异常/超时统一释放。
4. `【实测】` 现有设施是**单动作互斥**（`CP-BUSY-001`）⇒ 同一时刻只可能有一个作业的条目。
   契约仍按作业归属建模，因为互斥是可变策略，而「持有归属」是语义。

### 3.2 有界期限（上限 + 到期行为）

| 项 | 值 | 到期/越界行为 |
|---|---|---|
| 单键/单按钮持有上限 | **1200 tick**（`holdTicks ∈ [1,1200]`） | `holdTicks` 越界 ⇒ 请求 `CP-VALID-002`；**已投递**的持有到期 ⇒ 设施自动投递抬起，并在结果/事件里报 `autoReleased:[{kind,id,heldTicks,reason:"expired"}]` |
| 作业级兜底 | 步进动作总超时 **5 min** / 阶段超时 **3 min**（现有 `SteppingActionBase`） | 抛 `CP-EXEC-002` ⇒ 走 §3.4 路径 3 |
| 时间单位 | **tick 计数**（名义 20 TPS） | `【要求】` 不许用毫秒做持有期限：客户端卡顿时毫秒不可判定。tick 计数**不保证**与墙钟成正比 |

`【要求】` 任何进入持键表的条目**必须**有 `expiresAtTick`（无期限的持有是禁止的）。
`holdTicks` 的上限与 `player.dig` 的 `MAX_HOLD_TICKS` 取同值，避免同一动作面出现两套上界。

### 3.3 重复按下 / 多次释放语义

| 情形 | 冻结语义 |
|---|---|
| `down` 一个**已在**持键表中的键 | **幂等成功**：不重复投递第二条件按下事件，返回 `alreadyHeld:true`（`【要求】` 不报错、也不静默重投——重投会让「按下」变成两次边沿，`KeyBinding.onTick` 的 `pressTime` 会多计） |
| `up` 一个**不在**持键表中的键 | **幂等成功**：仍投递抬起事件（真实按键抬起是无害的），返回 `wasHeld:false` |
| `input.release`（无持有） | **幂等成功**：`{count:0, alreadyIdle:true}`，**不是错误** |
| `input.release`（有持有） | 逐条投递抬起，返回逐条明细 |
| 同一键 `tap` 后紧跟 `down` | 合法：`tap` 的抬起已投递并移出持键表 |
| 同一键在**同一 tick** 内 `down` + `up`（含 `tap` 缺省 `holdTicks:1` 的边界） | `【要求】` 两条事件同 tick 投递，消费序 = 投递序；**边沿型消费者**（`KeyBinding.isPressed()`、快捷键）看得到，**持续型消费者**（移动输入）看不到 ⇒ 需要位移必须给足够 `holdTicks` |

`【要求】` 「`down` 幂等」与「`up` 幂等」都必须记进结果字段，让调用方能区分「首次按下」与「本就按着」。

### 3.4 清理路径表（承诺强度逐条区分）

`【要求】` 只承诺下列五条路径；**表外一律不承诺**：

| # | 路径 | 触发点 | 设施行为 | 承诺强度 |
|---|---|---|---|---|
| 1 | **正常完成** | 同步动作 `execute` 正常返回 / 步进动作 `advance` 返回非 null | 收尾里释放**本作业**全部持键 —— **例外**：`action:"down"` / `op:"down"` **刻意保留**该持有点（否则 `down` 没有意义，§9.3 第 1′ 条），它的释放由路径 4 或 1200 tick 到期承担 | **承诺**（`down` 的保留见右栏例外） |
| 2 | **动作异常** | `execute`/`advance` 抛 `CpException` 或意外异常 | 失败收尾路径同样释放本作业持键 | **承诺** |
| 3 | **步进超时** | `checkTimeouts` 抛 `CP-EXEC-002` | 同路径 2 | **承诺** |
| 4 | **显式 `input.release`** | 调用方显式请求 | 立即全清（跨作业），幂等 | **承诺** |
| 5 | **进程正常退出** | JVM shutdown hook（现有 `ControlPlaneServer.installShutdownHook`） | 尽力投递抬起事件（`【实测，v1.8】` 落点：钩子的清理段 → `InputRuntimeImpl.releaseAllForShutdown()`） | **尽力**（退出中 `runTick` 可能不再跑，事件不保证被消费） |
| — | **进程崩溃** | — | `【实测】` 状态随 JVM 消失 | **不承诺** |
| — | **离图 / 断连 / 关服（进程未退出）** | — | `【实测】` **无任何可用钩子**（`ClientDisconnect`/`WorldEvent`/`onWorldUnload`/`unloadWorld`/`FMLServerStoppingEvent` 全零命中）⇒ 不可能有迁移 | **不承诺** |
| — | **作业被取消** | — | `【实测】` **无取消能力**（`core` 层零 `cancel`、端点表无取消端点、HTTP 同步超时不取消作业）⇒ 该路径**不存在** | **不存在** |

`【要求】` 上表必须在 `input.state.lifecycle.cleanupPaths` 里机读暴露（含 `crash:"not-promised"`、
`worldUnload:"no-hook"`），使调用方**不可能**误以为崩溃/离图会被清理。

`【实测，v1.8 起路径 5 有代码】（#166 DR-3）` 此前 `installShutdownHook()` 的钩子**只调 `stop()`**，
而上表与 `cleanupPaths` 都宣称「进程正常退出 ⇒ 尽力投递抬起」⇒ 机读面宣称了一条没有代码的路径。
现状：钩子在同一条既有线程上先跑清理段（`ControlPlaneServer.runShutdownCleanup()`，整段 `try/catch`
吞掉一切异常、只 WARN 一次），清理体由 `mc/ControlPlaneBootstrap` 注册为
`InputRuntimeImpl.shared().releaseAllForShutdown()`（经**唯一**释放实现投递抬起）。
`【禁令】` 该清理体**不得**新增 `ClientTickEvent` 订阅者、**不得**抢线程、**不得**在主线程外碰 GL。
`【实测边界】` `releaseAll()` 带 tick 线程断言（§9.3 第 2 条的所有权），退出钩子不在该线程上
⇒ 退出路径必须走 `releaseAllForShutdown()`（同一份释放实现，只跳过线程断言）；这不放宽线程纪律：
`releaseAll()` 跨线程**仍然**必须抛。

### 3.5 只清设施所持状态

`【要求】` 释放**只**投递「设施自己投递过、且仍在持键表里」的抬起事件。三条禁令：

1. `【禁令】` 不得调 `KeyBinding.unPressAllKeys()` / `unpressKey()`——那是原版「进 GUI」的语义，
   会清掉**真实按键**的用户状态（等于抢用户输入）。
2. `【禁令】` 不得 `Keyboard.eventQueue.clear()`（清掉静态 seed ⇒ 后续 `getEventKey()` 等 NPE），
   也不得清任何非本设施投递的事件。
3. `【禁令】` 不得改 SDL 物理状态（§2.0）⇒ 释放后 `Keyboard.isKeyDown`/`Mouse.isButtonDown`
   **不受影响**。这条与「不影响用户桌面」是**同一根源**，必须一起说清楚：
   设施的诚实边界是「只清理自己放进事件队列的东西，**清不了轮询面**」。

### 3.6 物理输入冲突的仲裁与拒绝策略

`【实测】` 全链**没有任何来源校验/白名单**：任何能写这两个队列的进程内代码都等价于真实按键。
因此冻结如下仲裁策略：

1. `【要求】` 设施**只写队列**：不改 SDL 物理状态、不抢焦点、不改 `displayFocused`、
   不改 `pauseOnLostFocus`、不调 §1.2 的禁用 API。
2. `【要求】` 与真实物理输入**不仲裁、不屏蔽**：同一 tick 内真实事件与注入事件在**同一队列**里按
   到达序混合消费；设施**无法**区分、也**不尝试**区分、**不重投**。
3. `【要求】` **必须如实报告冲突**：`input.*` 返回值带 `physicalConcurrent`：
   - **键盘侧可判**：`Keyboard.getNumKeyboardEvents()` 是公开的队列深度探针，与设施自身记账之差
     即非本设施投递的事件数（注意 seed 哨兵的基线为 1）；
   - **鼠标侧不可判**：`Mouse` 的队列深度**没有**公开探针 ⇒ 只能报 `"unobservable"`，
     `【禁令】` 不得编造 `false` 冒充「没有冲突」。
4. `【要求】` 持有键与游戏内状态**不一致时必须报告，不许自动重投**：
   进 GUI 会触发 `unPressAllKeys()`，使 `KeyBinding.pressed` 变 `false`，而后闸门不成立 ⇒
   设施的逻辑持有与游戏内绑定态会分叉。`input.state.held[].gameBindingPressed` 必须**回读**该键对应
   KeyBinding 的 `pressed` 值供调用方判读。
   `【禁令】` 不得「检测到不一致就重新投递」——那会变成「按不住就无限补发」的雪崩。
5. `【要求】` 冲突的具体表现（事件被真实输入抢占、`KeyBinding` 被真实按键改写、
   Angelica zoom 吞掉滚轮）一律**如实报告**，不静默重试。

---

## 4. 执行语义

### 4.1 四个可观测边界（三者不可互代）

| 边界 | 定义 | 判据（可判定） | 谁能证明 |
|---|---|---|---|
| **受理** | 请求通过鉴权 → 授权 → `confirm` → 参数校验，进入队列 | HTTP 响应：`200`（同步）或 `202 + jobId`；`GET /cp/v1/jobs/{id}` 状态 `queued` | 调用方 |
| **排队** | `JobQueue.submit` 成功，`current == job` | 作业状态 `queued`；单动作互斥下再提交得 `CP-BUSY-001` | 调用方 |
| **已投递** | 事件已写入 `Keyboard.eventQueue` / `Mouse.queue` | 键盘侧：`getNumKeyboardEvents()` 深度增量 == 投递数（seed 基线 1）；**鼠标侧无公开探针** ⇒ 只能由设施记账（`delivered`），`【要求】` 必须标注「鼠标侧不可独立复核」 | 设施（键盘侧可复核） |
| **已处理** | **下一个** `runTick` 把事件交给消费者之后 | 键盘侧：队列深度回落到 seed 基线（`【实测】` 实测形态 `1,1,1,1`）。`【要求】` 设施**只报告「已投递」与「观察到的消费链」**；**不得**把「已投递」写成「已处理」 | 只有独立读面能证 |

`【要求】` 「**投递成功 ≠ 业务成功**」是本族的硬口径：

1. 返回值里 `delivered` 的语义**仅**是「写进队列的事件数」；
2. 「消费者是否处理」必须由**独立观察面**取得（§10 第 1/2 条）；
3. `【禁令】` 不得在 `input.*` 的返回值里出现 `observed` / `success` 这类**业务**断言——那是 L0/L1 与
   读面的语言。返回值可以有 `consumed` **占位**，但其值只能是 `null` + 说明文本（「事件在下一个
   `runTick` 被消费；本返回值不声称已处理」）。

### 4.2 注入点与消费时刻

1. `【要求】` 投递发生在客户端 `TickEvent.ClientTickEvent(Phase.END)`（与现有排空器同阶段）。
2. `【实测】` `runTick` 的输入分派段在本 tick 内早于 END 阶段 ⇒ **在 tick N 的 END 投递的事件，
   只能在 tick N+1 的 `runTick` 输入段被消费**。`【要求】` 这是**契约级**规则，下游不得假设「同 tick 生效」；
   `input.state` 与动作自述都必须写明。
3. `【要求】` 设施不得自己新增 `ClientTickEvent` 订阅者（§9.3）：推进由步进动作的每 tick `advance` 承担。

### 4.3 跨帧的时间单位与顺序

1. 时间单位 = **tick**（`holdTicks`、`deliveredAtTick`、`expiresAtTick`、`minSettleTicks` 全是 tick 计数）。
2. 顺序：
   - **单次请求内**：按调用方给出的顺序（字段语义）；
   - **同族跨请求**：队列 FIFO（`Keyboard` 与 `Mouse` 各一条队列）；
   - **跨族（键 vs 鼠标）**：**无全序保证**——分属两条独立队列。
3. `【要求】` 因此「先 move 再 down」「先 down 修饰键再 down 主键」这类**跨族/跨阶段**的意图
   必须用 `holdTicks` / 分次调用 + 至少 1 tick 间隔表达；单 tick 内连发**不承诺**顺序可达。
   位置类（`move` → `down`）的间隔下限是 **2 tick**（§2.4 第 5 条）。

### 4.4 完成屏障

1. `【要求】` 动作的「完成」= **事件已投递** + `delivered` == **实际投递**的事件数。
   事件数与请求数不等 ⇒ 逐条给 `rejected`，并**整条请求失败**（不许部分成功还报绿）。
   `【要求】`（#166 DR-5：与 §3.3 的字面冲突按本节收敛）「实际投递」是**扣除被幂等抑制者之后的**条数：
   重复 `down` 一个已在持键表里的键 ⇒ 不投第二条件按下事件、`delivered` 少一条但**仍然成功**
   （§3.3 的幂等语义优先），抑制情形由 `alreadyHeld` / `wasHeld` 单列，调用方据它们区分
   「首次按下」与「本就按着」。因此判据的准确表述是：
   **成功 ⟺ 请求的每一条事件都「投递了或被幂等抑制」，且没有一条被 `rejected`**。
2. `【要求】` **没有**「等消费者处理完」的屏障——现有设施不具备该能力。
   需要跨 tick 收敛的调用方必须显式表达（`holdTicks` + 独立读面 + `criteria`）。
3. `【要求】` 队列满（`Keyboard.eventQueue` 容量 256）⇒ `CP-STATE-001`，`context` 带
   `queue`/`depth`/`capacity`。`【实测】` lwjgl3ify 的 `addRawKeyEvent` 对队列满**静默丢**（异常被吞），
   因此**设施必须自己先探深度**（`getNumKeyboardEvents()`），不得依赖底层报错。

### 4.5 HTTP 超时**不是**作业取消（沿用既有口径）

1. `【要求】` `?sync=true&timeoutMs=N` 超时返回 **HTTP 202 + `{jobId, timedOut:true}`**，作业**继续执行**
   ——与 `contract.md` §3 末条、`JobQueue` 的类注释、`CoreEndpoints` 的实装完全一致，本族不新增例外。
2. `【要求】` 调用方**不得**把「同步等待超时」理解为「输入已停止」：持键仍在，必须显式
   `input.release`（或等本作业收尾）才释放。
3. `【要求】` 本族不新增取消端点；无取消能力这一事实必须出现在 `input.state`（§3.4 表末行）。

---

## 5. 能力发现：`input.state`

### 5.1 `input.state` 的动作口径

1. **级**：`observe`（Tier.OBSERVE）⇒ **不需要** `confirm`，不要求 `scene` token。
2. **同步动作**：一次调用内返回快照。
3. `【要求】` 数据**必须在客户端 tick 线程取快照**（队列深度、`currentScreen`、`held` 回读全是 MC 状态）
   ——沿用 `contract.md` §9「HTTP 线程不得读 `mc.theWorld` 等 MC 状态」。
4. `【要求】` 本动作是本族**唯一**的能力声明口：任何「本族能不能做 X」的问题，答案只能来自此端点的字段，
   不得来自散文文档。

### 5.2 返回字段（冻结）

| 字段 | 类型 | 语义 |
|---|---|---|
| `implemented` | `bool` | 本族是否已实现。v1.8 起由**运行时真值**给出（注册完成 ⇒ `true`）；`false` 时下面每一个能力字段都必须自洽（见本节末条） |
| `state` | `string \| null` | （#166 DR-11）运行时状态机当前态：`"idle"` / `"holding"` / `"releasing"` / `"faulted"`（§7）。真值来自运行时快照；**读不到时为 `null` + `stateNote`**（不猜 `"idle"`——那会把「未知」卖成「空闲」） |
| `family` | `string` | 恒 `"input"` |
| `means` | `string` | 恒 `"input"`（手段归因，与 `layer`/`semantics` 并列，见 §10 第 3 条） |
| `runtime` | `object` | `{mc, forge, lwjgl3ify, backend, injectors[], contractVersion}`；`injectors` 列出实际可用的五个入口名（只有逐个 `Class.forName` 解析成功才计入，不足五个时 `notImplemented` 追加说明） |
| `actions` | `array` | 已注册的输入动作名（v1.8 起为五个动作名）；`implemented:false` 时为空数组，**不是** `["input.key", ...]` |
| `keyCatalog` | `object` | 键位目录：`{ name → keyCode }`，**运行时注册表实读** |
| `keyCodeRange` | `[int,int] \| null` | 合法 LWJGL 键码闭区间。**`null` = `Keyboard.KEY_*` 常量集实读不到**（不写猜值），此时 `notImplemented` 追加一条说明（#166 DR-14） |
| `pollSurface` | `string` | `"not-covered"` + 说明：轮询面（`Keyboard.isKeyDown` 等）不受本族影响（§2.0） |
| `text` | `object` | `{supported, ranges:[{from,to}], delivery:"per-character", unsupportedBehavior:"explicit-fail", route:{world, gui, verified, note?}}` |
| `coordinates` | `object` | `{space:"gui-scaled-request / sdl-window-delivered", scaledWidth, scaledHeight, displayWidth, displayHeight, pixelScale, yFlip:"eventY = displayHeight - sdlY", selfCalibrated:bool, selfCalibratedNote?, selfCalibration{...}}`。`selfCalibrated` 与 `input.mouse` 的 `coordinates.selfCalibrated`（以及 `move` 返回体的顶层 `selfCalibrated`）是**同一个量**：运行时最近一次 `move` 回读是否落在 ±1 内；**尚无 move 时为 `false` 并附 `selfCalibratedNote:"no-move-yet：…"`**（「未校准」≠「校准失败」，#166 DR-6） |
| `wheel` | `object` | `{unit:"notch", integerOnly:true, sign:"positive=backward", amountMax:8, signVerified:false, signNote}`；`signVerified:false` = §2.7 第 2 条的实机校准义务**未完成**（缺口登记在 §11.2 第 13 条，不得据此下方向判据） |
| `consumer` | `object` | `{chain:"gui"\|"world"\|"none", currentScreen, allowUserInput, displayActive, inGameHasFocus, captureArmed}`（`chain` 读不到时 `null` + `chainNote`） |
| `hitSet` | `object` | `{minSettleTicks:2, note:"GUI 命中集每帧重建；move 后须等 ≥2 tick 再 down"}` |
| `queues` | `object` | `{keyboardDepth, keyboardSeedBaseline:1, keyboardCapacity:256, mouseDepth:"unobservable", deliveredThisJob, deliveredThisSession}`（`keyboardDepth` 读不到、计数无真值时落 `null` + 说明；`deliveredThisJob` 归属作业见 `deliveredJobId`） |
| `held` | `object` | `{count, items:[{kind, id, jobId, heldTicks, expiresInTicks, gameBindingPressed}]}` |
| `physical` | `object` | `{concurrent, mouseConcurrent, keyboardProbe, keyboardSeedBaseline, reason, mouseNote}`。`concurrent` 的取值域 = `true` \| `false` \| `"unobservable"` \| **`"unobservable（键盘队列深度探针不可用）"`**（键盘侧探针读不到时的**如实**取值，与鼠标侧的恒 `"unobservable"` 分列，`mouseConcurrent` 恒 `"unobservable"`；#166 DR-7） |
| `lifecycle` | `object` | `{cleanupPaths:[{id, strength:"promised\|best-effort"}], crash:"not-promised", worldUnload:"no-hook", cancel:"unavailable"}`（路径 5 的实现落点见 §3.4） |
| `limits` | `object` | `{holdTicksMax:1200, wheelAmountMax:8, minSettleTicks:2}` |
| `capabilities` | `object` | （#166 DR-10，只增字段）本端点的**契约常量**声明（不是运行期读数）：`{requiresConfirm:false, tier:"observe", consumerChainReadOwner, hitSetOwner, rollback:"none", wheelSignCalibration:"pending-machine-check", pollSurfaceCovered:false}` |
| `thread` | `object` | （#166 DR-10，只增字段）本快照在哪个线程取的：`{snapshotThread, requiredThread:"client-tick", verified, note?}`；判定口不可用时 `verified:false` + `note`（「未验证」≠「已验证为假」） |
| `errors` | `array` | 本族会返回的错误码清单（§6.1）：**4 条** = `CP-VALID-002` / `CP-STATE-001` / `CP-EXEC-002` / `CP-CONFIRM-001`。**不含 `CP-VALID-001`**（v1.8 起本族已注册，该码不再适用）。真值唯一来源 = `InputCapabilities.errorsJson()`（#166 DR-8） |
| `notImplemented` | `array` | 本族已冻结但未实现/未验证的项（与 §11.2 同源，v1.8 后 **13 条**），**再追加**本次探针读不到才知道的动态缺口（如 `runtime.injectors` 不足五个、`keyCodeRange` 读不到、投递计数无真值）；去重、保序（#166 DR-9） |
| `warnings` | `array` | **仅当非空时出现**：探针自身的诊断（如「`Keyboard` 类不可解析」「`Display.getPixelScaleFactor` 读不到」） |

`【要求】` 字段只增不改；新增字段必须同步本节表格。
`【要求】` `implemented:false` 时，`actions` 为空、`keyCatalog` 为空对象、`text.ranges` 为空、
`held.count` 为 0、`notImplemented` **非空**——「未实现」必须在**每一个**能力字段上自洽，
不许用默认值把未知伪装成「已具备但当前为 0」。

### 5.3 一份**真实形状**的示例响应（T1 冻结时的形态：未实现）

> **字段形状仍有效，取值已变**：v1.8 起 `implemented` 为 `true`、`actions` 为五个动作名、
> `keyCatalog`/`coordinates`/`held` 有真值来源、`notImplemented` 已按本批删去四项。
> 下面这份 JSON 保留下来是因为它是**未实现态的自洽样例**（每个能力字段都为空/为假，
> 且 `notImplemented` 非空）——「未实现不许伪装成已具备」这条判据需要一个可对照的实例。
> **只增字段未列进本示例**（#166 起）：`state`、`capabilities`、`thread`、`warnings`（仅非空时出现）；
> 本示例的 `coordinates.selfCalibrated` 形状与现实现一致（顶层布尔），差别只在取值：
> 未实现态恒 `false`，实现态由运行时**最近一次 `move` 的回读结论**给出（尚无 move 时 `false` +
> `selfCalibratedNote`）。

```jsonc
{
  "ok": true,
  "data": {
    "implemented": false,
    "family": "input",
    "means": "input",
    "runtime": {
      "mc": "1.7.10", "forge": "10.13.4.1614", "lwjgl3ify": "3.0.8", "backend": "sdl",
      "injectors": ["Keyboard.addRawKeyEvent", "Keyboard.addCharEvent",
                    "Mouse.addMoveEvent", "Mouse.addButtonEvent", "Mouse.addWheelEvent"]
    },
    "actions": [],
    "keyCatalog": {},
    "keyCodeRange": [0, 255],
    "pollSurface": "not-covered：Keyboard.isKeyDown / Mouse.isButtonDown 读 SDL 物理数组，队列注入不改变它们",
    "text": {
      "supported": false,
      "ranges": [],
      "delivery": "per-character",
      "unsupportedBehavior": "explicit-fail",
      "route": { "world": false, "gui": false }
    },
    "coordinates": {
      "space": "gui-scaled-request / sdl-window-delivered",
      "scaledWidth": 854, "scaledHeight": 480, "displayWidth": 854, "displayHeight": 480,
      "pixelScale": 1.0, "yFlip": "eventY = displayHeight - sdlY", "selfCalibrated": false
    },
    "wheel": { "unit": "notch", "integerOnly": true, "sign": "positive=backward", "amountMax": 8 },
    "consumer": {
      "chain": "world", "currentScreen": null, "allowUserInput": true,
      "displayActive": false, "inGameHasFocus": true, "captureArmed": false
    },
    "hitSet": { "minSettleTicks": 2,
                "note": "GUI 命中集每帧重建（MUI2 ≥2 帧、MUI1 ≥1 tick）；move 后须等 ≥2 tick 再 down" },
    "queues": { "keyboardDepth": 1, "keyboardSeedBaseline": 1, "keyboardCapacity": 256,
                "mouseDepth": "unobservable", "deliveredThisJob": 0, "deliveredThisSession": 0 },
    "held": { "count": 0, "items": [] },
    "physical": { "concurrent": "unobservable" },
    "lifecycle": {
      "cleanupPaths": [
        { "id": "normal-completion", "strength": "promised" },
        { "id": "action-exception",   "strength": "promised" },
        { "id": "step-timeout",       "strength": "promised" },
        { "id": "explicit-release",   "strength": "promised" },
        { "id": "process-exit",       "strength": "best-effort" }
      ],
      "crash": "not-promised", "worldUnload": "no-hook", "cancel": "unavailable"
    },
    "limits": { "holdTicksMax": 1200, "wheelAmountMax": 8, "minSettleTicks": 2 },
    "errors": ["CP-VALID-002", "CP-STATE-001", "CP-EXEC-002", "CP-CONFIRM-001"],
    "notImplemented": [
      "五个动作均未注册（GET /cp/v1/actions 的 count 仍为 43）",
      "契约版本未前进（仍 1.7）；since 待实现合并时取 1.8",
      "ActionDescriptor 的 means 自描述字段（显式待办）",
      "GUI 文本路由（P0 实测未打通）",
      "case-file.md §3.2 的多 tick 输入步（G1）",
      "read.input 读面、GUI 截图取证面、作业取消、离图清理钩子"
    ]
  }
}
```

`【要求】` 示例中的数值（`scaledWidth` / `displayHeight` / `pixelScale` / `keyboardDepth`）都是
**运行期实读**，不是常量；本节只冻结字段名、类型与语义，不冻结具体数字。

---

## 6. 错误与失败语义

### 6.1 错误码裁决：**本族不新增任何错误码**

`【要求】` 复用既有四个码，覆盖全部失败类别（`contract.md` §3 的码值只增不改义）：

| 码 | HTTP | 本族中的用法 |
|---|---|---|
| `CP-VALID-002` | 400 | 参数/取值/不适用字段/字符范围外/键位未注册/滚轮零档或越界；`context.fields` 逐字段，字符类**逐字符** |
| `CP-STATE-001` | 409 | 前置状态不满足：**能力未就绪**（如 `input.text` 路由未通）、**队列满**、**faulted 态**下的请求 |
| `CP-EXEC-002` | 504 | 步进动作超时（`holdTicks` 跨 tick 推进被总/阶段超时打断）；`context` 带 `stage`/`stageElapsedMs` |
| `CP-CONFIRM-001` | 400 | 可写动作缺 `"confirm": true`（`scene` 级一律要求；`input.state` 是 `observe`，**不要求**） |
| `CP-VALID-001` | 404 | **T1 冻结期的历史形态**（当时五个动作未注册 ⇒ 未知动作）。v1.8 起五个动作已注册，该码对本族**不再适用** |

`【要求】` 判决理由必须写进自述：**不引入新码**是因为上表四类已把「参数错 / 状态不满足 / 执行超时 /
确认缺失」四类穷尽；「投递成功但没生效」不是错误（如实报告的 `consumer` + 独立读面即可判读），
「队列满」与「能力未就绪」同属**前置状态**不满足，用 `CP-STATE-001` 语义吻合，用新码只会让调用方
多学一个码而没有新信息。

### 6.2 逐动作成功/失败示例

#### `input.key`

成功（`down`，世界链，失焦）：

```jsonc
// POST /cp/v1/actions/input.key?sync=true
{ "key": "key.forward", "action": "down", "confirm": true }
```
```json
{
  "ok": true,
  "data": {
    "means": "input", "semantics": "key", "layer": null,
    "key": "key.forward", "keyCode": 17, "action": "down",
    "delivered": 1,
    "events": [{ "kind": "key", "keyCode": 17, "state": "down", "codepoint": 0 }],
    "deliveredAtTick": 18422,
    "queueDepthAfter": 2,
    "consumer": { "chain": "world", "currentScreen": null, "allowUserInput": true,
                  "displayActive": false, "inGameHasFocus": true },
    "held": { "count": 1, "items": [{ "kind": "key", "id": "key.forward", "jobId": "j42",
                                      "heldTicks": 0, "expiresInTicks": 1200,
                                      "gameBindingPressed": true }] },
    "physicalConcurrent": false,
    "consumed": { "observed": null,
                  "note": "事件在下一个 runTick 被消费；本返回值不声称已处理" }
  }
}
```

> `keyCode: 17`（`KEY_W`）与 `key.forward` 的绑定是**运行期实读**的结果（示例值）；改键后此对应关系会变，
> 调用方一律以 `input.state.keyCatalog` 为准。

失败 1｜键位标识未注册：

```json
{
  "ok": false,
  "error": {
    "code": "CP-VALID-002",
    "message": "键位标识未注册: key.fly",
    "context": {
      "fields": [{ "field": "key",
                   "reason": "既不是已注册的键位描述，也不是合法 LWJGL 键码",
                   "received": "key.fly", "receivedType": "string",
                   "expected": "key.<描述名> 或 0..255 的 LWJGL 键码" }],
      "registered": ["key.attack", "key.back", "key.forward", "key.jump", "key.left",
                     "key.right", "key.sneak", "key.sprint"],
      "keyCodeRange": [0, 255],
      "hint": "完整目录以 POST /cp/v1/actions/input.state 的 keyCatalog 为准（本单未实现）"
    }
  }
}
```

失败 2｜不适用字段（**不许静默忽略**）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-VALID-002",
    "message": "参数不适用: holdTicks 只对 action=tap 有效",
    "context": {
      "fields": [{ "field": "holdTicks",
                   "reason": "action=down 时不适用；不适用字段一律显式拒绝，不许静默忽略",
                   "received": "40", "receivedType": "int",
                   "expected": "仅在 action=tap 时出现，取值 1..1200" }]
    }
  }
}
```

失败 3｜步进超时（`tap` + `holdTicks` 跨 tick 推进被打断）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-EXEC-002",
    "message": "阶段超时",
    "context": { "stage": "input-hold", "stageElapsedMs": 180000, "stageTimeoutMs": 180000,
                 "jobId": "j42",
                 "released": [{ "kind": "key", "id": "key.forward", "heldTicks": 3599 }],
                 "hint": "清理路径 3（契约 §3.4）：持键已在失败收尾里释放" }
  }
}
```

失败 4｜缺 `confirm`（`scene` 级可写动作的门）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-CONFIRM-001",
    "message": "可写动作必须含 \"confirm\": true（字面布尔）",
    "context": { "action": "input.key", "tier": "scene", "writable": true }
  }
}
```

失败 5｜**T1 冻结期的历史形态**（当时未实现 ⇒ 未注册 ⇒ 未知动作）。v1.8 起 `input.key` 已注册，
本形态**不再是**本族的可达失败；保留它只为说明「注册前调用会得到什么」：

```json
{
  "ok": false,
  "error": {
    "code": "CP-VALID-001",
    "message": "未知动作: input.key",
    "context": { "registered": ["core.ping", "core.status", "world.info", "...共 43 个"],
                 "hint": "输入手段族在 feat/cp-input-contract 上尚未实现（见 input-contract.md §11.2 第 1 条）" }  }
}
```

#### `input.text`

成功（**仅当** `text.route` 至少一路为真时才是成功形态；本单不可能出现）：

```json
{
  "ok": true,
  "data": {
    "means": "input", "semantics": "text",
    "text": "hi", "delivered": 2,
    "events": [{ "kind": "char", "char": "h", "codepoint": 104 },
               { "kind": "char", "char": "i", "codepoint": 105 }],
    "deliveredAtTick": 18424,
    "consumer": { "chain": "gui", "currentScreen": "net.minecraft.client.gui.GuiChat",
                  "allowUserInput": false, "displayActive": false, "inGameHasFocus": false },
    "consumed": { "observed": null,
                  "note": "字符是否被控件接收必须由独立读面判定；本返回值不声称已处理" }
  }
}
```

失败 1｜字符超出声明范围（**逐字符**给出，整条失败）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-VALID-002",
    "message": "文本包含不受支持的字符（已整条拒绝，未投递任何字符）",
    "context": {
      "delivered": 0,
      "fields": [
        { "index": 0, "char": "H", "codepoint": 72, "reason": "不在声明范围内" },
        { "index": 3, "char": "中", "codepoint": 20013, "reason": "不在声明范围内" }
      ],
      "ranges": [{ "from": 97, "to": 122 }],
      "unsupportedBehavior": "explicit-fail",
      "hint": "本族不静默丢弃、不替换字符（契约 §2.9 第 3 条）"
    }
  }
}
```

失败 2｜能力未就绪（本单的真相）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-STATE-001",
    "message": "文本投递路由未就绪（world/gui 两路均未打通）",
    "context": {
      "text": { "supported": false, "routes": { "world": false, "gui": false } },
      "hint": "P0 实测：GuiChat.fieldText 可读且为空；addCharEvent 与键事件自带 codepoint 两条都未到达。"
    }
  }
}
```

#### `input.mouse`

成功（`move`，含换算与回读）：

```json
{
  "ok": true,
  "data": {
    "means": "input", "semantics": "mouse", "op": "move",
    "requested": { "space": "gui-scaled", "x": 426, "y": 322 },
    "delivered": 1,
    "deliveredGeometry": { "space": "sdl-window", "x": 426.0, "y": 158.0, "pixelScale": 1.0,
                           "displayWidth": 854, "displayHeight": 480 },
    "readback": { "space": "gui-scaled-observed", "requestedX": 426, "requestedY": 322,
                  "tolerancePx": 1, "mouseX": 426, "mouseY": 322, "guiX": 426.0, "guiY": 322.0,
                  "withinTolerance": true, "pixelScaleApplied": false },
    "selfCalibrated": true,
    "deliveredAtTick": 18422,
    "hitSet": { "state": "stale", "appliesTo": "this-move", "minSettleTicks": 2,
                "note": "本动作只保证坐标已投递；GUI 命中集每帧重建，≥2 tick 后才可能命中" },
    "consumer": { "chain": "world", "currentScreen": null, "allowUserInput": true,
                  "displayActive": false, "inGameHasFocus": true,
                  "worldChainActive": true, "captureArmed": false },
    "physicalConcurrent": "unobservable"
  }
}
```

> `delivered` 是**整数**（§4.1 的定义），坐标回显在 `deliveredGeometry`（§2.5 第 3 条的勘误口径）；
> `selfCalibrated` 是本次 move 的回读结论（§2.4 第 4 条），它同时出现在 `input.state.coordinates` 的
> 顶层（两处同一个实现点，见 §5.2）。

失败 1｜`op` 与参数不匹配：

```json
{
  "ok": false,
  "error": {
    "code": "CP-VALID-002",
    "message": "参数不适用: op=move 不接受 button",
    "context": {
      "fields": [{ "field": "button", "reason": "op=move 的禁用参数",
                   "received": "0", "receivedType": "int", "expected": "该字段不出现在 op=move 的请求里" },
                 { "field": "op", "reason": "逐 op 适用面见契约 §2.3 的表",
                   "received": "move", "expected": "move|relative|down|up|click|wheel" }]
    }
  }
}
```

失败 2｜队列不可接纳（键盘侧可探、鼠标侧不可探）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-STATE-001",
    "message": "键盘事件队列已满，拒绝投递（不做静默丢弃）",
    "context": { "queue": "keyboard", "depth": 256, "capacity": 256, "requested": 3,
                 "hint": "底层 addRawKeyEvent 对队列满静默吞异常；设施必须先探深度再投递（契约 §4.4 第 3 条）" }
  }
}
```

失败 3｜`faulted` 态下的请求（§7）：

```json
{
  "ok": false,
  "error": {
    "code": "CP-STATE-001",
    "message": "输入运行时处于 faulted 态：所持状态与实际队列已不一致",
    "context": { "state": "faulted", "reason": "observed-queue-divergence",
                 "released": [{ "kind": "key", "id": "key.forward", "heldTicks": 12 }],
                 "hint": "先调 input.release 复位到 idle；设施不自动重投（契约 §3.6 第 4 条）" }
  }
}
```

#### `input.release`

成功（有持有）：

```json
{
  "ok": true,
  "data": {
    "means": "input", "semantics": "release",
    "released": [{ "kind": "key", "id": "key.forward", "jobId": "j42", "heldTicks": 37 },
                 { "kind": "button", "id": "0", "jobId": "j42", "heldTicks": 12 }],
    "count": 2, "alreadyIdle": false,
    "delivered": 2, "deliveredAtTick": 18430,
    "lifecyclePath": "explicit-release"
  }
}
```

成功（幂等：无持有，**不是错误**）：

```json
{ "ok": true,
  "data": { "means": "input", "semantics": "release",
            "released": [], "count": 0, "alreadyIdle": true,
            "delivered": 0, "deliveredAtTick": 18431,
            "lifecyclePath": "explicit-release" } }
```

失败｜缺 `confirm`（`input.release` 是 `scene` 级可写动作）：

```json
{ "ok": false,
  "error": { "code": "CP-CONFIRM-001",
             "message": "可写动作必须含 \"confirm\": true（字面布尔）",
             "context": { "action": "input.release", "tier": "scene", "writable": true } } }
```

#### `input.state`

成功：见 §5.3（`observe` 级，**不要求** `confirm`）。
失败｜在非 tick 线程上被误用（实现缺陷的显式化）：

```json
{ "ok": false,
  "error": { "code": "CP-STATE-001",
             "message": "输入状态快照必须在客户端 tick 线程取得",
             "context": { "thread": "cp-http-worker", "requiredThread": "client-tick",
                          "state": "holding",
                          "hint": "HTTP 线程不得读 MC 状态（contract.md §9）" } } }
```

> `context.state` 是 §7 要求「必须显式失败时给出当前态」的落点（#166 DR-11）；运行时未装配或快照读不到时
> 它落 `null` 并附 `stateNote`（不猜 `"idle"`）。

---

## 7. 状态迁移表（设施状态机）

`【要求】` 输入运行时是一个**单实例状态机**，状态与迁移如下。第 4 列是**必须显式失败**的情形
（`CP-STATE-001`，`context.state` 给出当前态），**不得**静默 no-op。

| 当前态 | 触发 | 允许的迁移 | 不允许的迁移（必须显式失败） |
|---|---|---|---|
| `idle` | `input.key`（`down`/`up`/`tap`）、`input.mouse`（`down`/`click`）、`input.text` | → `holding`（产生了持有点）或留在 `idle`（纯 `up`/`move`/`wheel`/`text` 不产生持有） | — |
| `idle` | `input.release` | 留在 `idle`（幂等成功，`alreadyIdle:true`） | — |
| `idle` | `input.state` | 留在 `idle`（只读） | — |
| `holding` | 再次 `down` 同一键/按钮 | 留在 `holding`（幂等，`alreadyHeld:true`） | — |
| `holding` | `down` 另一个键/按钮 | 留在 `holding`（持有点 +1） | — |
| `holding` | `input.release` | → `releasing` → `idle` | — |
| `holding` | 作业**正常完成**（`advance` 返回非 null / 同步 `execute` 返回） | → `releasing` → `idle`（清理路径 1） | — |
| `holding` | 作业**异常**（`CpException` 或意外异常） | → `releasing` → `idle`（清理路径 2） | — |
| `holding` | 步进**阶段/总超时** ⇒ `CP-EXEC-002` | → `releasing` → `idle`（清理路径 3） | — |
| `holding` | 单键 `holdTicks` 到期 | 还有持有点 → 留在 `holding`（该点移出，报 `autoReleased`）；最后一个点到期 → `releasing` → `idle` | — |
| `holding` | 持有条目**无** `expiresAtTick`（实现缺陷） | — | **非法规避**：立即 `faulted`（无期限持有是禁止的，§3.2） |
| `holding` | `input.state` | 留在 `holding`（只读） | — |
| `holding` | 进程**正常退出** | → 进程终止（清理路径 5，`best-effort`） | — |
| `holding` | **进程崩溃** | — | **不承诺**（`【实测】`状态随 JVM 消失）；不产生任何清理保证 |
| `holding` | **离图 / 断连 / 关服（进程未退出）** | — | **无钩子**（`【实测】`零命中）⇒ 不迁移、不释放、**不承诺**（这是诚实项，不是缺陷待办） |
| `holding` | **作业取消** | — | **不存在该触发**（`【实测】`无取消能力） |
| `releasing` | 新触发（任何 `input.*`） | 一 tick 内完成并落到 `idle` | 该态**只在一 tick 内存在**，外部请求到不了（单动作互斥）；若内部缺陷导致到达 ⇒ `CP-STATE-001` |
| `releasing` | 投递抬起失败（队列满等） | → `faulted`（**不得**静默留在 `releasing`） | — |
| `faulted` | `input.release` | → `idle`（**无条件复位**，接受丢事件：复位优先于完整性） | — |
| `faulted` | 任何其它 `input.*` 请求 | — | ✅ **必须显式失败** `CP-STATE-001`（`context.state:"faulted"` + `reason` + 已释放明细） |
| `faulted` | `input.state` | 留在 `faulted`（只读，必须报 `state:"faulted"`） | — |
| 任意态 | 设施检测到**队列深度与自身记账不一致**（超出 seed 基线的差值无法由本设施或真实输入解释） | → `faulted`（并**不**自动重投，§3.6 第 4 条） | — |

`【要求】` 定义与判据：

1. **`idle`**：持键表为空且无未决投递。
2. **`holding`**：持键表非空。
3. **`releasing`**：正在投递抬起事件；**瞬态**，只在一 tick 内可见。
4. **`faulted`**：设施所持状态与实际队列不一致（队列被外部清空、投递中断、超时/异常路径里抬起投递失败）。
   进入 `faulted` 必须发一条事件流水（`kind:"action-fail"` 或既有的 `input-fault` 子类，沿用 `contract.md` §8 的 `kind` 只增不改义）。
5. `【要求】` 状态机是**每进程唯一**的，不按作业分实例；持有条目按作业归属（§3.1）。
6. `【已履行，v1.8】（#166 DR-11）` 「必须显式失败」的当前态有了两个机读落点：`input.state` 成功体
   必报顶层 `state`（§5.2），`input.state` 的线程失败形态在 `context.state` 给出当前态（§6.2）。
   **诚实边界（未做，不得读成已做）**：**投递类**失败信封（`input.key`/`input.mouse`/`input.text`/
   `input.release` 因 `faulted`/队列满/参数错而失败时那个 `error.context`）里，当前态仍只出现在
   `context.hint` 的 `state=faulted, reason=…` **文本**中，**没有**单列的 `context.state` 字段
   —— 那需要把运行时态传进四个动作的错误构造点（`InputSupport.fromRejections`），
   属本单范围外的接口改动，已登记为 §12.2 的暂存项。

---

## 8. 扩展边界

### 8.1 输入表示 **与** 投递后端分离

`【要求】` 实现必须分两层，且**换后端不得改表示层契约**：

| 层 | 内容 | 变更影响 |
|---|---|---|
| **表示层**（契约面） | 键位标识/键码、字符与 codepoint、GUI 缩放坐标、世界视角增量、按钮编号、滚轮档位、事件序与 `holdTicks` | 只增不改；改它 = 改契约 |
| **投递层**（实现面） | §1.2 的五个入口与其调用方式（反射 / compileOnly 依赖） | 可替换（如未来换注入面、换 lwjgl3ify 版本） |

`【要求】` 表示层**不得**泄漏投递层细节：返回值里不能出现 SDL 结构体名、像素/窗口坐标（除
`delivered` 的换算回显，那是为了自校准）、`addRawKeyEvent` 这类方法名（除 `runtime.injectors` 的诊断字段）。

### 8.2 文本**不直接改控件值**

`【禁令】` 不得走「直接 `setText` / 直接写文本框字段 / 直接调控件回调」这条捷径：

1. 它绕过 `keyTyped` / `handleKeyboardInput` / 控件自己的 filter 与光标逻辑，与「走游戏自己的路由」相反；
2. 它让「输入手段」与「API 直设」两者的结论不可区分，摧毁 §10 的分层纪律；
3. 真实文本框的可用性（focus、filter、长度上限）正是要验证的东西，绕过它等于把被测对象替换掉。

`【要求】` 文本只能经 `input.text`（或 `input.key` + `codepoint`）投递字符事件，由控件自己决定接收与否；
「控件没接收」是**合法结果**，由独立读面取得。

### 8.3 本期**不做**（不预留参数、不占位）

| 项 | 处置 |
|---|---|
| IME / 组合输入 / 预编辑串 | 不做；不预留 `preedit`/`composition` 参数（lwjgl3ify 有 `beginTextInput/endTextInput` 的正规 API，但那是**另一条**能力，须独立立项） |
| 剪贴板 | 不做 |
| 手柄 / 触摸 | 不做 |
| 多客户端并发 | 不做（本族按进程内单实例建模，持键表不跨实例） |
| 作业取消 | 不存在（`【实测】`）⇒ 不预留 `cancel` 语义 |
| 离图清理 | 无钩子（`【实测】`）⇒ 不预留 `onWorldUnload` 语义 |

### 8.4 后续增量扩展点（只增不改）

1. **新 `op`**：如 `drag`（若「`down`+多次 `move`+`up`」的显式序列被证明不够）；
2. **`input.key` 的 `repeat`**：若 3.0.8 的 REPEAT 过滤被实机证伪，可增可选 `repeat:true`（只增参数，不改 `down`/`up`/`tap` 语义）；
3. **`input.mouse op:relative` 的聚焦兜底**：若实机证明失焦下确实无效且需要（且不违反「不抢焦点」禁令），
   只能以「如实报告 + 不生效」的形态保留，**不得**去改 `displayFocused`；
4. **`input.text` 的字符范围放宽**：范围一旦在 `input.state.text.ranges` 里声明，放宽是增量的；
5. **新读面 `read.input`**：把输入侧状态纳入契约 `read.*` 族（当前 9 个 `read.*` 无一条读输入侧）；
6. **新 `input.state` 字段**：只增不改。

---

## 9. 集成协议

### 9.1 沿用既有体系（逐条）

| 体系 | 本族如何沿用 |
|---|---|
| 端点 | `POST /cp/v1/actions/{name}`；`input.key`/`input.text`/`input.mouse`/`input.release` 为 `scene` 级可写（**必须** `"confirm": true`），`input.state` 为 `observe` 级只读（不要求 `confirm`） |
| 作业 | 走 `JobQueue`：单动作互斥、`CP-BUSY-001`、`?sync=true&timeoutMs=N` 超时**不取消**（§4.5） |
| 产物 | 走 `ArtifactStore`：`ActionContext.beginRun` / `writeArtifact`（自动登记 sha256）/ `writeManifest` 两条收尾路径不变；不新增 `role` 命名空间以外的东西 |
| 事件流水 | 沿用 `{seq, ts, level, kind, action?, jobId?, message, data?}`；`kind` 只增不改义；`faulted`/`autoReleased` 走 `data` |
| 线程 | HTTP 线程只解析/鉴权/入队；投递、快照、回读全在客户端 tick 线程（`contract.md` §1.8 / §9） |
| 自描述 | `GET /cp/v1/actions` 的动作目录必须含本族五条（实现合并时）；`since` 取 `1.8`（§1.4） |

### 9.2 G1 最小兼容扩展（`case-file.md` 的 `action` 段）

**问题**：`action` 段硬拒步进动作（`CaseRunAction` 的判据 + `case-file.md` §3.2 的成文：「本段在单次
`advance` 里逐条跑完，放行跨 tick 的动作会让『段完成』与『动作完成』脱钩」）⇒ 用例**无法**表达
「注入输入 → 推进 N tick → 读后果」。

**冻结的最小兼容方案**（形状与回归面在本文冻结，**实现留给 T3/P3**）：

```jsonc
"action": [
  { "action": "input.key",
    "params": { "key": "key.forward", "action": "tap" },
    "holdTicks": 20,
    "path": "action/0-hold-w.json", "role": "input-hold-forward",
    "expect": { "/delivered": 2 } }
]
```

1. **形状**：`holdTicks` 在**步骤对象顶层**，与 `params` 并列（与 `case-file.md` §3.2 的既有键集 `{action, params, path, role?, expect?}` 只增一个键）。
2. `【要求】` `params` 内**不得**出现 `holdTicks`；两处都写 ⇒ `CP-VALID-002`（两处必有一处真值来源不明）。
3. **推进机制**：`CaseRunAction` 对 `input.*` 步**不在单次 `advance` 内跑完**——投递首段事件后**返回 `null`**
   （复用现有跨 tick 机制），后续 tick 递减 `holdTicks`，归零时投递抬起、写该步产物、跑 `expect`、记段。
4. **四条禁令**：不新增段（`CaseValidator.SEGMENTS` 九段不动）；不新增编排器；**不在客户端线程 sleep/忙等**
   （现有 `settleBetweenSteps` 的 `Thread.sleep` 路径不得用于输入步）；不改 `read` 段语义。
5. **回归面（实现必须保绿的负对照，逐条可判定）**：

| # | 负对照 | 期望 |
|---|---|---|
| 1 | `action` 段里放**非** `input.*` 的步进动作 | 仍 `CP-VALID-002`（例外只对 `input.*` 开） |
| 2 | `read` 段里放 `input.*` 步 | 仍 `CP-VALID-002`（读面只读，输入是写；`READ_ACTION_PREFIX` 不变） |
| 3 | `action` 段里放 `core.shutdown` | 仍被 `ACTION_FORBIDDEN` 拒 |
| 4 | `case.validate` 与 `case.run` | 对输入步的校验结论**同源**（静态可查，含 `holdTicks` 越界与两处同写） |
| 5 | 段产物形态 | `segments/<name>.json` 的字段集合**不改**；输入步的 tick 推进明细落在该步自己的 `action/N-*.json` |
| 6 | `expect` 语义 | 不变：每步跑完当场判，任一条不命中即 `CP-EXEC-001` |
| 7 | **无 `input.*` 步的用例** | 产物与今天**逐字节一致**（纯增量，A3 基准不失效） |
| 8 | `settleBetweenSteps` | 输入步**不**走 sleep 路径（严禁忙等） |

6. `【要求】` 回归面第 5 条是**故意把 A3 基准的失效面压到最小**的裁定：段产物不加字段，
   tick 明细进步骤自己的产物（`action` 段每步本来就有产物落点）。

### 9.3 T2-A / T2-B / T3 的边界（所有权、数据结构、线程与完成回调）

**所有权**（三方并行时的独占面，越界即冲突）：

| 方 | 拥有 | 不得碰 |
|---|---|---|
| **T2-A（运行时）** | `InputRuntime` 单实例：投递、持键表、`releaseJob`/`releaseAll`、`snapshot`；新包目录（如 `mc/input/`）；投递层的反射/依赖选型 | 不注册动作、不改 `ActionRegistrar`/`ActionDescriptor`/`CaseRunAction`；不读世界状态做业务断言 |
| **T2-B（观察）** | `InputStateProvider` 的**实现**（字段组装）、只读探针（`Keyboard.getNumKeyboardEvents()`、`Mouse.getX/getY` 回读、`KeyBinding` 回读）、消费链观察、`physicalConcurrent` 的键盘侧判定 | **不写队列**（只读）、不注册动作、不改 §9.2 的 `CaseRunAction` 扩展 |
| **T3（集成）** | 五个描述符与 `registerInputActions(...)`（`ActionRegistrar` 是动作面唯一装配点）、`CaseValidator` 白名单、`CaseRunAction` 的 G1 扩展、`ActionDescriptor.means`（**v1.8 已履行**，可选字段、不设默认值）、`contract.md` §4 新小节与计数、`case-file.md` §3.2 改写、动作计数与版本断言同步 | 不实现投递与观察的细节 |

**冻结的数据结构**（T2-A 与 T3 的接口面；T2-B 只读消费）：

```java
// T2-A 的接口面（客户端 tick 线程唯一写入者）
public interface InputRuntime {
    DeliverResult deliver(List<InputEvent> events, String jobId); // 绝不阻塞；同步返回
    ReleaseResult releaseJob(String jobId);                       // 作业级释放（幂等）
    ReleaseResult releaseAll();                                   // 全清（幂等）
    InputStateSnapshot snapshot();                                // 只读快照
}

public final class InputEvent {        // 字段名即契约，只增不改
    String  kind;       // "key" | "char" | "mouse" | "move" | "wheel"
    String  key;        // kind=key: 键位描述名
    Integer keyCode;    // kind=key: LWJGL 键码
    String  state;      // kind=key|mouse: "down" | "up"
    Integer codepoint;  // kind=key|char: 已提交字符码点，缺省 0
    Integer button;     // kind=mouse: 0/1/2
    Double  x, y;       // kind=move: GUI 缩放坐标
    Double  dx, dy;     // kind=move: 世界视角增量（仅 op=relative）
    Double  amount;     // kind=wheel: ±整数档
}

public final class DeliverResult {
    int  delivered;          // 写进队列的事件数
    List<Rejected> rejected; // 逐条拒绝 {index, code, reason}；非空即整条请求失败
    int  queueDepthAfter;    // 键盘侧=实读；鼠标侧=设施记账（须标注不可独立复核）
    long deliveredAtTick;
    String constraintHint;   // 队列满等约束说明（nullable）
}

// T2-B 实现、T3 注册
public interface InputStateProvider { JsonObject state(); }
```

**线程与完成回调**：

1. `【要求】` **作业推进**的唯一 tick 驱动 = 步进动作的每 tick `advance`（现有 `SteppingActionBase`）；
   **唯一**完成回调 = `SteppingActionBase.onFinish(ctx)`（三条路径都调）。
1′. `【D-7 修订，v1.8】` **到期结算**不能只依赖上面那条推进。`input.key action:"down"` 这类作业
   **立即完成却刻意保留持键**（否则 `down` 没有意义），此时没有任何步进动作在跑 ⇒ `expiresAtTick`
   到了也**没有人结算**，键会一直按着，直到下一次任意输入交互顺带结算为止。这不是计时问题
   （`host.clientTick()` 有墙钟兜底），而是「没人去结算」——「不允许无限期持有」（§3.2）在空闲期不成立。
   故**输入持键的到期结算**额外由**既有的** `ControlPlaneTickHandler` 每客户端 tick 调一次幂等的
   `InputExpiryPump.tick()`：它只调 `expireDue()`，**不**推进 `advanceTick()`（避免同 tick 双推进
   让 `drivenTicks` 不可解释）。
   这**不**违反第 2 条【禁令】：它不是新增 `ClientTickEvent` 订阅者，只是复用既有那一拍。
   完整裁决、代价与诚实边界见 §12.1 **D-7**。
2. `【禁令】` 三方**都不得**新增 `ClientTickEvent` 订阅者（现有设施的最省冲突路径就是「零新共享文件」；
   新增订阅者会与 `ControlPlaneTickHandler` 的排空顺序耦合）。
3. `【要求】`（#166 DR-13：落点按实现改正）作业的释放挂在**步进动作基类的收尾回调**上，即
   `mc/SteppingActionBase.java` 的 `finally → onFinish(ctx)`（三条路径——正常完成/异常/超时——
   **统一**覆盖；`input.key`/`input.mouse` 各自的 `onFinish` 调 `releaseJob`）。
   `core/ActionSteppingExecutor` 的 `catch` 分支里**没有**释放调用，文档此前把落点写成那里是错的
   ——效果不是变弱而是更强（成功路径也被收尾覆盖），但逐字对账必须指向真实落点。
   `【要求】` **不**挂 JVM hook 作为作业级释放手段；JVM hook（进程级兜底）只做 `best-effort`（§3.4 路径 5）。
4. `【要求】` `deliver` 必须**非阻塞**：队列满时立即 `CP-STATE-001`，不许在 tick 线程上等队列腾空。
5. `【要求】` 四个 🔴 共享文件（`ActionRegistrar` / `ActionDescriptor` / `CaseRunAction` / `CaseValidator`）
   **同一时刻只允许一方改动**；T2-A 与 T2-B 的并行前提正是「都不改这四个」。

### 9.4 显式待办：`ActionDescriptor` 的自描述字段

1. `【要求】` **返回值侧**的 `means:"input"` 已在本契约冻结（§10 第 3 条），**与** `layer`/`semantics` **并列，
   不替代**。
2. `【已履行，v1.8】` `ActionDescriptor` 新增**可选**自描述字段 `means`。
   **实现方式使原来的风险登记不再成立**：字段**不设默认值**——`null` 时自描述 JSON 里
   **不出现**该键，故既有 43 个动作的 JSON **逐字节不变**（不必牵动 `ReadSurfaceTest`、
   `ExportActionsDescriptorTest` 与 A3 基准）。只有输入族写它（值 `"input"`）；
   「缺省 = 未声明，**不**推断成任何默认值」已写进 `contract.md` §2.2 的硬规则。
3. `【已履行，v1.8】` 原文「现有防线**不**覆盖字段集合，这个改动不会被离线测试拦住」的缺口**已补**：
   `InputRegistrationTest` 逐动作断言**字段集合**（既有动作必须逐字不变，输入族只多 `means` 一个键）。
   因此「给 `means` 加个默认值」这类会**静默**改变 43 个动作 JSON 的改动，现在会被离线测试当场拦住
   （旧 §11.2 第 18 条由此关闭）。

---

## 10. 与既有分层的关系

### 10.1 两个维度，不可互代

1. `contract.md` 的 **L0 / L1 / L2** 回答的是「**谁做、经由什么能力面做**」：L0 = 直接设定世界/实体/玩家/背包
   状态（布景）；L1 = 经由玩家路径执行；L2 = L0/L1 的有序编排（只有 L2 允许宣称「端到端」）。
2. 本族的 **输入手段** 回答的是「**谁把事件放进游戏**」：事件由 `input.*` 经游戏的输入队列进入，
   由**游戏自己**路由。
3. `【要求】` 二者是**正交的两个维度**：L0/L1/L2 是**能力面**，输入手段是**投递面**。
   「用输入手段驱动世界」**不产生** L1 结论——L1 的定义是「经由玩家路径执行」，而输入手段是
   「让游戏以为玩家操作了」，两者是不同的证据来源。

### 10.2 三个不同层级的断言，必须分别标注

| # | 断言 | 取得方式 | 不得用谁代替 |
|---|---|---|---|
| 1 | **输入成功**（事件进了游戏并被消费者看到） | `input.*` 的 `delivered` + `consumer.chain` + 队列深度回落；`【实测】`可判别：队列注入 ⇒ Forge `KeyInputEvent=1`，直接写 `KeyBinding` 状态 ⇒ **0** | **不能**证明任何世界变化 |
| 2 | **操作目标正确**（路由到了你想要的控件/方块/界面） | 独立读面（`read.*`、服务端权威回读、控件自身状态） | **不能**用 `input.*` 自己的返回值代替 |
| 3 | **流程成立**（端到端） | 只有 L2（`case.run` + `criteria`）允许宣称 | **不能**用单条输入动作的结果代替 |

`【要求】` 每条结论必须声明它在哪一层取得；三者的结论**不互替**。

### 10.3 `means` 字段（手段归因）

1. `【要求】` 本族**所有**返回值带 `means:"input"`（与既有 `layer:"L0"/"L1"` 与 `semantics` **并列**，
   **不是**替代）。
2. `【裁定】` 本族返回值**不携带** `layer` 字段（值为 `null`）。理由：`layer` 的取值域是
   `L0`/`L1`/`L2`，而输入手段不属于其中任何一层（§10.1 第 3 条）；填一个不对应的 `L` 值比留 `null`
   更容易误导判据。**此裁定需 Lead 复核**（`contract.md` §4.6 第 6 条把 `layer` 与 `semantics` 写成
   「成对出现」，本族是该写法的**第一个例外**）。

### 10.4 与既有 L1 动作的关系（补集，不是替代）

1. `【实测】` 现有 `player.*` 系列**绕过输入层直接打点**（`PlayerControllerMP` / `NetHandler`），
   且 `player.gui` 的描述里明确写「**GUI 内非槽位按钮点击**（机器模式按钮、JEI 面板等）**不在范围**」。
2. `【要求】` 输入手段是那条**范围外缺口的补集**（`player.slot_click` 够不到模组 GUI 控件），
   不是 `player.*` 的替代品：同一件事用两条手段做，**必须分层标注**、结论不互替——
   这正是 `means` 字段存在的理由。

---

## 11. 术语表与未实现清单

### 11.1 术语表

| 术语 | 定义（本文口径） |
|---|---|
| **键位标识** | 游戏键位描述名（`key.forward` 一类，来自运行期 KeyBinding 注册表）或 LWJGL 键码整数。**不是** SDL scancode，**不是**物理按键 |
| **LWJGL 键码** | MC/lwjgl3ify 事件队列里的键编号（`KEY_W=17` 一类）；与 SDL scancode 是**两套**编号 |
| **投递（deliver）** | 把事件写进 `Keyboard.eventQueue` / `Mouse.queue`。**这是设施能观测到的最后一步** |
| **已处理（processed）** | 事件在**下一个** `runTick` 被消费者取走之后。设施**不**声称能观测到业务后果 |
| **消费链（consumer chain）** | 当前由游戏选择的输入消费者集合：`gui`（屏幕的 `handleInput`）或 `world`（世界闸门内的分派）或 `none`。由 `currentScreen` / `allowUserInput` 决定，设施**不干预** |
| **事件队列面** | 队列 + `next()/getEvent*` 构成的面（GUI 回调链、`KeyBinding` 更新链、Forge `KeyInputEvent`/`MouseInputEvent`）。本族**覆盖**这一面 |
| **物理轮询面** | `isKeyDown`/`isButtonDown` 读的 SDL 物理状态数组。本族**不覆盖**，且每帧被 SDL 覆写 |
| **持键表（held keys）** | 设施记录「已投递按下、尚未投递抬起」的条目表；按作业归属，条目必有 `expiresAtTick` |
| **持有时限** | 单条目持有上限 **1200 tick**；到期由设施自动投递抬起并报 `autoReleased` |
| **GUI 缩放坐标** | `ScaledResolution` 下的 GUI 坐标（原点左上、Y 向下），与 `GuiScreen.mouseClicked(mouseX, mouseY, …)` 同口径。`input.mouse op:move` 的**唯一**入参口径 |
| **事件队列坐标** | `Mouse.getEventX/getEventY` 的坐标系（Y 自上而下，`height - eventY*height/displayHeight - 1`）；与 SDL 窗口坐标（Y 自下而上）差一次翻转与一次缩放 |
| **命中集（hit set）** | 模组 GUI 每帧重建的「光标下有哪些控件」集合；位置取自 `Mouse.getX/getY` ⇒ 投递位置后须等 **≥2 tick**。本族**不**直接操作命中集 |
| **注入点** | 客户端 tick 的 `Phase.END`：在 tick N 的 END 投递 ⇒ 事件在 tick N+1 的 `runTick` 被消费 |
| **双总线** | FML 的 `FMLCommonHandler.bus()` 是独立总线，`fireKeyInput()/fireMouseInput()` post 在那里；只挂 `MinecraftForge.EVENT_BUS` 会看到「全 0」的假象（观察方必须双挂） |
| **手段（`means`）** | 结论的**投递面**归因，取值 `"input"`；与能力面 `layer`（L0/L1/L2）正交 |
| **四边界** | 受理 / 排队 / 已投递 / 已处理（§4.1）；四者不可互代 |

### 11.2 未实现清单（本单冻结但**未**实现，逐条，防下游误当已具备）

| # | 未实现项 | 判据/影响 |
|---|---|---|
| 1 | **GUI 文本路由未打通** | P0 实测：`GuiChat.fieldText` 可读且为空，`addCharEvent` 与「键事件自带 codepoint」两条都未到达 ⇒ `input.text` 的 `ranges` 为空、`supported:false`、`route:{world:false,gui:false}`，任何非空请求 `CP-STATE-001` |
| 2 | **`input.key` 的 codepoint 通路未验证** | 只有键位那一半被实机证过；「同一事件自带字符」未证 ⇒ 在 `input.state.notImplemented` 里单列 |
| 3 | **键盘侧队列深度的鼠标侧对应物不存在** | `Mouse` 无公开深度探针 ⇒ 鼠标的「已投递」不可独立复核、`physicalConcurrent` 鼠标侧只能 `"unobservable"` |
| 4 | **无取消能力** | `core` 层零 `cancel`、端点表无取消端点 ⇒ §7 的「作业取消 ⇒ 释放」路径**不存在** |
| 5 | **无世界卸载/断连/关服钩子** | `ClientDisconnect`/`WorldEvent`/`onWorldUnload`/`unloadWorld`/`FMLServerStoppingEvent` 全零命中 ⇒ 离图**不**触发释放，契约**不承诺** |
| 6 | **不承诺崩溃后清理** | P0 实测：进程崩溃时状态随 JVM 消失（§3.4 路径 5 只做 best-effort） |
| 7 | **轮询面不覆盖** | `Keyboard.isKeyDown`/`Mouse.isButtonDown` 型判定（Shift/Ctrl/Alt 组合、`GuiContainer` 的 Shift 点击、NEI 快捷键、`SyncedKeybind`、MUI `Interactable`）不随队列注入变化 ⇒ 组合键只保证事件序 |
| 8 | **`input.mouse op:relative` 的失焦生效未验证** | 消费门是 `mc.inGameHasFocus && Display.isActive()`；无人值守失焦是常态 ⇒ [未验证]，且**禁止**靠改 `displayFocused` 绕过 |
| 9 | **坐标换算的实机自校准只覆盖两种上下文** | 已在 `854×480`（`scaleFactor 2`）与 `1898×1084`（`scaleFactor 4`）两种窗口/尺度下核对：动作回读与能力面 `observedNowGui` **两面一致且 ±1 内**。**仍未校准**的是 HiDPI 的真实像素缩放——`Display.getPixelScaleFactor` 反射读不到（落 `1.0` 兜底并如实进 `warnings`） |
| 10 | **`read.input` 读面不存在** | 现有 9 个 `read.*` 无一条读输入侧状态 ⇒ 「注入有没有生效」缺第二观测面（本族自带 `input.state`，但它是能力面不是业务读面） |
| 11 | **场景守卫会关聊天框** | armed 期间每 tick `displayGuiScreen(null)` 会清掉 `GuiChat` 一类界面 ⇒ 聊天框路径在场景会话期间不可用（源码推断，**未实机验证**） |
| 12 | **组合键事件序与队列满没有独立实机判据** | §2.8 的口径已冻结为「只保证事件序」，但没有一条实机判据证明「顺序确实成立」；队列满（`CP-STATE-001` 零写入）难以定向触发 ⇒ **未测 ≠ 通过** |
| 13 | **滚轮符号口径未实机校准**（#166 DR-2） | §2.7 第 2 条把「由原版 `changeCurrentItem` 的行为实机校准后写死」写成实现的义务，而 `input.state.wheel` 如实报 `signVerified:false` + `signNote`（该义务未完成）⇒ 正档/负档的方向**没有判据**，调用方不得据 `sign` 下方向判据；补判据前不得删本条 |

`【要求】` 本清单与 `input.state.notImplemented` **同源**：实现一项就同时删两处，**不得**只删一处。

### 11.3 v1.8（#165）在本表里删掉了什么

| 旧 # | 已完成的项 | 证据（可复核） |
|---|---|---|
| 1 | 五个动作全部未实现 | `ActionRegistrar.registerInputActions`；`GET /cp/v1/actions` 的 `count` 48；`InputRegistrationTest` |
| 2 | 契约版本未前进、`since` 未写入 | `Contract.VERSION = "1.8"`；五个描述符 `.since("1.8")` |
| 3 | `ActionDescriptor` 的 `means` 自描述字段 | `ActionDescriptor.means()`（可选、不设默认值）；`contract.md` §2.2；`InputRegistrationTest#meansComesFromTheSelfDescriptionAndDoesNotLeak` |
| 17 | `input.state` 的字段无真值来源 | `InputStateAction` 注册；`InputStateProviderImpl` 组装；该动作**已注册**（真值来源是 T2-B 的探针） |
| 18 | `ActionDescriptor` 的字段集合无离线防线 | `InputRegistrationTest#descriptorFieldSetIsFrozenAndOnlyGainsMeansForTheInputFamily` |
| 10 | **GUI 截图取证面不存在** | 三轮独占 runClient 验收：`shot.multi {gui:"screen"}` **通过** —— meta 里 `guiHidden=false`、`guiCapture` 1 项且 `drawn=true`、`screen=net.minecraft.client.gui.inventory.GuiContainerCreative`；默认路径 `guiHidden=true` 且**不含** `guiCapture`（W7b/W7c） |
| 13 | **§9.2 的 G1 扩展未实现** | 三轮验收：`cases/input-multitick.json` 的 `case.validate` 通过、`case.run` 的 `action` 段跑出 4 个输入步产物、**跨帧证据**（`tap deliveredAtTick=7967 → down 7988 → up 7991`）成立、跑完 `held.count=0`（无持键泄漏） |

**注意**：上表只删「已落地**且**有实机/机械证据」的项。**第 2 条（codepoint 通路）不删**（只有键位那一半被证过）；
**第 9 条（坐标实机自校准）只收窄不删**（两种尺度已核对，HiDPI 真实像素缩放仍未校准）；
新增第 12 条（组合键事件序与队列满无独立实机判据）——**未测 ≠ 通过**，如实登记。
`【#166 追加】` 新增第 13 条（滚轮符号未实机校准，DR-2）：它原先**只在源码里**被声明为未验证
（`input.state.wheel.signVerified:false`），文档与 Java 清单**两边都漏** ⇒ 现在两边同时登记。
`【同源，机械防线】` §11.2 的条数与 `InputCapabilities.NOT_IMPLEMENTED` 的条数由离线测试
`InputCapabilitiesDocParityTest` 强制相等（只改一边即红）；`input.state.notImplemented` 必须
**逐条包含**该清单（`InputStateProviderImplTest#notImplementedIsSupersetOfTheCapabilityTruthTable`）。

---

## 12. Lead 裁决与退役验收（#162 收口）

### 12.1 本轮裁决登记（起草方提出、由 Lead 定调；下游不得再单方面改）

| # | 议题 | 裁决 | 理由（可复核） |
|---|---|---|---|
| D-1 | `input.*` 返回值是否带 `layer` | **不带**（值 `null`），只带 `means:"input"` + `semantics` | 输入手段与 L0/L1/L2 **正交**；填一个不对应的 L 值比 `null` 更误导判据。`contract.md` §4.6 的「`layer`/`semantics` 成对」规则在此登记为**显式例外**（首个） |
| D-2 | 捕获会话（`captureArmed`）期间是否拒 `input.*` | **不拒**，只如实报告 `consumer.captureArmed` | 输入不写世界，且主菜单/暂停菜单的 GUI 输入是合法场景（此时世界未加载）；「拒」会凭一个未验证的担忧砍掉合法能力。**风险登记**：取证期间注入可能扰动画面，由调用方据 `captureArmed` 自行决定。`【#166 DR-12 收口】` 该字段此前**只**在 `input.state.consumer` 里，四个可写动作的 `consumer` 读不到 ⇒ 补偿措施对绝大多数调用方落空；现在四个可写动作与 `input.state` **同源**（`CaptureSession`）都报它 |
| D-3 | G1 的 `holdTicks` 位置 | **动作步对象顶层**（与 `params` 并列；出现在 `params` 内即 `CP-VALID-002`） | 与既有 `case-file.md` 里步进语义的归属一致：跨 tick 是**编排**属性，不是动作参数 |
| D-4 | 持键是否允许「无限期直到显式 release」 | **不允许**。单条目上限 1200 tick，到期自动抬起并报 `autoReleased` | 「无期限持有」叠加「现有设施无取消能力」= 不可回收状态；宁可到期自动收口并如实报告 |
| D-5 | 覆盖矩阵的表格形态 | 接受「状态/消费点合并一格」的 6 列主表 + 清理件附加表 | 可读性优先；行数与覆盖项在 `input-coverage.md` §2.2 有核对 |
| D-6 | 负对照的独立观测面（原 G6）与自描述字段集合防线（原 G8） | ① **G6 由本族 `input.state` 承担**（它就是输入侧读面，已冻结字段）；②「`input.*` 返回值与 `ActionDescriptor` 的**字段集合断言**」列为 **T2/T3 交付项**（见 §12.3），不留在「未实现」里当借口 | 没有独立观测面的负对照等于自证；没有字段集合断言则契约漂移只能靠下次实机 A3 才发现 |
| D-7 | 持键的**到期结算**是否只由步进动作的 `advance` 驱动（§9.3 第 1 条） | **不**。到期结算**额外**由**既有的** `ControlPlaneTickHandler` 每客户端 tick 调一次幂等的 `InputExpiryPump.tick()`（它只调 `expireDue()`，**不**推进 `advanceTick()`） | §9.3 第 1 条把「唯一 tick 驱动」冻结为步进 `advance`，但 `input.key action:"down"` **立即完成却刻意保留持键** ⇒ 此时没有任何步进动作在跑 ⇒ `expiresAtTick` 到了**没人结算**，键会一直按着，直到下一次任意输入交互顺带结算。这不是计时问题（`host.clientTick()` 有墙钟兜底），而是**没人结算**——D-4 的「不允许无限期持有」在空闲期因此不成立。**不违反 §9.3 第 2 条**：它不是新增 `ClientTickEvent` 订阅者，只是复用既有那一拍。**代价登记**：泵在第一个客户端 tick 上会首次构造运行时单例（一次性、微秒级），构造失败时只 WARN 一次并如实认为「到期结算不可用」，不刷屏、不假装在跑。**边界（不因本裁决变绿）**：崩溃（状态随 JVM 消失）与离图/断连（无钩子）两种情形仍不承诺——它们继续留在 §11.2 |

### 12.2 退役与删除验收（工作区 AGENTS.md「架构替换的退役纪律」#171 的落地）

本设施**不是**对既有语义 API 的替换（父单 #160 明确：输入手段与 API 手段**并列**，API 不重写为输入宏）。因此本单的退役义务落在两处，且都必须给出删除验收：

| 被替代的旧机制 | 新责任归属 | 删除验收（缺一不可） |
|---|---|---|
| **「为每条不可达路径补一个专用 API 动作」这一扩展方式**（#159 的核心论断） | 完备性责任归**输入手段**；API 层只负责效率、确定性与可判据 | ①本契约 §1.3 的能力定位写明「不承诺任意未来模组永久完备」；②T6 必须有一条**从未被适配过**的真实控件经通用输入走通（负对照：为其补专用分支即判失败）；③#154/#155 的修法**不得**再新增专用 API 动作 |
| **P0 临时探查器械**（`feat/cp-input-probe` 上的 `debug.input.probe` 与 `probe-input.ps1`） | 无（它是探查工具，不是能力） | ①该分支**不并入**集成与 main；②契约冻结后它不再被任何交付引用（本文只引用其**结论**，不引用其代码）；③归档该分支时按「证据已上传 Gitea」处理（#161 附件） |

**阶段间暂存项**（必须有负责人与退出阶段，不得无限期挂着）：

| 暂存项 | 负责人 | 退出阶段 |
|---|---|---|
| ~~`input.*` 五个动作「已冻结未实现」~~ **已于 v1.8 退出** | T3（#165） | **已完成**：五个动作注册 + 契约版本前进到 1.8 + 计数注释/两处断言同步 + §11.2 对应行删除（见 §11.3） |
| ~~`case-file.md` §3.2 的同步性口径未改写~~ **已于 v1.8 退出**（#166 DR-16 据实改正：本条此前仍写「尚未退出」，属过期表述） | T3 持有者（共享文件单一持有者） | **已完成**：`case-file.md:122-201` 已改写为 G1 跨帧输入步的固定程序（例外集合 `:149`、步骤顶层 `holdTicks` `:158`、段语义 `:185`），§9.2 的 8 条回归面由 `CaseActionHoldTicksTest` 与实机轮次承载 |
| ~~`input.state.notImplemented` 占位字段~~ **已于 v1.8 退出** | T3（#165） | **已完成**：按「实现一项删一处」与 §11.2 同步（`InputCapabilities.NOT_IMPLEMENTED` 删 4 条；`InputStateProviderImpl.frozenNotImplemented()` 删「契约版本未前进」一条）。`【#166 DR-9】`该第三份字面清单**已整份删除**：现在 `input.state.notImplemented` 的唯一基是 `InputCapabilities.NOT_IMPLEMENTED`（余下只追加动态缺口） |
| 投递类失败信封的 `context.state` 未单列（§7 第 6 条的诚实边界） | T2-A 持有者（`InputRuntime` / 动作层错误构造点） | **下一批**：`InputSupport.fromRejections` 需要拿到当前态才能补该字段；在此之前调用方从 `context.hint` 的 `state=…` 文本读（§7 第 6 条已如实登记） |

### 12.3 T1 收口判据（本单关闭条件，逐条可判定）

1. 两份契约文件在集成分支可读，且 `contract.md` §4 有指向它们的**指针**（不复制内容）；
2. 契约对**已实证/未实现/不可达**三态无混淆（§11.2 的未实现清单与 P0 判据一一对应；v1.8 后为 13 条，
   已完成项移入 §11.3 并附机械证据）；**#166 起该条数与 `InputCapabilities.NOT_IMPLEMENTED` 由
   `InputCapabilitiesDocParityTest` 强制相等（只改一边即红）**；
3. 下游可分叉：T2-A / T2-B / T3 的边界（§9）明确到「谁拥有哪些文件」，且四个共享文件同一时刻只有一个持有者；
4. 全量测试仍绿（本单只增文档；若文档守卫测试解析了新文件，必须一并处理）；
5. **新增交付项**（D-6②）：「`input.*` 返回值字段集合」与「`ActionDescriptor` 的 `means` 字段」各配一条离线断言——随 T2-A 合并，不留在本单。

