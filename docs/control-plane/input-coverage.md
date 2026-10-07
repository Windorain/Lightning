# 输入覆盖矩阵与负对照目录（A1 / A7）

> 本文件是 Gitea **#162（T1）** 的**结构论证**那一半：**只回答「覆盖到哪里、哪里覆盖不到、怎么证伪」**。
> 接口正稿（动作名、参数、返回值、错误码）不在本文件，见同批 `docs/control-plane/input-contract.md`。
> 本文件**不引入**正稿之外的新机制、不改任何动作语义、不下「实现完成后必然成立」的断言。

## 0. 术语、口径与证据来源

### 0.1 统一术语（与正稿一致，全文照用）

| 术语 | 含义 |
|---|---|
| 动作族 | `input.key` / `input.text` / `input.mouse` / `input.release` / `input.state` —— 控制面输入侧的五族动作名 |
| 投递后端 | lwjgl3ify 的 Java 事件队列（`org.lwjglx.input`，类加载期由 RFB 从 `org.lwjgl.input` 重定向而来） |
| GUI 链 | `Minecraft.java:1731 currentScreen.handleInput()` —— 屏幕打开时**唯一无条件执行**的输入路径 |
| 游戏链 | `Minecraft.java:1771` 闸门之后的 `:1776`（鼠标循环）与 `:1837`（键盘循环）分派 |
| 已投递 | 事件已进入队列（`已投递 ≠ 已被消费`） |
| 已处理 | 某消费者已在该 tick 内把事件取出并执行了副作用（`已投递` 与 `已处理` **是两件事**） |
| 手段归因字段 | `means:"input"` —— 动作返回值里声明「本条结论由输入路径取得」（对应 P0 缺口 G4，字段落点见正稿） |

**动作族的边界（本文件口径）**：`input.release` 是**独立的释放/清理族**（不是 `input.key` 的参数分支），
因为释放承担「清 `KeyBinding.pressed`、清 GUI 拖拽残余、清 `Input.held`」三类清理，
与「按下」在时序上有独立的跨帧要求（见 §3、§5）。

### 0.2 行号与路径口径（**本文件不产生新行号**）

本文件所有 `文件:行号` **转引自**下列 P0 已完成的只读研究报告与实机日志，行号一律沿用其原值：

| 代号 | 来源 | 用途 |
|---|---|---|
| `PV` | `temp/cp-input/p0/paths-vanilla.md` | 原版 1.7.10 + Forge 的源→状态→消费者→阶段矩阵、五候选注入点漏项、闸门 `Minecraft.java:1771`、GUI 链 `:1731`、`unPressAllKeys` |
| `PL` | `temp/cp-input/p0/paths-lwjgl3ify.md` | 生产者→队列→消费者链、SDL 后端、可行注入点清单、失焦事实、系统鼠标禁忌 API |
| `PG` | `temp/cp-input/p0/paths-gui-mod.md` | MUI1/MUI2 控件事件链、命中集跨帧、两类控件的 gates |
| `FA` | `temp/cp-input/p0/facility-audit.md` | 现有编排/产物/自描述、缺口 G1–G10、共享文件与集成点 |
| `R5`/`R6` | `temp/cp-input/probe-run-5.log` / `probe-run-6.log` | P0 实机证据：判据名与判定结果 |

引用简式：`PV:A2-1771` = `PV` §A2 的行 1771；`PL:2.2` = `PL` §2.2；`PG:4.3` = `PG` §4.3；`FA:G4` = `FA` §9 缺口 G4。
**凡本文件出现的裸行号（如 `Minecraft.java:1771`），全部可在上述四份报告的对应小节逐字找到**；
若某条在本文件中被写成 `[本文件新增引用]`，表示它是从报告正文行内文句转写、未在报告表格中单列。

### 0.3 状态标记

| 标记 | 含义 |
|---|---|
| 已证 | P0 实机（`R5`/`R6`）产出该判据且为 OK |
| 未通过 | P0 实机产出该判据且为 XX（红） |
| 未测 | 该判据在 `R5`/`R6` 中**根本没有出现**（不是「测了但失败」） |
| 未验证 | 只有源码/字节码证据，无运行期证据（P0 报告自身的标记，本文件照抄不放宽） |

**「未测」与「未验证」不可互换**：前者是「判据不存在」，后者是「判据存在但只有静态证据」。
本文件任何地方**不得**把「未测」写成「未通过」，也不得把「未验证」写成「已证」。

---

## 1. 覆盖范围声明（限定版本与条件）

### 1.1 承诺的版本与条件（**逐条限定，超出即不承诺**）

| 维度 | 承诺值 | 出处 |
|---|---|---|
| Minecraft | 1.7.10 | `PL:0.1` 版本口径 |
| Forge | 10.13.4.1614 | `PG:0.2`（`MUI2S\gradle.properties`）、`PV:G` 第 5 项 |
| 运行期 LWJGL 变体 | **lwjgl3ify 3.0.8**（`runClient17/21/25` 族），后端 **SDL 不是 GLFW** | `PL:0`（实机 classpath 与 `fml-junk-earlystartup.log` 的 `lwjgl3ify@3.0.8`）；`PL:0` 后端判定 |
| ModularUI（MUI1） | **运行期 1.3.1**（本地源码 1.3.2，行号按源码） | `PG:0.2` |
| ModularUI2（MUI2） | **运行期 2.3.72-1.7.10**（本地源码 2.3.50-1.7.10，行号按源码，签名已 `javap` 核对） | `PG:0.2`、`PG:3.0` |
| 无人值守前置 | run 目录 `options.txt` 已钉 `pauseOnLostFocus:false`；`Display.isActive()==false`（真失焦） | `PL:4.4`；`R5:37` / `R6:55` 的 `E1.unattendedDisplayed` |

### 1.2 明确不承诺（原文口径，**不得省略**）

1. **不承诺对任意未来模组永久完备。** 本文件的完备性论证（§3）只在 §1.1 的版本组合下成立；
   任何新模组、任一模组版本升级、任一 lwjgl3ify / MUI 版本变化都可能引入新的消费链或新的旁路，
   论证随之失效（复核责任见 §8）。
2. **一个陌生控件成功只是必要实证、不是充分证明。** 在某个具体控件（例如 `fluidAutoOutput` 这类 `ToggleButton`）
   上点中一次，只能证明**那一条链**在该版本下可达；它**不能**推出「所有控件都能点中」，
   因为每个控件的 gates 不同（`PG:9.2` 的 B1–B9 逐条不同），且命中集有跨帧要求（`PG:4.3`）。
3. **多个「结构性不可达」项只有静态证据**（§5），按 `未验证` 标记，不得当作已证结论使用。
4. **P0 的实机窗口是 `feat/cp-input-probe` 树**（`R5`/`R6` 的 run 目录路径），
   不是本树；本树的实机复现尚未发生（`未测`）。

---

## 2. 矩阵 A：输入源 → 状态 → 消费点 → tick 阶段 →（本设施）投递方式

**列语义**：`原版状态载体` 与 `消费点` 合并在一格内（状态在上、消费点在下）；
`投递方式` 一律指**投递后端 = lwjgl3ify 的 Java 事件队列**（`org.lwjglx.input`），入口名取自 `PL:1` 清单。
`已投递/已处理` 分列：同一行内可能出现「已投递但本上下文不处理」。

