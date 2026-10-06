package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.IChatComponent;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.controlplane.mc.cmd.ServerCommandInvoker;

/**
 * 命令通道的<b>回报旁听</b>钩子（Gitea #100）：在 {@code EntityPlayerMP#addChatMessage} 入口把消息
 * 分发给当前注册的录制口（{@link ServerCommandInvoker.ChatTap}）。
 *
 * <h2>为什么必须用 mixin 而不是包装发送者</h2>
 *
 * 「取回命令的真实回报」的直觉做法是自造一个 {@code ICommandSender} 收集 {@code addChatMessage}，
 * 再把它交给 {@code CommandHandler#executeCommand}。实机证明这么做<b>会让命令语义全废</b>：
 * {@code CommandSde#checkPlayer} 判的是 {@code sender instanceof EntityPlayerMP}，
 * 包装对象不是玩家 ⇒ {@code pos1}/{@code pos2}/{@code hpos1}/{@code hpos2}/{@code record}/
 * {@code export}/{@code dump} 一律回「SDE: 该子命令仅玩家可用」，而作业本身显示 {@code status=ok}
 * ——典型的「看起来成功、实际什么都没做」。
 *
 * <p>
 * 因此正确做法是：<b>发送者仍是真实玩家</b>（身份/权限/坐标/世界全部零转述），
 * 只在玩家收包的<b>出口</b>旁听一份拷贝。{@code addChatMessage} 正是那个唯一出口
 * （1.7.10 实测：它整个方法体就是 {@code playerNetServerHandler.sendPacket(new S02PacketChat(message))}）。
 *
 * <h2>纯观察论证（#96 §8.2「命令不扭曲行为」）</h2>
 *
 * <ul>
 * <li>注入点是 {@code HEAD}，仅<b>读</b>参数并转发给监听器，<b>不</b>修改 {@code message}、
 * <b>不</b>取消（无 {@code CallbackInfo.cancel()}）、<b>不</b>改变返回值或后续行为；</li>
 * <li>无录制口注册时（绝大多数时刻）{@link ServerCommandInvoker#dispatchChat} 只做一次
 * {@code WeakHashMap} 查表即返回——零行为、可忽略开销；</li>
 * <li>录制口只在 {@code cmd.exec} 执行命令的窗口内注册，{@code finally} 里必然注销，
 * 因此窗口外的聊天（tick 期间的无关消息）不会混进回报，也不会被本钩子观察；</li>
 * <li>监听器抛异常被 {@code dispatchChat} 吞掉 ⇒ 回报录制永远不会影响命令或游戏。</li>
 * </ul>
 *
 * <h2>兼容性</h2>
 *
 * 只注入一个方法（{@code addChatMessage}），该方法是 {@code CommandSender}/{@code ICommandSender}
 * 契约的一部分、被全模组生态依赖，1.7.10 各版本间稳定。方法名由 MCP 映射固定为
 * {@code addChatMessage}（不带 srg 名歧义），mixin 方法名与 {@code method = "addChatMessage"} 均可解析
 * （本仓其他 mixin 同样使用 MCP 名，见 {@code MixinTesrDispatcherWindow} 的 {@code "renderTileEntity"}）。
 */
@Mixin(EntityPlayerMP.class)
public abstract class MixinEntityPlayerMPChatTap {

    @Inject(method = "addChatMessage", at = @At("HEAD"))
    private void sde$tapChatForCommandChannel(IChatComponent message, CallbackInfo ci) {
        try {
            ServerCommandInvoker.dispatchChat((EntityPlayerMP) (Object) this, message);
        } catch (Throwable ignored) {
            // 旁听钩子绝不能影响聊天投递
        }
    }
}
