package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.RendererLivingEntity;
import net.minecraft.entity.EntityLivingBase;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.controlplane.mc.capture.CaptureRenderState;

/**
 * 拍摄帧里把<b>真人玩家整人</b>从画面里去掉（模型 + 手持物 + 装备/护甲 + 披风）。
 *
 * <h2>为什么「隐身」不够（本注入存在的唯一理由）</h2>
 * {@code ShotExecutor} 的拍摄作用域里已经调 {@code mc.thePlayer.setInvisible(true)}，它只能挡<b>模型</b>：
 * 渲染侧的隐身判断在 {@code RendererLivingEntity.renderModel:307-328}（隐身 → 走「不画」分支），
 * 而同一方法里的 {@code renderEquippedItems} 调用（反编译源 {@code RendererLivingEntity.java:229}）
 * 在那个判断<b>之外</b>无条件执行：
 *
 * <pre>
 * ... renderModel(p_76986_1_, ...);        // :165  模型：隐身时自己会跳过
 * ... shouldRenderPass 循环 ...            // :171-226（护甲 pass，同样只看 shouldRenderPass）
 * this.renderEquippedItems(p_76986_1_, p_76986_9_);   // :229  手持物：无条件
 * </pre>
 *
 * {@code RenderPlayer.renderEquippedItems:182-187} 会把手里的物品整个画出来 ⇒ 真机实测
 * （persp-main 1280×720）玩家手上那本 TConstruct 手册以<b>不透明</b>像素出现在每个机位里，
 * 俯视正交机位里就压在石条上，采样色 {@code b89560/9c814a/715c38}（远超 15% alpha 剪影的量级）。
 * 逐件拦（改 {@code renderEquippedItems} / 逐个 {@code ItemRenderer}）要覆盖的入口太多，
 * 本类改成在渲染入口一次性取消：整人不画，手持物自然也没有了。
 *
 * <h2>为什么注入点是 HEAD、且必须是 {@code doRender}</h2>
 * <ul>
 * <li><b>HEAD 在 {@code glPushMatrix} 之前</b>：方法体从 {@code RenderLivingEvent.Pre} 之后紧接
 * {@code GL11.glPushMatrix()}（:88）、{@code glDisable(GL_CULL_FACE)}（:89）开始；HEAD 注入点在这两句
 * <b>之上</b>，取消时没有任何 GL 状态被压栈或被改过，因此不存在「push 了没 pop」的矩阵泄漏——
 * 这一点比在方法中途 return 安全得多；</li>
 * <li>{@code doRender} 是实体渲染的唯一入口：{@code RenderManager.func_147939_a:300} 按
 * {@code render.doRender(entity, ...)} 调用（最终走到本方法，见下面「玩家这条调用链」）。</li>
 * </ul>
 *
 * <h2>玩家这条调用链（确认 HEAD 一定被走到）</h2>
 * {@code RenderManager.func_147939_a:300} → {@code RenderPlayer.doRender(Entity,...):563} →
 * {@code RenderPlayer.doRender(AbstractClientPlayer,...):138}（它只摆模型标志与发
 * {@code RenderPlayerEvent.Pre}，不画任何像素）→ {@code super.doRender(...):167}
 * （<b>显式 super 调用</b>）→ {@code RendererLivingEntity.doRender(EntityLivingBase,...):85} = 本注入点。
 * 也就是说玩家的手持物/装备正是在这个被取消的方法体里画的（:229），取消它就把它们一并去掉了。
 *
 * <h2>副作用排查（逐条，含已确认无需处理项）</h2>
 * <ul>
 * <li><b>影子 / 火</b>：不在 {@code doRender} 里。它们是 {@code RenderManager.func_147939_a:309} 单独调的
 * {@code render.doRenderShadowAndFire(...)}，而影子那一条自带 {@code !entity.isInvisible()} 守卫
 * （反编译源 {@code Render.java:313}）⇒ 仍由拍摄作用域里的 {@code setInvisible} 挡住。两条拦法在此互补：
 * 隐身挡影子与旁观者视角的剪影分支，本注入挡手持物；</li>
 * <li><b>头顶名牌</b>：{@code RendererLivingEntity.canRenderName:525} 含
 * {@code !targetEntity.isInvisibleToPlayer(mc.thePlayer)}，且名牌绘制在
 * {@code passSpecialRender}（:296）——两者都在被取消的方法体里，本来就画不出来（拍摄帧要全隐，正合意）；</li>
 * <li><b>事件总线</b>：取消发生在 {@code RenderLivingEvent.Pre} 之前 ⇒ 拍摄帧里玩家的
 * {@code RenderLivingEvent.Pre/Post} 不会成对发出（该类事件取消即 return，语义与「有 Pre 无 Post」
 * 的区别仅是少一次空转）。仍会发出的是 {@code RenderPlayer.renderEquippedItems:184} 的
 * {@code RenderPlayerEvent.Specials.Pre}? 不会——那条在被取消的方法体内。{@code RenderPlayerEvent.Pre}
 * （{@code RenderPlayer.java:140}）在 super 之前发出，<b>不</b>受影响；
 * 残留口径：若有模组在那个回调里自己画玩家（而不是改模型标志），本注入拦不住它。这一条本仓无法覆盖，
 * 记录在此以免下一个人误判「整人一定没了」；</li>
 * <li><b>其它实体</b>：判据是 {@code entity == Minecraft.getMinecraft().thePlayer}，
 * 场景里别的玩家/生物照常渲染（它们是取证对象，不是要隐藏的人）。</li>
 * </ul>
 *
 * <h2>零影响保证（游戏正常帧）</h2>
 * 第一个 {@code if} 就问 {@link CaptureRenderState#isShotFrameActive()}，而它读的是
 * {@code ProjectionOverride.armed}——只由 {@code ShotExecutor.FrameScope#arm} 置真，
 * 游戏自身渲染帧从不经过那里 ⇒ 正常帧一次静态布尔读取后立即返回，不改 GL、不改实体、
 * 不跳过任何原本会画的东西。判定的布尔来源与线程口径见 {@link CaptureRenderState} 类注释。
 *
 * <p>
 * <b>类加载时机</b>：本注入引用的 {@code CaptureRenderState} 在客户端 main 源集里，无 mixin 反向引用
 * （capture 包不 import 任何 mixin 类），因此不存在「mixin 处理期提前加载 capture 包」的循环。
 * {@code RendererLivingEntity} 只在游戏启动（渲染管理器建立）时加载，晚于本 mod 的类初始化。
 */
@Mixin(RendererLivingEntity.class)
public abstract class MixinRendererLivingEntityShot {

    /**
     * 拍摄帧里取消真人玩家的整段渲染。
     *
     * <p>
     * 参数必须与目标方法 {@code RendererLivingEntity.doRender(EntityLivingBase, double, double, double,
     * float, float)} 对齐（本方法只用到 {@code entity}，其余照写是为了让 Mixin 能唯一定位到
     * {@code EntityLivingBase} 那个重载，而不是同名的 {@code doRender(Entity, ...)} 桥接方法）。
     */
    @Inject(method = "doRender", at = @At("HEAD"), cancellable = true)
    private void lightning$hidePlayerDuringShotFrame(EntityLivingBase entity, double x, double y, double z,
        float entityYaw, float partialTicks, CallbackInfo ci) {
        if (!CaptureRenderState.isShotFrameActive()) {
            return;
        }
        if (entity != Minecraft.getMinecraft().thePlayer) {
            return;
        }
        ci.cancel();
    }
}
