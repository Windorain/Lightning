package com.lightning.mod.client.meshcapture.finish;

import java.util.Locale;
import java.util.Set;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 当存在动态扩展层四边形时，删除主路径层四边形，避免模组「静态 + TESR 族」双套叠层。
 * <p>
 * <strong>默认不注册</strong>；构造时传入小写 {@code modid:block} 集合，再 {@link BlockCaptureFinishRegistry#register}。
 */
@SideOnly(Side.CLIENT)
public final class SuppressPrimaryQuadsWhenExtensionPresentFinisher implements BlockCaptureFinishStrategy {

    private final Set<String> registryKeysLowercase;
    private final int prio;

    public SuppressPrimaryQuadsWhenExtensionPresentFinisher(Set<String> registryKeysLowercase) {
        this(registryKeysLowercase, 1000);
    }

    public SuppressPrimaryQuadsWhenExtensionPresentFinisher(Set<String> registryKeysLowercase, int priority) {
        this.registryKeysLowercase = registryKeysLowercase;
        this.prio = priority;
    }

    @Override
    public int priority() {
        return prio;
    }

    @Override
    public boolean applies(BlockCaptureFinishContext ctx) {
        if (registryKeysLowercase == null || registryKeysLowercase.isEmpty()) {
            return false;
        }
        String key = ctx.getRegistryKey();
        if (key.isEmpty()) {
            return false;
        }
        if (!registryKeysLowercase.contains(key.toLowerCase(Locale.ROOT))) {
            return false;
        }
        boolean anyExtension = false;
        for (CapturedQuad q : ctx.getQuads()) {
            if (q.fromDynamicExtensionPass) {
                anyExtension = true;
                break;
            }
        }
        return anyExtension;
    }

    @Override
    public void finish(BlockCaptureFinishContext ctx) {
        ctx.getQuads()
            .removeIf(q -> !q.fromDynamicExtensionPass);
    }
}
