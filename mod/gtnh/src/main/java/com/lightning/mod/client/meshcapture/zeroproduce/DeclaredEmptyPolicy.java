package com.lightning.mod.client.meshcapture.zeroproduce;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import net.minecraft.tileentity.TileEntity;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * "合法为空"：这一格<strong>本来</strong>就没有可画的东西，不落占位，只留痕。
 * <p>
 * 与"拒绝渲染名单"的分工：后者回答"要不要尝试渲染"（发生在<strong>渲染前</strong>，例如会在离屏烘焙下读世界/玩家状态的
 * 渲染器）；本策略回答"试过了但没有产出，这一格算合法空还是丢失"（发生在<strong>渲染后</strong>）。两者判据不同、
 * 时机不同、后果也不同，混成一个开关会让"省一次渲染"与"承认一次丢失"互为掩护。
 * <p>
 * <strong>判定必须看副本 TE 的状态，不能只看类名。</strong>已登记的唯一一项是转运器：<em>没有任何 attachment</em>
 * 的转运器渲染器合法地什么都不画；而<strong>带 attachment</strong> 的转运器捕获失败则必须走占位——
 * 那是一次真实的丢失。把这条写反会把真丢失洗成"合法空"，而这正是本机制要防的事。
 * <p>
 * 保守性：类名命中但拿不到 TE（副本创建失败）、或状态形状不认识时，一律<strong>不</strong>判合法空——
 * 交给兜底落占位。"承认丢失"比"假装没画"安全。
 */
@SideOnly(Side.CLIENT)
public final class DeclaredEmptyPolicy implements ZeroProducePolicy {

    /**
     * 数值必须<strong>小于</strong>占位策略：名单的作用是"减少误报占位"，若占位策略先命中，合法为空的格
     * 会先被判成占位、名单永远轮不到——那等于给空气画个方块。故本条排在
     * {@link TesrOnlyBlockPlaceholderPolicy}（{@value TesrOnlyBlockPlaceholderPolicy#DEFAULT_PRIORITY}）之前。
     */
    public static final int DEFAULT_PRIORITY = 900;

    /** 原因枚举：命中名单里的哪一项。 */
    public static final String REASON_TRANSLOCATOR_WITHOUT_ATTACHMENT = "declared_empty_translocator_without_attachment";

    /** 转运器基类（转运器家族的所有 TE 都继承它：物品型与液体型共用同一套 attachment 状态）。 */
    private static final String TRANSLOCATOR_BASE_CLASS = "codechicken.translocator.TileTranslocator";

    /** 承载 attachment 的字段名（数组，元素为 null 表示该侧没有 attachment）。 */
    private static final String ATTACHMENT_FIELD = "attachments";

    private static final List<Declaration> DECLARATIONS = Collections.unmodifiableList(
        Arrays.asList(
            new Declaration(
                REASON_TRANSLOCATOR_WITHOUT_ATTACHMENT,
                TRANSLOCATOR_BASE_CLASS,
                new AttachmentStateCheck())));

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(ZeroProduceContext ctx) {
        return matchedDeclaration(ctx) != null;
    }

    @Override
    public Decision decide(ZeroProduceContext ctx) {
        Declaration d = matchedDeclaration(ctx);
        return Decision.declaredEmpty(d != null ? d.id : "declared_empty_unspecified");
    }

    /** 命中的声明项；没有命中返回 {@code null}。 */
    private static Declaration matchedDeclaration(ZeroProduceContext ctx) {
        if (ctx == null || ctx.quadCount() > 0) {
            return null;
        }
        TileEntity te = ctx.tileEntity();
        if (te == null) {
            // 没有副本 TE 就没有状态可判：不得据此宣布"合法空"
            return null;
        }
        for (Declaration d : DECLARATIONS) {
            if (d.matches(te)) {
                return d;
            }
        }
        return null;
    }

    /**
     * 一条"合法为空"声明：类名命中<strong>且</strong>状态判据成立才算命中。
     * 类名比较走 {@code isInstance}（子类也算），因此不必逐个列出转运器的具体实现类。
     */
    static final class Declaration {

        final String id;
        final String className;
        final StateCheck stateCheck;

        Declaration(String id, String className, StateCheck stateCheck) {
            this.id = id;
            this.className = className;
            this.stateCheck = stateCheck;
        }

        boolean matches(TileEntity te) {
            Class<?> declared = resolve();
            if (declared == null || !declared.isInstance(te)) {
                return false;
            }
            return stateCheck.accepts(te);
        }

        private Class<?> resolve() {
            try {
                return Class.forName(className, false, DeclaredEmptyPolicy.class.getClassLoader());
            } catch (Throwable ignored) {
                // 该模组不在场：这条声明在本环境里永不命中
                return null;
            }
        }
    }

    /** 状态判据：给定 TE 实例，判断"什么都没有"是否成立。 */
    interface StateCheck {

        boolean accepts(TileEntity te);
    }

    /** 转运器：所有侧都没有 attachment 时才合法为空。 */
    static final class AttachmentStateCheck implements StateCheck {

        @Override
        public boolean accepts(TileEntity te) {
            return allEntriesNullOrAbsent(readField(te, ATTACHMENT_FIELD));
        }
    }

    private static Object readField(Object target, String name) {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException ignored) {
                // 继续向上找
            } catch (Throwable ignored) {
                return null;
            }
        }
        return null;
    }

    /**
     * attachment 容器的"全空"判据（纯函数，单测直接打这条）。
     * <ul>
     * <li>{@code null}（字段缺失或为 null）⇒ 没有 attachment；</li>
     * <li>数组且所有元素为 {@code null} ⇒ 没有 attachment；</li>
     * <li>数组里有任一非 {@code null} 元素 ⇒ <strong>有</strong> attachment（必须走占位）；</li>
     * <li>形状不认识（不是数组）⇒ 不得当作"合法空"——保守返回 false。</li>
     * </ul>
     */
    static boolean allEntriesNullOrAbsent(Object attachmentContainer) {
        if (attachmentContainer == null) {
            return true;
        }
        if (!attachmentContainer.getClass()
            .isArray()) {
            return false;
        }
        int length = Array.getLength(attachmentContainer);
        for (int i = 0; i < length; i++) {
            if (Array.get(attachmentContainer, i) != null) {
                return false;
            }
        }
        return true;
    }
}
