package com.lightning.mod.client.meshcapture.finish;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 块录制结束后的四边形列表整理（归一化前）。
 */
@SideOnly(Side.CLIENT)
public interface BlockCaptureFinishStrategy {

    int priority();

    boolean applies(BlockCaptureFinishContext ctx);

    void finish(BlockCaptureFinishContext ctx);
}
