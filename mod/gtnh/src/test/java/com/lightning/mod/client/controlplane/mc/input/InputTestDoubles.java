package com.lightning.mod.client.controlplane.mc.input;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ErrorCodes;

/**
 * 输入运行时的测试替身：一个假 host（可编程的 MC 观察面）+ 一个记录型 sink（不碰游戏）。
 *
 * <p>
 * 造它的理由：{@link InputRuntimeImpl} 的全部业务逻辑都必须能在**没有客户端**的情况下验证
 * （状态机、到期抬起、幂等释放、按作业隔离、队列满、faulted）。
 *
 * <p>
 * {@link FakeHost#advanceTick()} 刻意模拟「本 tick 的 runTick 已把队列排空」
 * （队列深度回到 seed 基线 {@value InputCapabilities#KEYBOARD_SEED_BASELINE}）——真实客户端里
 * 输入分发段早于 {@code TickEvent.Phase.END}，所以一个 tick 之后队列里只剩 seed 哨兵。
 */
final class InputTestDoubles {

    /** 可编程的 MC 观察面。 */
    static final class FakeHost implements InputHost {

        long ticks;
        int keyboardDepth = InputCapabilities.KEYBOARD_SEED_BASELINE;
        boolean keyboardReadable = true;
        String chain = "world";
        boolean worldChain = true;
        String screen;
        boolean allowUserInput = true;
        boolean displayActive;
        boolean focus = true;
        boolean bindingPressed = true;
        boolean mouseReadable = true;
        int mouseX;
        int mouseY;
        int scaledWidth = 854;
        int scaledHeight = 480;
        int displayWidth = 854;
        int displayHeight = 480;
        double pixelScale = 1.0D;
        String scaledSource = "fake";
        String pixelScaleSource = "fake";
        final Map<String, Integer> catalog = new LinkedHashMap<String, Integer>();

        FakeHost() {
            catalog.put("key.forward", Integer.valueOf(17));
            catalog.put("key.sneak", Integer.valueOf(42));
            catalog.put("key.jump", Integer.valueOf(57));
        }

        @Override
        public long clientTick() {
            return ticks;
        }

        @Override
        public void advanceTick() {
            ticks++;
            // 本 tick 的 runTick 已消费掉上一轮投递的事件
            keyboardDepth = InputCapabilities.KEYBOARD_SEED_BASELINE;
        }

        @Override
        public boolean keyboardReadable() {
            return keyboardReadable;
        }

        @Override
        public int keyboardQueueDepth() {
            return keyboardReadable ? keyboardDepth : -1;
        }

        @Override
        public String consumerChain() {
            return chain;
        }

        @Override
        public boolean worldChainActive() {
            return worldChain;
        }

        @Override
        public String currentScreenName() {
            return screen;
        }

        @Override
        public boolean allowUserInput() {
            return allowUserInput;
        }

        @Override
        public boolean displayActive() {
            return displayActive;
        }

        @Override
        public boolean inGameHasFocus() {
            return focus;
        }

        @Override
        public boolean keyBindingPressed(int keyCode) {
            return bindingPressed;
        }

        @Override
        public Map<String, Integer> keyCatalog() {
            return Collections.unmodifiableMap(catalog);
        }

        @Override
        public boolean keyCatalogAvailable() {
            return !catalog.isEmpty();
        }

        @Override
        public int scaledWidth() {
            return scaledWidth;
        }

        @Override
        public int scaledHeight() {
            return scaledHeight;
        }

        @Override
        public String scaledSource() {
            return scaledSource;
        }

        @Override
        public int displayWidth() {
            return displayWidth;
        }

        @Override
        public int displayHeight() {
            return displayHeight;
        }

        @Override
        public double pixelScale() {
            return pixelScale;
        }

        @Override
        public String pixelScaleSource() {
            return pixelScaleSource;
        }

        @Override
        public boolean mouseReadable() {
            return mouseReadable;
        }

        @Override
        public int mouseX() {
            return mouseX;
        }

        @Override
        public int mouseY() {
            return mouseY;
        }
    }

    /** 记录型注入面（不碰任何游戏状态）。 */
    static final class FakeSink implements InputSink {

        final List<String> writes = new ArrayList<String>();
        final FakeHost host;
        boolean available = true;
        String reason;
        /** 所有写入口都失败（能力未就绪）。 */
        boolean failAll;
        /** 模拟「底层对队列满静默丢」：写入但不增加队列深度 ⇒ 投递后复核必须发现。 */
        boolean silentDrop;
        /** 是否把键盘事件计入 host 的队列深度。 */
        boolean countQueue = true;
        String backend = "fake";

        FakeSink(FakeHost host) {
            this.host = host;
        }

        @Override
        public String backend() {
            return backend;
        }

        @Override
        public boolean available() {
            return available && !failAll;
        }

        @Override
        public String unavailableReason() {
            return available && !failAll ? null : (reason == null ? "fake: 注入面不可用" : reason);
        }

        @Override
        public List<Entry> entries() {
            List<Entry> l = new ArrayList<Entry>();
            l.add(new Entry("Keyboard.addRawKeyEvent", available(), unavailableReason()));
            l.add(new Entry("Keyboard.addCharEvent", available(), unavailableReason()));
            l.add(new Entry("Mouse.addMoveEvent", available(), unavailableReason()));
            l.add(new Entry("Mouse.addButtonEvent", available(), unavailableReason()));
            l.add(new Entry("Mouse.addWheelEvent", available(), unavailableReason()));
            return l;
        }

        @Override
        public JsonObject probeJson() {
            JsonObject o = new JsonObject();
            o.addProperty("backend", backend);
            o.addProperty("available", available());
            o.addProperty("reason", unavailableReason());
            o.add("entries", new JsonArray());
            return o;
        }

        private void require() throws InputInjectionException {
            if (!available()) {
                throw new InputInjectionException(ErrorCodes.STATE, unavailableReason());
            }
        }

        @Override
        public void key(int keyCode, int codepoint, boolean down) throws InputInjectionException {
            require();
            writes.add("key:" + keyCode + ":" + (down ? "down" : "up"));
            if (countQueue && !silentDrop) {
                host.keyboardDepth++;
            }
        }

        @Override
        public void character(int codepoint) throws InputInjectionException {
            require();
            writes.add("char:" + codepoint);
            if (countQueue && !silentDrop) {
                host.keyboardDepth++;
            }
        }

        @Override
        public void button(int button, boolean down) throws InputInjectionException {
            require();
            writes.add("button:" + button + ":" + (down ? "down" : "up"));
        }

        @Override
        public void wheel(double amount) throws InputInjectionException {
            require();
            writes.add("wheel:" + amount);
        }

        @Override
        public void move(Double absoluteX, Double absoluteY, double deltaX, double deltaY)
            throws InputInjectionException {
            require();
            writes.add("move:" + absoluteX + "," + absoluteY + ":" + deltaX + "," + deltaY);
        }

        /** 某个写入前缀出现了几次。 */
        int count(String prefix) {
            int n = 0;
            for (String w : writes) {
                if (w.startsWith(prefix)) {
                    n++;
                }
            }
            return n;
        }
    }

    private InputTestDoubles() {}
}