| # | 输入源 | 原版状态载体 → 消费点（`文件:行`） | tick 阶段 | 投递方式（本设施） | 已投递 / 已处理 |
|---|---|---|---|---|---|
| A-01 | **键按下**（世界态，无 GUI） | `KeyBinding.pressed`(`KeyBinding.java:24`)+`pressTime`(`:25`) → `Minecraft.java:1781`(`setKeyBindState`)/`:1839`/`:1843`(`onTick`) → `MovementInputFromOptions.java:23-44`、`Minecraft.java:1967-2058` 各 `isPressed`/`pressed` 环；`:1964` Forge `InputEvent.KeyInputEvent` | tick（`1678-2155` 内，键盘循环 `1837-1965`） | `Keyboard.addRawKeyEvent(KeyEvent)`（`PL:1` #1）；队列满静默丢（`PL:2.2`），每 tick 必排空 | 已投递；已处理（实机 `E1.forwardPressedWhileHeld`，`R5:32`/`R6:50`） |
| A-02 | **键抬起** | 同上，`pressed=false`（`pressTime` **不重置**，`KeyBinding.java:41-52` vs `:28-39`） → 同上；`MovementInputFromOptions` 下一 tick 读到 false | tick | 同 A-01，`KeyEvent(state=RELEASE)`；**不得**伴随 `onTick` | 已投递；已处理（实机 `E1.forwardReleasedAfterUp`，`R5:33`/`R6:51`；滑行对照 `E1.deceleratedAfterRelease`，`R5:35`/`R6:53`） |
| A-03 | **键重复（repeat）** | `Keyboard.isRepeatEvent()`（原版唯一使用点 `Minecraft.java:2896`）+ `Keyboard.enableRepeatEvents` → `Minecraft.java:2896`（**屏蔽**重复触发）；文本侧经 `GuiScreen.java:370` 的 char | tick | lwjgl3ify `addRawKeyEvent` 在 `doRepeatEvents==false` 时**丢弃 REPEAT**（`PL:3.1`；`PL:3.6` 差异 1：3.0.8 常量池零命中 `INPUT_ALWAYS_REPEAT_KEYS`）；**只用 PRESS/RELEASE** | 已投递（PRESS/RELEASE 口径）；**REPEAT 的投递结果 `未验证`**（`PL:5` 第 6 项） |
| A-04 | **字符 / 普通文本** | `Keyboard.getEventCharacter()`（**唯一字符来源**） → `GuiScreen.java:370` → `keyTyped` → `GuiTextField`；NEI `GuiContainerManager.java:873-876`；MUI2 `ClientScreenHandler.java:310-317` | tick（GUI 链） | `Keyboard.addCharEvent(int key, int c)`（`PL:1` #1 附注、`PL:2.1`）；或键事件自带 codepoint | 已投递；**未处理** —— 实机两条路线均红：`E3.charEventReachedRealGui`（`R5:42`/`R6:60`）、`E3.keyEventWithCodepointReachedGui`（`R5:43`/`R6:61`） |
| A-05 | **鼠标相对移动** | `MouseHelper.deltaX/deltaY`(`MouseHelper.java:12-14`)，取自 `Mouse.getDX/getDY`(`:39-40`，**读取即清零**) → `EntityRenderer.java:1041` → `:1044-1045` → `:1061/1065 setAngles` | **render**（`EntityRenderer.updateCameraAndRender`，`1013`） | `Mouse.addMoveEvent(SDL_MouseMotionEvent)`（`PL:1` #5） —— **唯一**能改 `dx/dy` 与 `latestX/latestY` 的入口 | 已投递；**本设施不承诺已处理** —— 消费前置 `EntityRenderer.java:1039 if (mc.inGameHasFocus && flag)`，`flag = Display.isActive()`(`:1023`)；失焦下整段跳过（`PL:4.3`）。**未测**（`R5`/`R6` 无对应判据） |
| A-06 | **鼠标绝对位置** | 无原版持久字段；事件口径 `Mouse.getEventX/Y` → `GuiScreen.java:331-332`；**渲染轮询口径** `Mouse.getX/Y` → `EntityRenderer.java:1077-1078` → `:1136/1138 DrawScreenEvent` → `GuiButton.java:84` 悬停、`GuiContainer.java:116-118 theSlot`；`GTNH\CodeChickenCore\...\GuiDraw.java:117-118`（**66 个调用点**，`PV:C11.4`） | **render**（`1077`）与 **tick**（`331`）**两套** | 同 A-05（`addMoveEvent` 同时喂两套口径） | 已投递；**部分已处理** —— 事件口径走 `getEventX/Y`，渲染口径走 `getX/getY`，**两套源天然撕裂**（`PV:C11.4`）；`PL:3.5` 注 `getEventX/Y` 对合成按键事件取的是真实光标。**未测** |
| A-07 | **鼠标按钮按下** | `KeyBinding.pressed`（**负键码** `j-100`，默认 `keyBindAttack=-100`/`keyBindUseItem=-99`/`keyBindPickBlock=-98`，`GameSettings.java:211-214`） ← `Minecraft.java:1780-1781/1785`；事件按钮态 → `GuiScreen.java:333-335` → `:344 mouseClicked`；Forge `MouseEvent.java:31-32` | tick | `Mouse.addButtonEvent(int,boolean)`（`PL:1` #3，传 **LWJGL 编号 0/1/2**）；**注入点击前必须先 `addMoveEvent` 把 `getEventX/Y` 放到目标**（`PL:3.3`） | 已投递；已处理（非槽位按钮实机：`E4b.clickOnNonSlotButtonWorked`，`R5:46`/`R6:64`；负对照 `E4c.negativeControlStillOpen`，`R5:25`/`R6:25`） |
| A-08 | **鼠标按钮抬起** | 事件按钮态；`GuiScreen.eventButton → -1`(`GuiScreen.java:353`) → `:346-354 mouseMovedOrUp`(`:264`)/`mouseReleased`(`:268`)；`KeyBinding.setKeyBindState(btn-100,false)` | tick | 同 A-07 的反向事件（`PL:9.1` 第 4 点：`ToggleButton` **可省** release，`Input.held`(`ModularPanel.java:940-949`)/`onMouseTapped`(`:478`) **必须** release） | 已投递；**该次实机的判据未单列** —— `R5`/`R6` 的 `E4b`/`E5e` 只判「点击命中/界面关闭」，未单列 release 判据 ⇒ `未测` |
| A-09 | **滚轮** | LWJGL 事件 `Mouse.getEventDWheel()`（**无持久字段**） → `Minecraft.java:1792`（换物品栏，**界面开着也生效**）、`GuiChat.java:170`、`GuiContainerCreative.java:599`、`GuiSlot.java:314`、NEI `GuiContainerManager.java:930`；另一累计器 `Mouse.getDWheel()`（LogisticsPipes 多处，`PV:C11.5`） | tick（`1792`）+ **render**（`GuiSlot.java:314` 在 `drawScreen` 内） | `Mouse.addWheelEvent(double)`（`PL:1` #4）；**必须逐点覆盖**，没有单一滚轮状态；注入 `±1.0` 最稳（`PL:3.4`） | 已投递；**未处理** —— 无对应判据 ⇒ `未测`；且 Angelica 的 `@ModifyExpressionValue`(`MixinMinecraft_Zoom.java:12-19`) 在 zoom 键按下时把滚轮值改成 0（`PL:3.4`） |
| A-10 | **GUI 切换（开/关/换）** | `Minecraft.currentScreen`(`:221`)、`GuiScreen.buttonList`(`:41`)/`selectedButton`(`:48`)、`Minecraft.inGameHasFocus`(`:260`) → `displayGuiScreen`(`Minecraft.java:829-873`)：`:841-843 GuiOpenEvent`、`:846-849 old.onGuiClosed()`、**`:859-861 setIngameNotInFocus()`**、`:862 ScaledResolution`、`:865 setWorldAndResolution`(`GuiScreen.java:285` → `:291/:296 InitGuiEvent`)；关屏 `:868-872`（`:870 resumeSounds`、`:871 setIngameFocus`） | tick（开屏发生于动作内；`1703-1717` 是屏幕自动开关） | **不需要注入**：走 `displayGuiScreen` 即已完成 90%（`PV:E` 第「GUI 切换」行） | 不适用（状态动作，非事件）；**实机已用**：`R5:20`/`R6:20 E4a.pauseMenuOpened`、`R6:31 E5b.containerGuiOpened` |
| A-11 | **失焦** | `Display.isActive()`（全树 3 处：`Minecraft.java:1075`、`:1381`、`EntityRenderer.java:1023`）；`inGameHasFocus`(`Minecraft.java:260`） → `EntityRenderer.java:1023-1035`（`!flag && pauseOnLostFocus && …` 且 `prevFrameTime>500ms` → `:1029 displayInGameMenu()`）、`Minecraft.java:1075`（全屏自动退出）、`:1381`（聚焦门：失焦时**拒绝**抢回） | **render**（`1023`） | **不注入**，只**保护**：钉 `pauseOnLostFocus:false`（开关点 `Minecraft.java:1917`，`PV:A5`）；`SceneSessionGuard` 已负责保存/还原（`FA:4.4`） | 已保护并实机证明：`E1.unattendedDisplayed`（`R5:37`/`R6:55`，`Display.isActive()=False` 下动作仍成立） |

### 2.1 三条附加行（矩阵 A 的「状态清理」件，不可省）

| # | 事件 | 载体/消费点 | 阶段 | 对本设施的含义 |
|---|---|---|---|---|
| A-12 | **进 GUI 清键** | `displayGuiScreen`(`:859-861`) → `setIngameNotInFocus()`(`Minecraft.java:1396-1404`) → **`KeyBinding.unPressAllKeys()`(`:1400`)** → `KeyBinding.java:116-120`（`pressTime=0; pressed=false`）；调用点唯一（`PV:A6`） | tick（开屏时） | **整个 GUI 存活期 `KeyBinding.pressed` 恒 false**，`getIsKeyPressed()` 恒 false（`PV:C11.3`）⇒ `input.key` 在 GUI 内**必然失效**，必须由 GUI 链消费 |
| A-13 | **失焦清键、但不清鼠标增量** | `unPressAllKeys()`(`:1400`) + `ungrabMouseCursor()`(`:1402`) → `MouseHelper.java:31-35`（**不改** `deltaX/deltaY`，与 `:20-26 grab` 不对称）；LWJGL 侧 `Mouse.getDX/DY` 累加器也不清 | render/tick | 失焦后回焦会出现「集中灌入」跳变风险（`PV:A5` `[未验证]`；`PL:5` 第 11 项）；**未测** |
| A-14 | **重复键使能是全局静态开关** | `Keyboard.enableRepeatEvents(boolean)`：开点如 `GuiChat.java:74/89`、`GuiContainerCreative.java:264/301`；lwjgl3ify 实现 `Keyboard.java:297-299` | tick（屏幕生命周期） | 注入文本时当前屏幕若没开它，`addRawKeyEvent` 直接丢 REPEAT（`PL:11` 第 13 项）⇒ 文本注入**必须带字符**（`PG:6`） |

### 2.2 矩阵 A 的行数核对（可判定）

- 矩阵 A 主表 **11 行**（A-01 … A-11，逐行对应任务点名的 11 个输入族，一一对应、无遗漏无合并）；
- 附加表 **3 行**（A-12 … A-14，均为「状态清理/开关」件，不是输入族）；
- **合计 14 行**。若未来新增输入族或新增清理件，**必须在本节更新行数**（§8 维护规则第 3 条）。

---

## 3. 矩阵 B：结构完备性论证（#159 的 ①② 论证）

### 3.1 论证的两个前提（原文口径）

- **①** 玩家的输入**只从同一组事件进**：`Minecraft.runTick()` 内只有两条 LWJGL 事件分派链
  —— `1731 currentScreen.handleInput()`（GUI 链）与 `1776/1837` 的 `Mouse.next()/Keyboard.next()` 循环（游戏链）；
  其余四个候选点（(i) `KeyBinding` / (ii) `mouseClicked` / (iv) `keyTyped` / (v) `PlayerControllerMP`）
  都是在**下游补动作**，不是输入入口（`PV:D12.(i)(ii)(iv)(v)`）。
- **②** 这组事件**设施都注入得了**：`PL:1` 的可行注入点清单 #1–#6（`addRawKeyEvent` / `eventQueue` /
  `addButtonEvent` / `addWheelEvent` / `addMoveEvent` / `Mouse.next()`）全部**只写 Java 内存/队列**，
  不触碰 OS 与系统鼠标（`PL:4.5`）。

### 3.2 ① 与矩阵 A 的逐项对齐

| 矩阵 A 行 | 该输入族的**入口**是不是「同一组事件」 | 依据 |
|---|---|---|
| A-01 键按下 | **是**：`Minecraft.java:1837 while (Keyboard.next())` | `PV:A2` |
| A-02 键抬起 | **是**：同上循环，`:1839 getEventKeyState()` | `PV:A2` |
| A-03 键重复 | **是**：同一队列；repeat 语义由 `Keyboard.isRepeatEvent()`(`:2896`) 读队首 | `PV:A6`；`PL:2.2` |
| A-04 字符 | **是**：`Mouse`/`Keyboard` 队列的字符读值（`GuiScreen.java:370`、`ClientScreenHandler.java:310`） | `PG:6`；`PL:2.1` |
| A-05 鼠标相对移动 | **否（唯一例外）**：它**不经事件分派链**，由渲染期 `Mouse.getDX/getDY`(`MouseHelper.java:39-40`) **轮询**消费 | `PV:A3`、`PV:E` 第「鼠标移动（相对）」行 |
| A-06 鼠标绝对位置 | **否（第二个例外）**：渲染轮询 `Mouse.getX/Y`(`EntityRenderer.java:1077-1078`) 与事件读值 `getEventX/Y`(`GuiScreen.java:331-332`) **两套并存** | `PV:C11.4`、`PV:E` 第「鼠标移动（绝对）」行 |
| A-07 鼠标按钮按下 | **是**：`Minecraft.java:1776 while (Mouse.next())` → `:1780-1785` | `PV:A2` |
| A-08 鼠标按钮抬起 | **是**：同上循环 → `GuiScreen.java:346-354` | `PV:A2`、`PV:B8` |
| A-09 滚轮 | **是（多点消费）**：`Mouse.getEventDWheel()` 全部读值与队列同源（`Minecraft.java:1792` 等 5 点） | `PV:C11.5` |
| A-10 GUI 切换 | **不适用**（是状态动作，不是事件族） | `PV:E` 第「GUI 切换」行 |
| A-11 失焦 | **不适用**（是 `Display` 状态，不是事件族） | `PV:A5`、`PL:4.1` |

**① 的准确表述**：玩家的**事件型**输入只从 `1731` 与 `1776/1837` 这**两条链**进；
**轮询型**读取（A-05/A-06 的渲染口径）**不在这条链上**，这是 ① 的固有边界（§3.4 第 1 条）。

### 3.3 ② 与矩阵 A 的逐项对齐（「设施都注入得了」）

| 矩阵 A 行 | 投递后端入口（`PL:1`） | 会不会动到系统鼠标/OS | 判定 |
|---|---|---|---|
| A-01/A-02/A-03 | `Keyboard.addRawKeyEvent(KeyEvent)`（#1） | **不会**（纯 Java 队列；`PL:4.5`） | 可达 |
| A-04 | `Keyboard.addCharEvent(int,int)`（#1 附注、`PL:2.1`） | **不会** | 可达（**实机未通过**，见 §7） |
| A-05/A-06 | `Mouse.addMoveEvent(SDL_MouseMotionEvent)`（#5，唯一入口） | **不会**（`addMoveEvent` 唯一外部调用是**只读**的 `Display.getPixelScaleFactor()`；`PL:4.5`） | 可达（需构造 lwjgl-sdl 结构体；`未验证`） |
| A-07/A-08 | `Mouse.addButtonEvent(int,boolean)`（#3） | **不会** | 可达（**实机已证**：`R5:46`/`R6:64`） |
| A-09 | `Mouse.addWheelEvent(double)`（#4） | **不会** | 可达（累积取整：注入 `0.3` 可能完全不产生事件；`PL:3.4`） |
| A-10/A-11 | 不需要注入（走 `displayGuiScreen` / 钉选项） | **不会** | 不适用 |

**显式禁忌（② 的负向边界）**：下列 API **会真实操作窗口/系统指针或阻塞主线程**，
本设施**禁止调用**（`PL:4.5`、`PG:9.3`）：`Mouse.setGrabbed(boolean)`（`Mouse.java:217-242`，含
`SDL_WarpMouseInWindow` 与相对模式）、`Mouse.setCursorPosition(int,int)`（`:349-357`，真的搬系统光标）、
`Mouse.setNativeCursor/setCursorIcon`（`:366-383`）；三者都经 `MainThreadExec.runOnMainThread`，
非主线程调用会阻塞。

### 3.4 ② 论证的**边界**（必须逐条列出，不得省略）

1. **`Keyboard.isKeyDown` 类直接读物理状态的读取者不在这条论证里。**
   它们读的是 `Keyboard.sdlKeyPressedArray`（`PL:1` #8；该指针由 `Display.java:342`
   `SDLKeyboard.SDL_GetKeyboardState()` 赋值），与 `eventQueue` **互不相通**，
   且每帧被 `SDL_PumpEvents`（`Lwjgl3ifyEventLoop.java:53`）重填。
   **`Mouse.isButtonDown` 同理**：读 `sdlMouseButtonFlags`（`Mouse.java:44`），
   每帧被 `Lwjgl3ifyEventLoop.java:110` 用 `nSDL_GetMouseState` **整体覆写**（`PL:1` #9）。
   P0 已证这类读取者的**存在与位置**（按 mod 分文件的清单见 §5.1）：`SyncedKeybind.java:125-129`
   （`GTNHLib`，走 `Keyboard.isKeyDown`）、NEI `KeyManager.java:34`（`ClientHandler.java:346-359`
   在 `ClientTickEvent.START` 调 `tickKeyStates()`）等。
   **口径澄清**：「已证」指**代码结构可证**（这些读取者不经过事件队列）；
   「**注入事件后它们不变**」这一**运行期反向验证尚未发生** ⇒ 该条标 `未验证`（§5.2 判据 P5）。
2. **两套状态无法用一条注入同时摆正。** 队列注入只喂 `Keyboard.next()/getEvent*`（GUI 回调链）；
   写物理状态数组只喂轮询者（且存活期 `[未验证]`，`PL:3.8`、`PL:5` 第 7 项）。
   因此**必须成对写、且接受 SDL 每帧覆写**（`PV:C11.7`）——本设施当前**只承诺队列那一半**。
3. **Forge 事件的 post 点跟着队列走，不跟着「状态」走。** `InputEvent.MouseInputEvent`(`Minecraft.java:1826`)、
   `InputEvent.KeyInputEvent`(`:1964`)、Forge `MouseEvent`(`:1778`) 都在循环体内 ⇒ 只在队列**排空**时 post；
   且 `:1778` 的取消语义会让该事件被 `continue` 跳过、连 `KeyBinding` 状态都不更新（`PV:0.1-4`）。
   ⇒ 在 `allowUserInput==false` 的 GUI 内，这些事件**本来就不工作**（`PV:C10.2` 的 `[推断]`），
   所以不需要为它们补事件；但**世界态注入必须**让它们收到事件，否则 Angelica Zoom、AE2 `KeyBindHandler`、
   GT `PowerGogglesEventHandler`、Botania `KeyHandler`、EnderIO `KeyTracker`、BloodMagic、
   MUI2 `ClientProxy` 在**世界态全部静默失效**（`PV:C10.2`、`PV:D12.(i)-3/4`）。
4. **`InputEvents.injectKeyEvent/injectTextEvent` 不是输入注入。** 它只到 `KeyboardListener`
   与当前 `currentScreen`，**不进** `Keyboard.eventQueue`（`PL:1` #7、`PL:3.7`）；
   真实按键是「两路都发」（`Lwjgl3ifyEventLoop.java:154` + `:186/202`）⇒ 只发这一路 ≠ 真按键。
5. **`1731 handleInput()` 排空队列的先后关系决定「谁吃到事件」。**
   GUI 链的 gate 只是 `Mouse.isCreated()`/`Keyboard.isCreated()`（`PL:2.3` A），**与 `allowUserInput` 无关**；
   而 1731 在 1771 之前 ⇒ `[推断]` 屏幕打开时游戏链的两条循环看不到事件。
   **该 `[推断]` 是 `PV` 多处结论的地基且仍未实机证实**（`PV:F` 第 2 项、`PL:5` 第 2 项）⇒ 标 `未验证`。
6. **L0 不是输入。** `scene.player.pose` / `scene.inventory.write` / `scene.tank.fill` 直接写状态
   （`contract.md` §4.4 的 `layer:"L0"`），**不经过**本文件任何一条链；
   §7 的负对照专门用它当「用 L0 代替关键动作」的判别器。

---

## 4. 矩阵 C：消费链归属

**三条上下文 × 两条链**。同一份注入落在哪个上下文，决定它被哪条链消费、以及结果差异。
**关键前提**：GUI 链（`Minecraft.java:1731`）**无条件执行**；游戏链（`:1771` 闸门后的 `:1776/:1837`）
只在 `currentScreen == null || currentScreen.allowUserInput` 时执行。
`allowUserInput` 的置真点只有 `GuiInventory.java:30`、`GuiContainerCreative.java:63`；
置假点 `GuiChest.java:26`、`GuiHopper.java:26`、`GuiScreenHorseInventory.java:29`；
**未显式设置的 `GuiContainer` 子类默认 `false`**（`GuiScreen.java:44`）——即**绝大多数 mod 机器界面在闸门内**（`PV:A2`）。

| 上下文 | 谁先消费（同 tick 顺序） | GUI 链结果 | 游戏链结果 | 判定差异（可判定） |
|---|---|---|---|---|
| **C-1 无 GUI**（`currentScreen == null`，无人值守常态） | 游戏链（1731 空转：无 `currentScreen`） | 不适用 | `KeyBinding.setKeyBindState/onTick`(`1781/1785/1839/1843`) 生效；`InputEvent.*` 与 Forge `MouseEvent` post；`1967-2058` 各 `isPressed`/`pressed` 环执行 | **唯一能驱动 `KeyBinding` 的上下文**；实机已证（`E1.*`，`R5:32-37`） |
| **C-2 普通容器 GUI**（`allowUserInput == false`，含绝大多数 mod 机器界面） | **仅 GUI 链**（1731 → `GuiScreen.handleInput`→`handleMouseInput`/`handleKeyboardInput`） | `GuiScreen.java:331-360` 完整分派（按下→`mouseClicked`、抬起→`mouseMovedOrUp`、纯移动→`mouseClickMove`）；MUI2 的 mixin 在此 post 自己的事件 | **整段不执行**：`KeyBinding` 不更新、`InputEvent.*` 不 post、Forge `MouseEvent` 不 post、`1967-2058` 动作环全部不跑 | **`input.key` 在此上下文必然失效**（`getIsKeyPressed()` 恒 false，`PV:C11.3`）；只有 `input.mouse`/`input.text` 有意义 |
| **C-3 无 `GuiContainer` 的 MUI2 界面**（`GuiScreenWrapper extends GuiScreen`，`allowUserInput` 默认 false） | 仅 GUI 链，**且被 MUI2 mixin 截断**：`GuiScreenMixin.java:28-38/40-50` 用 `@Redirect` 把 `handleMouseInput/handleKeyboardInput` 换成 post `MouseInputEvent`/`KeyboardInputEvent`（MUI2 自造类）；被 cancel 就 `return` | 走 `ClientScreenHandler.java:138-153`（`Mouse`）/`:106-134`（`Keyboard`），**不落到 vanilla 的 `mouseClicked`** | 同 C-2（不执行） | **这是「走正常路由」在 MUI2 上唯一成立的形式**：从 LWJGL 事件队列注入 ⇒ `handleInput` 消费 ⇒ mixin 自动 post ⇒ MUI2 自动处理，**注入方不需要手动 post 任何事件**（`PG:7` 第 1 点）；绕开队列（直接反射调 `mouseClicked`/`handleMouseInput`）⇒ 事件永不 post ⇒ MUI2 **完全无反应**（`PG:7` 第 2 点） |
| **C-4 玩家背包 / 创造模式界面**（`GuiInventory`(`:30`)、`GuiContainerCreative`(`:63`) 显式置 `allowUserInput=true`） | GUI 链先（1731），游戏链后（1823/1874） | 同 C-2 | **闸门成立 ⇒ 两条链都跑**：`:1823 currentScreen.handleMouseInput()` 与 `:1874 currentScreen.handleKeyboardInput()` 会在 1731 之后**再被调用一次** | **同一 tick 内可能两次分派**；队列为空时第二次不做事（`PV:D12.(iii)-6`）⇒ 注入时机不当会让同一事件**被两次分派中的一次吃掉而丢失**；`未测` |

### 4.1 「同一 tick 内多次调回调」与「队列注入」的差别（逐条可判定）

| # | 差别 | 依据 |
|---|---|---|
| 1 | **回调不是入口，是消费者**：`handleMouseInput` 的入参全靠 `Mouse.getEventX/Y/Button/ButtonState`，不先把事件状态摆正就会**把上一真实事件重放一遍** | `PV:D12.(iii)-1` |
| 2 | **队列消费时机不可控**：同一条鼠标队列有 **4 个消费方**在不同阶段跑 —— `1731`（tick，经 `handleInput:311`）、`1776`（tick）、`1823`（tick，`allowUserInput`）、**`GuiSlot.java:312`（渲染期，`drawScreen` 内，还顺手调 `currentScreen.handleMouseInput()`）** | `PV:D12.(iii)-2`、`PV:F` 第 7 项 |
| 3 | **直接调回调会漏掉事件**：Forge `MouseEvent`(`1778`)/`InputEvent.MouseInputEvent`(`1826`)/`InputEvent.KeyInputEvent`(`1964`) 都在 `Minecraft` 的循环里，**不在** `GuiScreen.handleMouseInput` 里 ⇒ 手动调它，这些事件永不 post | `PV:D12.(iii)-7`、`PV:D12.(ii)-8` |
| 4 | **直接调 `mouseClicked` 会漏掉跨 tick 状态**：`GuiScreen.eventButton`(`:49`)/`lastMouseEvent`(`:50`) 不被设置 ⇒ 拖动分支 `356-360` 永不成立（`mouseClickMove` 不触发）；`selectedButton`(`:48`) 无法在抬起时清理 | `PV:D12.(ii)-1/2` |
| 5 | **队列注入天然走 `:342-343/:353` 的 `eventButton/lastMouseEvent` 维护** ⇒ 修复了上一条；这是「队列注入」相对「直接调回调」的**结构性优势**，不是运气 | `PV:D12.(iii)` 「能到达」第 1 条 |

### 4.2 MUI1 / MUI2 的命中集跨帧管线（**两代节奏不同，必须分开写**）

| 代 | 命中集字段 | 重建点 | 重建节奏 | **「移动」与「按下」之间的最小间隔** |
|---|---|---|---|---|
| **MUI2** | `ModularPanel.hovering`（`ModularPanel.java:76` 声明） | `:211-228 findHoveredWidgets()`，由 `:114 registerFrameUpdateListener` → `ClientScreenHandler.onFrameUpdate()`(`:199-201`) → `ModularScreen.onFrameUpdate()`(`:273-283`) ← `MinecraftMixin.java:27` 在 `runGameLoop` 的 `startSection` ordinal 2 之后（= `MC:1049` 之后，**早于** `MC:1067` 的渲染） | **每 frame** | **≥2 个 `runGameLoop` 帧**：位置先在**渲染帧**写入 `GuiContext`（`DrawScreenEvent.Pre` → `ClientScreenHandler.java:157-162` → `GuiContext.java:67-71`），再等 1 帧让 `findHoveredWidgets` 用该位置重建 `hovering`，然后才让按下进队列（`PG:4.3`、`PG:9.1` 第 1-2 点） |
| **MUI1** | `Cursor.hoveredWidgets` | `Cursor.java:117-123 updateHovered()`，**唯一调用点** `ModularGui.updateScreen():448`，而 `updateScreen` 由 `MC:1752` 调、**在 `handleInput`(`MC:1731`) 之后** | **每 tick** | **≥2 tick**：位置先在 `drawScreen:124` 写入 `mousePos`，再等 1 tick 让 `updateScreen:448` 重建命中集，然后按下（`PG:2.5`、`PG:9.1` 第 2 点） |

**由此得到的四条可判定结论**：

1. **「一帧内直接调一次 `mouseClicked`」不够**（MUI1 打在上一 tick 的命中集上，MUI2 打在上一帧的命中集上）——
   `PG:4.4` 的四行表逐场景给出「够不够」。
2. **MUI2 的 `press`/`release` 必须是两个独立事件**：`Input.pressed(...)`(`ModularPanel.java:940-949`)
   只有 `!held` 时才记录；只发 press 不发 release ⇒ `held` 永真（`PG:4.3`）。
3. **`ToggleButton`/`CycleButtonWidget` 在 press 时就完成「改值 + 发包」，release 不是必需**
   （`PG:4.3`；MUI2 `AbstractCycleButtonWidget.java:164-177`、MUI1 `CycleButtonWidget.java:138-154`）；
   但依赖 `onMouseTapped`(`ModularPanel.java:478`) 的 `ButtonWidget` 组合需要 release。
4. **`theSlot` 最多滞后一帧**（`GuiContainer.java:116-118` 由渲染期 `drawScreen` 写入）⇒
   「先 move 再 key」在同 tick 内必有 1 帧错位风险（`PV:B8`、`PV:F` 第 9 项）⇒ `未验证`。

### 4.3 消费链归属的**覆盖缺口**（不属于本设施当前承诺）

| 缺口 | 位置 | 归属 |
|---|---|---|
| MUI2 只在 `GuiScreen.handleInput` 里 post 自己的事件 | `GuiScreenMixin.java:28-50`（`PG:9.2` B2） | **能**（必须走队列；绕开就彻底没反应） |
| 流体槽要求光标上有物品 | `FluidSlot.java:147-151`（MUI1 同构 `FluidSlotWidget.java:258-259`） | **不能**（`PG:9.2` B3） |
| 服务端再查一次光标物品 | `FluidSlotSyncHandler.java:142-145` | **不能**（`PG:9.2` B4） |
| `player.slot_click` 作用域只有 `Container.inventorySlots` | `SlotClickAction.java:145,197,243`（`PG:5.3`） | **不能**（结构问题） |
| GUI 打开时 `KeyBinding` 状态不更新 | `MC:1731` vs `:1837-1839` | **不能**（`PG:9.2` B7）⇒ 要 sneak 必须另找写入点 |
| MUI1 滚轮依赖 NEI 的 ASM 注入（`blocks.asm:101-107`） | `NEITransformer.java:153-158` | **能，但前提是 NEI 在场**（`PG:9.2` B8） |

---

## 5. 旁路清单（**必须标出不覆盖的**）

### 5.1 直接读**物理状态**的读取者（`Keyboard.isKeyDown` / `Mouse.isButtonDown`），按 mod 分文件

> 口径：这些读取者**不看 `KeyBinding`、不看事件**，只看 lwjgl3ify 的 SDL 物理态数组。
> 只调 `KeyBinding.setKeyBindState` 或只调 GUI 回调，对它们**完全无效**（`PV:C11` 开篇原则）。
> 逐条行号清单的**权威出处是 `PV:C11.1`（84 命中，摘输入相关）与 `PV:C11.2`**；下表按 mod 归并，**不逐行重抄**。

| mod | 文件（`文件:行`） | 读取语义 | `PV` 出处 |
|---|---|---|---|
| **原版** | `GuiScreen.java:441/449`(`isCtrlKeyDown`/`isShiftKeyDown`)、`GuiContainer.java:405,632`(Shift 点击)、`GameSettings.java:321`(`isKeyDown` 的鼠标分支 `Mouse.isButtonDown`)、`GuiSlot.java:235`、`EntityRenderer.java:1025`、`Minecraft.java:1853,1858,1883,1888,1893,1895,1899,1904,1910,1915` | 修饰键 → 直接决定点击/键语义；列表拖动；失焦抑制暂停菜单 | `PV:A1`、`PV:C11.1`、`PV:C11.2` |
| **GT5-Unofficial** | `MTETooltipMultiBlockBase.java:82`、`AEItemSlot.java:73`（`KEY_LMENU` 悬停）、`MTEBrickedBlastFurnace.java:122`、`GoodGenerator\...\GT_MetaTileEntity_TooltipMultiBlockBase_EM.java:47` | 多方块 tooltip / Alt 槽位行为 / 结构提示（**仅 3 处真读状态**，`PG:8`） | `PV:C11.1`、`PG:8` |
| **NotEnoughItems / CodeChickenCore** | `NEIClientUtils.java:298,303,305,439,456`、`KeyManager.java:34`、`NEIClientConfig.java:943`、`CodeChickenCore\...\GuiModListScroll.java:139` | NEI 快捷键与自建按键状态机（无事件可订阅） | `PV:C11.1`、`PL:3.10` |
| **GTNHLib** | `SyncedKeybind.java:127,129,206`（`:125` 走 `getIsKeyPressed()`、`:127/:129` 走 `Keyboard.isKeyDown`） | 工具模式切换 / CTRL 键同步（`GTProxy.java:1080/1083` 注册） | `PV:C11.1`、`PG:8` |
| **Angelica** | `mal\util\InputHandler.java:29,41`、`GuiCustomMenu.java:77`、`IrisGuiSlot.java:66-67`(`Mouse.isButtonDown`) | GUI 内轮询 | `PV:C11.1`、`PV:C11.2` |
| **AE2-Unofficial** | `AEBaseGui.java:608,1101`、`GuiWirelessNetworkManager.java:98`、`GuiWirelessKit.java:838,999`、`GuiPatternTerm.java:130,131`、`GuiInterface.java:322`、`GuiMEMonitorable.java:691`、`GuiInterfaceTerminal.java:869,1891,1942`、`ItemEncodedPatternRenderer.java:31`、`GuiCraftingTree.java:455`、`GuiCraftingStatus.java:77-78`、`GuiOreFilter.java:168,178` | 修饰键语义 + `Mouse.isButtonDown(1)` 反向滚动 | `PV:C11.1`、`PV:C11.2` |
| **ModularUI（1）** | `api\widget\Interactable.java:106`、`api\KeyboardUtil.java:31` | 控件内修饰键判定 | `PV:C11.1` |
| **ModularUI2** | `api\widget\Interactable.java:134,159` | 同上 | `PV:C11.1` |
| **LogisticsPipes** | `StringUtils.java:88`、`ItemDisplay.java:382-383`、`GuiGraphics.java:124`、`RemoteOrderer.java:58`、`ItemUpgrade.java:333`、`ItemModule.java:377`、`LogisticsItemCard.java:39`、`LogisticsFluidContainer.java:63`、`LogisticsHUDRenderer.java:305,335,422`、`ItemModuleRenderer.java:24`、`FluidContainerRenderer.java:50`、`GuiRequestTable.java:796`、`GuiOrderer.java:290`、`GuiCCBasedQuickSort.java:46-67`、`GuiInvSysConnector.java:213,219`、`DebugHelper.java:53-59`、`RequestMonitorPopup.java:148`、`LogicLayoutGui.java:101` | 大量 HUD/面板轮询；`Mouse.isButtonDown(1)` 反向滚动（12+ 处） | `PV:C11.1`、`PV:C11.2` |
| **ProjectRed** | `transportation\items.scala:140` 等（items/guis/chipabstracts/TileProjectBench/TileAutoCrafter/fabrication:627/exploration:95/items.scala:284） | 自建按键状态机 | `PV:C11.1` |
| **EnderIO** | `IoConfigRenderer.java:151`、`GuiEnderface.java:175`、`GuiButtonIoConfig.java:43`、`ItemFilterLimited.java:215`（+`:216` `Mouse.isButtonDown`） | GUI 轮询 | `PV:C11.1`、`PV:C11.2` |
| **Botania** | `CorporeaAutoCompleteHandler.java:90`、`PageShedding.java:111,117`、`PageRecipe.java:89,136` | HUD / 书页翻动 | `PV:C11.1`、`PV:C11.2` |
| **StructureLib / BlockRenderer6343 / WirelessRedstone-CBE / BloodMagic / Translocators / ForgeMultipart** | `StructureLib\...\ItemConstructableTrigger.java:51`、`StructureLib\...\GuiScrollableList.java:341,349`、`BlockRenderer6343\...\GuiMultiblockHandler.java:351-353`、`WirelessRedstone-CBE\...\RedstoneEtherClientAddons.java:72`、`BloodMagic\...\ItemRitualDiviner.java:72`、`Translocators\...\CraftingGridKeyHandler.java:28-31`、`ForgeMultipart\...\ControlKeyModifier.scala:51-52` | 混合 | `PV:C11.1`、`PV:C11.2` |
| **本 mod（Lightning）** | `MOD` 全树 `Keyboard.` **2 命中**（`GuiSdeCellNote.java:36/52`，`enableRepeatEvents`）、`Mouse.` **0 命中** | **本 mod 目前没有任何键鼠注入代码** | `FA:7.2`、`PL:3.11` |

**相对位移读取者的单独一行**：`Mouse.getDX/getDY` 的**唯一**消费点是 `MouseHelper.java:39-40`，
调用链唯一（`EntityRenderer.java:1041` → `:1061/1065`），而 `MouseHelper` 的 grab/ungrab 调用点只有
`Minecraft.java:1386`/`:1402`（`PV:A3`、`PV:A4`）⇒ **这一族是可达的**（走 `addMoveEvent`），
但它受 `EntityRenderer.java:1039 if (mc.inGameHasFocus && flag)` + `:1023 flag = Display.isActive()` 前置（`PL:4.3`）。

### 5.2 「不走事件队列就看不到注入」的**全部**消费点 + 可判定判据

**判据口径（三段式，每段独立可判定）**：

- **P1（链归属）**：该消费点是「读事件队列」还是「读物理状态」？
  读事件队列 ⇒ 入 P2；读物理状态 ⇒ 入 P3。
- **P2（事件队列读者）**：注入落在队列**排空之前**吗？是 ⇒ **可达**；否（例如 `MouseInputEvent` 的
  post 点 `GuiScreenMixin.java:31/36`，只有走 `handleInput` 才发）⇒ **当前不可达**。
- **P3（物理状态读者）**：本设施当前手段**能否改变该物理状态**？不能 ⇒ **当前不可达**
  （证据：`PL:1` #8/#9 判定「不可行/脆弱」，且该写入会被每帧 `SDL_PumpEvents` 覆写）。
  **残余可能**：强写 `sdlKeyPressedArray` 的存活期 `[未验证]`（`PL:3.8`、`PL:5` 第 7 项）⇒
  该条以 `未验证` 收尾，**不得**写成「已证不可达」。

| # | 消费点 | 判据 | 结论 | 测试状态 |
|---|---|---|---|---|
| P-01 | `Keyboard.isKeyDown(int)` 全家（§5.1 各 mod） | P1→P3；本设施只写队列 | **当前不可达** | `未测`（无判据）；物理态强写 `未验证` |
| P-02 | `Mouse.isButtonDown(int)` 全家（`PV:C11.2`） | P1→P3；`sdlMouseButtonFlags` 每帧被 `Lwjgl3ifyEventLoop.java:110` 覆写 | **当前不可达** | `未测`；`PL:3.8` `未验证` |
| P-03 | `GameSettings.isKeyDown(KeyBinding)`（`GameSettings.java:319-321`，GUI 内查键的官方姿势） | P1→P3（纯原始轮询，**不看 `pressed`**） | **当前不可达** | `未测` |
| P-04 | `KeyBinding.getIsKeyPressed()` 轮询者（`PV:C11.3`：`MovementInputFromOptions.java:23-44`、`Minecraft.java:2007/2053/2058`、`EntityPlayerSP.java:211/221`、`GuiIngame.java:408` 等） | P1→P2：`pressed` 只在 `Minecraft.java:1781/1839` 被写，而这两处**在闸门 1771 内** | **世界态可达；GUI 内不可达**（`PV:C11.3` 的 `[推断]`） | 世界态**已证**（`E1.forwardPressedWhileHeld`，`R5:32`）；GUI 内 `未测` |
| P-05 | `SyncedKeybind.java:125/204`（`getIsKeyPressed` 分支） | P1→P2 | **世界态可达**（与 P-04 同源）；`SyncedKeybind.java:127/129` 的 `isKeyDown` 分支见 P-01 | `未测` |
| P-06 | NEI `KeyManager.tickKeyStates()`（`ClientHandler.java:346-359` → `KeyManager.java:31-49`） | P1→P3（`:34 Keyboard.isKeyDown`） | **当前不可达** | `未测` |
| P-07 | Angelica `MixinMinecraft.java:94-97`（读 `LMENU/RMENU`） | P1→P3 | **当前不可达** | `未测` |
| P-08 | `Mouse.getX()/getY()` 的渲染口径（`GuiDraw.java:117-118` 的 **66 个调用点**、LogisticsPipes 多处） | P1→P2；该口径由 `addMoveEvent`(`PL:1` #5) 维护 | **可达（口径撕裂）**：与事件口径 `getEventX/Y` 不同源（`PV:C11.4`） | `未测` |
| P-09 | `Mouse.getDWheel()` 累计读（LogisticsPipes `RequestMonitorPopup.java:112/186`、`GuiDiskPopup.java:176`、`GuiAddMacro.java:131,158`、`LogicLayoutGui.java:80,126`） | P1→P2；`addWheelEvent` 只喂事件口径 | **部分可达**：`getDWheel()` 是**另一个累计器**（`PV:E` 滚轮行） | `未测` |
| P-10 | `Mouse.getEventButton()` 的 Forge 侧读者（`Angelica\...\Zoom.java:78`、`EnderIO\...\KeyTracker.java:145`、MUI2 `GuiContext.java:75`） | P1→P2（读队首） | **可达，但受闸门**：GUI 内（`allowUserInput==false`）这两个 `InputEvent` 不 post（`PV:C10.2`） | `未测` |
| P-11 | NEI `ShortcutInputHandler.java:175`（左键=合成表 / 右键=用途） | P1→P2（读 `getEventButton`） | **可达，但按真实按钮走的风险**：只调 `mouseClicked` 时仍返回上一真实事件（`PV:D12.(ii)-3`） | `未测` |
| P-12 | `InputEvents` 的 `KeyboardListener` 订阅者 | P1→P2：`InputEvents.injectKeyEvent` 与 `Keyboard.eventQueue` **互不相通**（`PL:1` #7） | **只投队列 ⇒ 不可达**；真按键是「两路都发」（`Lwjgl3ifyEventLoop.java:154`+`:186/202`） | `未测` |
| P-13 | `GuiSlot.java:312` 渲染期嵌套 `Mouse.next()` + `:235 Mouse.isButtonDown(0)` | P1→混合：嵌套 `next()` 读队列（可达）、`isButtonDown` 读物理态（不可达） | **混合不可达**：拖动/滚动条依赖物理态 | `未测`；竞争结果 `未验证`（`PV:F` 第 7 项） |
| P-14 | MUI2/mixin 的 `MouseInputEvent`/`KeyboardInputEvent` 自身 post 点 | P2：`GuiScreenMixin.java:31/36/43/48` 只在 `handleInput` 内 | **必走队列才可达**（绕开队列 ⇒ 永不 post） | `未测`（实机 `E5b.mui2ScreenClass` 因界面未开而未取得样本） |
| P-15 | `Keyboard.isRepeatEvent()` | P1→P2 | **REPEAT 的投递结果 `未验证`**（`PL:3.6` 差异 1） | `未测`（`PL:5` 第 6 项） |
| P-16 | `Minecraft.func_152348_aa()` 全链路（F2 截图 `:2965`、F11 全屏 `:2961`、串流键 `:2902-2960`、`GuiControls` 重绑定 `:2898`） | P1→P2（由 `:1863` 与 `GuiScreen.java:373` 调，两处都在事件上下文内） | **只调 `KeyBinding` 不可达**；走队列**可达**（`PV:D12.(i)-2`） | `未测` |

**「当前不可达」这个判定本身的可判定性说明**：P-01/P-02/P-03/P-06/P-07 的不可达性由
**代码链零交叉**证成（物理态数组的唯一赋值点是 `Display.java:342` 与 `Lwjgl3ifyEventLoop.java:110`，
而本设施的入口清单 `PL:1` #1–#6 都不触这两处）——这是**静态可判定**的；
「注入后确实不变」的**运行期反向验证未做** ⇒ 全表**测试状态列为 `未测`**，
**不得**因为「结论是当前不可达」就把它当成「已证」。

---

## 6. 负对照目录（A7）

**用法**：每条负对照都是一个**必须变红**的检查。若某条负对照在实机上是**绿的**（即注入无效但设施报成功），
则该判据本身失效，必须当场定为设施缺陷（对应 `contract.md` §4.6 第 4 条「不静默成功、不空转绿」）。
`期望失败形态` 一列写的是**应该红在哪里**，不是「应该抛异常」。

| # | 负对照 | 怎么制造 | 期望的失败形态（必须红在哪） | 与已有实证的关系 |
|---|---|---|---|---|
| N-01 | **不发送点击** | 只做「移动到位 + 等 ≥2 帧」，**不发** `addButtonEvent`；随后读目标控件的同步值/界面状态 | 控件值**不变**；`onMousePressed` 调用计数 0；界面保持打开 | 已有正面对照 `E4c.negativeControlStillOpen`（`R5:25`/`R6:25`，空白点击后界面必须不关）；**N-01 是它的反向对（连点击都不发）** |
| N-02 | **点错位置** | 位置送到目标控件**外**（但仍落在同一 `ModularPanel` 的 area 内或界面内），时序与正例完全一致 | 命中集里**不含**目标控件；目标同步值不变；`getTopHovering.isTarget=False` | **实机已试但未取得样本**：`R6:44 E5f.blankPointFound` 红，原因是「面板 area 内没有找到既不在目标控件上、也不在其它 `ToggleButton` 上的候选点（试了 0 个）」⇒ 该负对照**当前无从判定**，必须先把「取空白点」的方法修好（读 panel area 的权威来源） |
| N-03 | **去掉关键组合键** | 对需要修饰键才改写语义的操作（Shift 点击整摞 / Alt 槽位 / Ctrl 丢弃），**只注入基础点击、不注入修饰键** | 语义**不升级**：`GuiContainer.java:405/632` 的 `Keyboard.isKeyDown(42/54)` 为 false ⇒ 走普通点击分支；`Minecraft.java:1990-1993 dropOneItem(isCtrlKeyDown())` 走非 Ctrl 分支 | **预期红**，且这正是 §5.2 P-01 的直接应用：修饰键走**物理态**，队列注入**改不了它** ⇒ 若要「Shift 点击」成立，**必须**另配物理态手段或改用动作级入口（`player.slot_click` 的 `shift:true`，见 `contract.md` §4.6 第 7 条） |
| N-04 | **用 L0 代替关键动作** | 用 `scene.player.pose`（`contract.md` §4.4，`layer:"L0"`，`semantics:"teleport"`）代替 `player.move`/`input.*`，或直接用 `scene.inventory.write` 代替「走过去捡」 | 返回值 `layer` 必须是 `"L0"`；`means` **不得**为 `"input"`；**该产物不得被当作 L1/输入路径的证据**（`contract.md` §4.6 第 1 条与 `#96 §4.2`） | 已有实机使用：`R6:29 E5b0.playerPosedNearMachine`（用 `scene.player.pose` 凑距离，**明确不是**输入路径证据） |
| N-05 | **只调 `KeyBinding.setKeyBindState`**（**已实证的判别器**） | 不投队列，直接 `KeyBinding.setKeyBindState(code,true/false)`（±`onTick`） | **Forge `InputEvent.KeyInputEvent` 计数恒 0** ⇒ 这是「绕过输入管线」的**判别器**；同时贴 `Keyboard.getEventKey()` 的原版逐键分支（ESC→`displayInGameMenu` `:1878-1881`、F1 `:1921`、F3 `:1926`、F3+H 系列 `:1883-1919`、F11 着色器 `:1867`、调试分析器 `:1950/1957`）与 `func_152348_aa` 全链路**全部漏掉** | **实机已证**：正例 `E1.forgeKeyInputEventPosted` 计数=1（`R5:36`/`R6:54`）；负例 `E1b.keybindingBypassesForgeEvent` 计数=**0**（`R5:39`/`R6:57`）；机制本身确证生效 `E1b.keybindingMechanismSetsState`（`R5:38`/`R6:56`） |
| N-06 | **持键不释放（泄漏检测）** | 只发 PRESS（键盘）或只发 press（鼠标），跨多个 tick 后**不发** RELEASE/release；随后读状态 | **必须能在指定 tick 数内检出并清理**：`KeyBinding.pressed` 恒 true 且 `getIsKeyPressed()` 恒 true（`pressed` 与 `pressTime` 是 `KeyBinding.java:24-25` 的静态注册表字段，**跨作业残留**）；MUI2 `Input.held`(`ModularPanel.java:940-949`) 永真、`lastPressed` 卡住、`onMouseTapped`(`:478`) 后续失效；MUI1 `lastClicked`(`ModularPanel` 同构，`ModularGui.java:71-72`) 悬空 | 现有唯一清理点是 `unPressAllKeys()`(`Minecraft.java:1400`)，而它的调用点**唯一**且只在 `setIngameNotInFocus()` 里（`PV:A4`/`PV:A6`）⇒ **没有任何「作业结束即清键」的钩子**（`FA:G2`：无世界卸载/断连回调；`FA:4.4` 列出仅 3 个清理钩子） |
| N-07 | **不移动就点击**（坐标沿用上次位置） | 开屏后**不发** `addMoveEvent`，直接 `addButtonEvent(0,true)` | 点到**上次** `latestX/latestY`（或真实光标位置）⇒ 命中集不含目标；`PL:3.3` 明确「注入点击前必须先 `addMoveEvent` 把光标位置放到目标」；`PL:3.5` 进一步指出合成按键事件的 `getEventX/Y` **必然是** `latestX/latestY` | 与 N-02 的区别：N-02 是「移了但移错」，N-07 是「根本没移」 |
| N-08 | **不等帧就点击**（时序负对照） | 位置与按下**在同一帧/tick 内**连发 | MUI2：按下时用的是**上一帧** `hovering`（`PG:4.3`）⇒ 命中集不含目标；MUI1：用的是**上一 tick** 的 `hoveredWidgets`（`PG:2.5`）⇒ 同上 | **实机正例**（分开时序）`R6:41 E5e.clickHitTargetWidget` **仍为红**（因界面未开、命中集为空）⇒ 该正例当前**未取得**，无法与 N-08 形成有效对照 |
| N-09 | **对着不存在的目标注入** | 目标控件不在当前界面里（或界面根本没开），其余时序/坐标流程照跑 | 注入**不得**报成功：`found=false` + `hovering=[]` + `getTopHovering.isTarget=False`；返回值 `observed:false` + `notObservedReason`（`contract.md` §4.6 第 4 条） | **实机形态已观察到（红）**：`R6:36 E5d.targetLocated`、`R6:41 E5e.clickHitTargetWidget`、`R6:32 E5b.mui2ScreenClass` |
| N-10 | **只调 GUI 回调、不投队列**（MUI2 专用判别器） | 反射直接调 `GuiScreen.mouseClicked(...)` 或 `handleMouseInput()`，**不进队列** | MUI2 的 `MouseInputEvent`/`KeyboardInputEvent` **永不 post** ⇒ `ClientScreenHandler` 永不看到 ⇒ **MUI2 完全无反应**；`PV:D12.(ii)` 的漏项 1/2/3 同时成立 | `PG:7` 第 2 点为此条的直接依据 |

### 6.1 负对照的可判定性要求（元口径）

1. 每条负对照**必须有独立的观测面**（读面动作或控件自身状态），**不得**用动作自己的返回值自证 ——
   现有 9 个 `read.*` **没有一条读输入侧状态**（`FA:G6`）⇒ 每条负对照要么依赖控件自身同步值
   （如 `E5e.valueChangedByGenericClick` 读的 `fluidAutoOutput` 前后值），要么必须**先补一个输入侧读面**。
2. 「红了」必须能**归因到具体环节**：`E5c/E5d/E5e/E5f/E5g` 的日志正是这个形态
   （`R6:33-47` 逐环节打 `screenClass`/`found`/`hovering`/`前后值`），这是负对照目录的**写法样板**。
3. 负对照**不得**依赖「进程重启」或「重新开世界」——探索模式纪律要求失败**不得导致进程重启或崩溃**
   （`contract.md` §4.6 第 5 条）。

---

## 7. 已实证与未通过的判据对照表

**证据来源一律为 `R5`/`R6`**（`temp/cp-input/probe-run-5.log` / `probe-run-6.log`）。
`R5` 汇总 = 26 项、红 4（`R5:51`）；`R6` 汇总 = 34 项、红 9（`R6:69`）。
**本表逐条如实登记，包含全部未通过项**；`未测` 表示该判据**在两份日志中都没有出现**。

| 判据名 | 状态 | 证据来源 | 说明 |
|---|---|---|---|
| `E1.probeRan` | 已证 | `R5:31`、`R6:49` | 退出码=0；failedSteps=0 |
| `E1.forwardPressedWhileHeld` | 已证 | `R5:32`、`R6:50` | `kbPressed=True` |
| `E1.forwardReleasedAfterUp` | 已证 | `R5:33`、`R6:51` | `kbPressed=False` |
| `E1.playerMoved` | 已证 | `R5:34`、`R6:52` | 位移 d(x,z)=(0.000,8.134) |
| `E1.deceleratedAfterRelease` | 已证 | `R5:35`、`R6:53` | 释放后滑行 1.745 < 按住期 8.134 的 50% |
| `E1.forgeKeyInputEventPosted` | 已证 | `R5:36`、`R6:54` | 队列注入时 Forge `KeyInputEvent` 计数=1（两条总线都注册） |
| `E1.unattendedDisplayed` | 已证 | `R5:37`、`R6:55` | `Display.isActive()=False`（真失焦下仍成立） |
| `E1b.keybindingMechanismSetsState` | 已证 | `R5:38`、`R6:56` | 直接写状态确实生效 `kbPressed=True` |
| `E1b.keybindingBypassesForgeEvent` | 已证 | `R5:39`、`R6:57` | 对照机制下 Forge `KeyInputEvent` 计数=**0** = 未走输入管线（**N-05 的判别器**） |
| `E1c.sneakObserved` | 已证 | `R5:40`、`R6:58` | `isSneaking=True` |
| `E2.queueDrained` | 已证 | `R5:41`、`R6:59` | 逐 tick 队列深度=1,1,1,1（1 = 只剩 `PL:2.2` 的 seed 哨兵） |
| **`E3.charEventReachedRealGui`** | **未通过** | `R5:42`、`R6:60` | `addCharEvent` 路线：聊天框内容=`''`（期望非空）⇒ **GUI 文本路由未打通** |
| **`E3.keyEventWithCodepointReachedGui`** | **未通过** | `R5:43`、`R6:61` | 键事件自带 codepoint 路线：内容=`''`（期望 `abc+d`）⇒ **GUI 文本路由未打通** |
| `E3.editKeyReachedGui` | 未通过 | `R5:44`、`R6:62` | 退格后=`''`（期望 `abc`） |
| `E3.guiClosed` | 已证 | `R5:45`、`R6:63` | `currentScreen=` 空 ⇒ 聊天框确实被关掉 |
| `E4a.pauseMenuOpened` | 已证 | `R5:20`、`R6:20` | `currentScreen=net.minecraft.client.gui.GuiIngameMenu` |
| `E4a.buttonTableRead` | 已证 | `R5:21`、`R6:21` | Back to Game cx=213 cy=78 |
| `E4b.clickOnNonSlotButtonWorked` | 已证 | `R5:46`、`R6:64` | 点击后 `currentScreen=`（null）⇒ 按钮真的被按下并处理（**队列注入点击的正例**） |
| `E4c.negativeControlStillOpen` | 已证 | `R5:25`、`R6:25` | 空白点击后界面仍在（**负对照绿 = 对照有效**） |
| `E5a.worldWithGtMachine` | 已证 | `R5:27`、`R6:27` | 机器=Machine_LV_ChemicalReactor at=65,12,65；退出码=0 |
| `E5.orchestration` | 未通过（R5）/ 未测（R6） | `R5:29` | R5 段自身异常：`Method invocation failed because [System.Object[]] does not contain a method named 'op_Subtraction'`（**器械层 bug，不影响 E1–E4 判据**）；R6 无此条目 ⇒ R6 已越过该步 |
| `E5b0.playerPosedNearMachine` | 未测（R5）/ 已证（R6） | `R6:29` | R6：pos=63.5,13,65.5 yaw=270 pitch=45；R5 卡在 `E5.orchestration` |
| `E5b.containerGuiOpened` | 未测（R5）/ 已证（R6） | `R6:31` | observed=True；**但 `screenClass=` 空、`containerClass=net.minecraft.inventory.ContainerPlayer`** ⇒ 界面其实是**玩家背包**，不是机器界面 |
| **`E5b.mui2ScreenClass`** | **未通过** | `R6:32` | `guiClass=` 空（期望 `com.cleanroommc.modularui.screen.GuiScreenWrapper`/`GuiContainerWrapper`）⇒ **MUI2 配方不适用**，这是 E5c/E5e 后续全红的**根因**：**右键未开机器界面** |
| `E5d.targetLocated` | 未通过（**样本未取到**） | `R6:36` | `found=`、`widgetClass=`、`area=`、`center=` 全为空 ⇒ 目标控件**未定位** |
| `E5d.syncKeyMatchedByKey` | 未通过（**样本未取到**） | `R6:37` | `matchedBy=`、见过的同步键列表为空；仅 `ToggleButton 候选=1` |
| **`E5e.clickHitTargetWidget`** | **未通过** | `R6:41` | `getTopHovering.isTarget=False`、`hovering=[]`、`top=` 空、`lwjglMouse=(,)` |
| **`E5e.valueChangedByGenericClick`** | **未通过** | `R6:42` | `fluidAutoOutput` 同步值前后都为空 ⇒ **无法判定值是否变化** |
| `E5f.blankPointFound` | 未通过 | `R6:44` | 面板 area 为空、试了 0 个候选点 ⇒ **N-02 负对照无从判定** |
| `E5g.serverNbtNotJudgeable` | 已证（**信息项，非判据**） | `R6:47` | `read.te` 的 24 键/深度上限**没给出** `mFluidTransfer`；服务端侧判据以 `E5e.valueChangedByGenericClick` 为准 |
| `S0.probeActionRegistered` | 已证 | `R5:10`、`R6:10` | 动作数=44（`43 + debug.input.probe`）；含 `debug.input.probe=True` |
| `S0.contractVersion` | 已证 | `R5:11`、`R6:11` | contractVersion=1.7 |
| `W0.worldRebuild` | 已证 | `R5:13`、`R6:13` | 退出码=0；虚空托管世界 `cp_input_probe` |
| `pre.pauseOnLostFocus` | 已证 | `R5:3`、`R6:3` | options.txt 已钉 `false`（失焦仍 tick） |
| `S2.portReleased` | 已证 | `R5:50`、`R6:68` | port=23315 released=True |
| `core.shutdown` | 已证（R5）/ 未通过（R6） | `R5:49`、`R6:67` | R5 提交成功 j12；R6「由于目标计算机积极拒绝，无法连接」 ⇒ **R6 的关服路径未验证，R6 的其余结论不受影响**（关服在最后一步） |

### 7.1 明确未测（两份日志都没有出现，**不是未通过**）

| 缺口 | 为什么必须标未测 |
|---|---|
| 鼠标**相对位移/绝对位置**注入（矩阵行 `A-05` / `A-06`） | `R5`/`R6` **无任何** `addMoveEvent` 判据 ⇒ 矩阵 A 该两行的「已处理」**未经实机证实** |
| **滚轮**注入（矩阵行 `A-09`） | 无判据 |
| **失焦下注入鼠标增量是否完全无效**（`EntityRenderer.java:1039` 的 `flag` 门） | `PL:5` 第 4 项列出的判定法**未被执行** |
| **注入是否影响系统鼠标**（硬要求） | `PL:5` 第 5 项判定法（进程外 `GetCursorPos` 逐帧采样）**未被执行** ⇒ §3.3 的「不动系统鼠标」目前只有**代码证据**（`PL:4.5`） |
| **`sdlKeyPressedArray` 手写存活几帧**（`PL:1` #8） | `PL:5` 第 7 项未执行 ⇒ §5.2 P-01 的「残余可能」保持 `未验证` |
| **REPEAT 过滤细节**（`PL:3.6` 差异 1） | `PL:5` 第 6 项未执行 |
| **`Mouse.addMoveEvent` 是否被 `ignoreNextMove/ignoreNextDelta` 吃掉**、`Mouse.poll()` clamp 影响 | `PL:5` 第 3 项未执行 |
| **`1731 handleInput()` 是否真把队列读空**（`PV:F` 第 2 项、`PL:5` 第 2 项） | 未执行 ⇒ §3.4 第 5 条的 `[推断]` 保持 `未验证` |
| **`ActionPerformedEvent` 的 post 是否足以让 mod 按钮逻辑满意**（`PV:F` 第 12 项） | 未执行 |
| **MUI1 的 ≥2 tick 时序**、**MUI2 的 ≥2 帧时序** | `PG:9.4` 第 1/2 项**未执行**；`R6:41` 的红是**界面未开**造成的，**不能**当作时序结论的证据 |
| **实机动作数=44 与 `FA` 静态的 43 一致** | 实机=44（`debug.input.probe`）⇒ 与 `FA:2.2` 的 43 差 1，差额已由探查器械解释，但**正稿入库时的计数口径需复核** |

---

## 8. 覆盖论证的维护规则

### 8.1 新版本 / 新消费链出现时必须复核什么（逐条可判定）

| 触发 | 必须复核 | 复核方法 | 依据 |
|---|---|---|---|
| **lwjgl3ify 升级**（含 3.0.8 → 3.0.25+） | `PL:1` #1–#6 的**签名与语义**；`PL:3.6` 的两条已知差异（差异 1：REPEAT 过滤 + `INPUT_ALWAYS_REPEAT_KEYS`；差异 2：`-api` 制品不含 `org/lwjglx/**`）；`Keyboard.java:240-244` 的 REPEAT 丢弃条件 | `javap` 对**运行期 jar** 核签；查 `run/client/logs/fml-junk-earlystartup.log` 的 `Constructed RFB plugin lwjgl3ify@` 行 | `PL:0`、`PL:3.6` |
| **Minecraft / Forge 升级** | 矩阵 A 全部行号（本文件所有行号**一次性失效**）；`Minecraft.java:1771` 闸门是否存在、`:1731` 与 `:1776/1837` 顺序；`KeyBinding.pressed` 是否仍被 `unPressAllKeys` 清 | 重跑 `PV` 的检索式；核对 `PV:0.1` 的四条「版本前提纠正」是否仍成立 | `PV:0.1`、`PV:A2` |
| **MUI1 / MUI2 升级** | `PG:0.2` 的**运行期 vs 源码版本差**是否扩大；`PG:3.0`/`PG:2.0` 已核对的方法签名清单；MUI2 的 `GuiScreenMixin` 是否仍在 jar 内且仍用 `@Redirect`；命中集重建节奏（MUI2 每 frame / MUI1 每 tick） | `javap -p -classpath <运行期 jar> <被引用类>` 逐方法核签；重跑 `PG:9.4` 第 1/2/7 项 | `PG:0.2`、`PG:3.0`、`PG:9.4` |
| **出现新消费链**（新模组、或旧模组新增输入读取） | §5.1 的分 mod 清单是否新增行；§5.2 的判据三段式是否需要新增行；矩阵 C 是否出现**第四条链路** | 用 `PV:C11` 的两条检索式在新模组树上重跑：`Keyboard.isKeyDown|Mouse.isButtonDown`（物理态）与 `InputEvent|GuiScreenEvent` 订阅（事件队列）；命中即必须补进 §5.1/§5.2 | `PV:C11` 开篇原则、`PV:C10.2` |
| **出现新动作族 / 新参数** | 本文件 §0.1 的术语表；矩阵 A 的行数（§2.2）；动作总数口径（`FA:2.2` = 43 静态 / 实机 44） | 对照正稿 `input-contract.md` 的动作族定义；核 `ActionRegistrar.java` 的 `ActionDescriptor.builder(` 计数与 `ReadCaptureOfflineTest.java:876-880` 的断言 | `FA:2.2`、`FA:G8` |

### 8.2 矩阵与实现怎么对账（「把矩阵逐行关联到代码、版本与测试」）

**对账三件套（每行矩阵 A 都必须齐备，缺一即该行不可判定）**：

| 件 | 内容 | 存放/形式 |
|---|---|---|
| **代码锚** | 该行的 `原版状态载体` 与 `消费点` 的 `文件:行`（本文件已给，全部转引自 `PV`/`PL`/`PG`） | 本文件 §2 表格 |
| **版本锚** | 该锚点在**运行期版本**下是否仍成立：lwjgl3ify 走 `javap` 核签（`PL:3.6`）；MUI 走 `javap -p` 核签（`PG:3.0`）；MC/Forge 走反编译源（`PV:0`） | §1.1 版本表 + §8.1 复核方法 |
| **测试锚** | 该行对应的判据名 + 状态（§7）；**没有判据的行必须显式标 `未测`**，不得留空、不得用「应该可以」填补 | 本文件 §7 表 |

**对账流程（每次输入侧改动后的固定动作）**：

1. 逐行扫矩阵 A（14 行），对每行问三个问题：**代码锚还在吗**（行号/结构是否漂移）、**版本锚还成立吗**、
   **测试锚是绿的还是 `未测`**；
2. 任一行为 `未测` 且本次改动**触及该行**⇒ **必须**先补判据，再改实现（禁止「先改后测」）；
3. §5.2 的判据表逐行复算 P1→P2/P3；
4. §6 的负对照逐条跑一遍，**任何一条从红变绿**即视为设施缺陷（不是「行为变更」）；
5. 更新 §2.2 的行数核对与 §7 的判据对照表。

**与现有机械防线的衔接（可自动化的部分）**：

| 现有防线 | 位置 | 与本文件的关系 |
|---|---|---|
| 动作计数断言 | `ReadCaptureOfflineTest.java:876-880`（`assertEquals(43, registry.size())`） | 新增 `input.*` 动作族**必须**同 PR 改此断言与 `contract.md` 的计数文字（`FA:8.6` 列为 🔴 共享文件） |
| 契约版本 ≥ 每个 `since` | `ReadCaptureOfflineTest.java:883-893` | 新动作族的 `since` 必须 ≤ `Contract.VERSION` |
| 段序文档一致 | `CaseSegmentOrderDocTest` | 本文件**不新增段**，不影响 |
| **缺口：字段集合无断言** | `FA:G8` —— 没有「某动作的字段集合 == 期望集合」的断言 | `means:"input"` 与 `input.*` 的字段集合**当前不会被任何离线测试拦住** ⇒ 建议随正稿新增一条字段集合断言（**这是需要 Lead 裁决的接口改动，不在本文件范围内**） |
| A3 基准 | `test/expected/compare-runs.mjs:242`（`read|action` 走 `canonical-hash-equal`） | 新增输入侧读面动作**必须**新增对应基准，否则下一次实机重放会红（`FA:6.3`） |

### 8.3 本文件自身的维护边界

- 本文件**只增不改语义**：已发布的论证结论若被新证据推翻，**保留原文 + 追加「复核结论」小节**，
  不直接改写历史结论（与 `contract.md` 「只增不改」口径一致）。
- 本文件所有「当前不可达」判定**必须**同时给出测试状态；一旦某条从 `未测` 变为「已证不可达」，
  必须把该次验证的**证据来源**写进 §7。
