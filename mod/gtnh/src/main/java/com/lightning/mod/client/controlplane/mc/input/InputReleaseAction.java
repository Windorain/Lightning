package com.lightning.mod.client.controlplane.mc.input;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.input.api.ReleaseResult;

/**
 * {@code input.release}：**全清**设施自己投递过的按下态（跨作业），幂等（契约 §3.1.2 / §3.3 / §3.4 路径 4）。
 *
 * <h2>它清什么、不清什么（诚实边界）</h2>
 * <ul>
 * <li><b>清</b>：设施投递过、且仍在持键表里的条目 ⇒ 逐条投递抬起事件；</li>
 * <li><b>不清</b>：真实按键的用户状态（{@code 【禁令】} 不得调 {@code KeyBinding.unPressAllKeys()}/
 * {@code unpressKey()}——那是原版「进 GUI」的语义，等于抢用户输入）；</li>
 * <li><b>不清</b>：任何非本设施投递的事件（{@code 【禁令】} 不得 {@code Keyboard.eventQueue.clear()}：
 * 清掉静态 seed 哨兵会让后续 {@code getEventKey()}/{@code getEventCharacter()}/{@code isRepeatEvent()}
 * 对 {@code peek()} 解引用 NPE）；</li>
 * <li><b>清不了</b>：SDL 物理态 ⇒ 释放后 {@code Keyboard.isKeyDown}/{@code Mouse.isButtonDown}
 * <b>不受影响</b>（这与「不影响用户桌面」是同一根源，必须一起说清楚）。</li>
 * </ul>
 *
 * <h2>幂等</h2>
 * 没有可释放的东西时返回 {@code {count:0, alreadyIdle:true}}，**不是错误**（§3.3）。
 * 在 {@code faulted} 态下它是**唯一**的无条件复位入口（§7：复位优先于完整性，接受丢事件）。
 */
public final class InputReleaseAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "input.release";

    /** {@code since}/{@code means} 口径同 {@link InputKeyAction#descriptor()}（本批 #165 写入 1.8）。 */
    public static ActionDescriptor descriptor() {
        return ActionDescriptor.builder(NAME, Tier.SCENE)
            .description(
                "全清本输入设施投递过的按下态（跨作业，幂等；无持有时 count=0/alreadyIdle=true，不是错误）。"
                    + "只清设施所持：不碰 SDL 物理态（释放后 Keyboard.isKeyDown/Mouse.isButtonDown 不受影响）、"
                    + "不调 KeyBinding.unPressAllKeys、不清任何非本设施投递的事件。"
                    + "faulted 态下它是唯一的无条件复位入口（复位优先于完整性）。")
            .returns(
                "means/semantics/layer(null)/released[{kind,id,keyCode?,button?,jobId,heldTicks,reason}]/count/alreadyIdle/"
                    + "delivered=抬起事件数/deliveredAtTick/lifecyclePath=explicit-release/stateBefore/stateAfter/"
                    + "held{count,items}/consumer{...}/consumed{observed:null}")
            .example("{\"confirm\":true}")
            .since("1.8")
            .means(InputCapabilities.MEANS)
            .build();
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        InputRuntimeImpl rt = InputSupport.runtime();
        InputHost host = rt.host();
        String stateBefore = rt.stateName();
        String faultedReason = rt.faultedReason();

        ReleaseResult rr = rt.releaseAll();

        JsonObject o = InputSupport.base("release");
        o.add("released", InputRuntimeImpl.releasedJson(rt.lastReleased()));
        o.addProperty("count", rr.released);
        o.addProperty("alreadyIdle", rr.released == 0);
        o.addProperty("delivered", rr.released);
        o.addProperty("deliveredAtTick", rr.releasedAtTick);
        o.addProperty("lifecyclePath", "explicit-release");
        o.addProperty("stateBefore", stateBefore);
        o.addProperty("stateAfter", rt.stateName());
        o.addProperty("faultedReasonBefore", faultedReason);
        o.add("held", rt.heldJson());
        o.add("physicalConcurrent", InputSupport.physicalJson(rt, false));
        o.add("consumer", InputSupport.consumer(host));
        o.add("consumed", InputSupport.consumed());
        o.addProperty("note", "只清设施所持；轮询面（Keyboard.isKeyDown 等）不受影响，真实按键状态不被触碰（契约 §3.5）");
        return o;
    }
}
