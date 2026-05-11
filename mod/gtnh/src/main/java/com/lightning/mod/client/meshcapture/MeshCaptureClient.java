package com.lightning.mod.client.meshcapture;

import java.util.concurrent.ConcurrentLinkedQueue;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 从网络包入队导出 JSON 字节，在客户端 tick 中顺序执行 {@link MeshCaptureService#enrichAndWriteClientExport}，避免在 Netty 线程调用 GL。
 * 捕获依赖 {@code theWorld}、{@code scanBounds} 及扫描区域区块已加载；失败时打日志。
 */
@SideOnly(Side.CLIENT)
public final class MeshCaptureClient {

    private static final ConcurrentLinkedQueue<Payload> PENDING = new ConcurrentLinkedQueue<>();

    private MeshCaptureClient() {}

    public static void enqueuePayload(String fileName, byte[] utf8Json, boolean writeRaw) {
        if (fileName != null && !fileName.isEmpty() && utf8Json != null && utf8Json.length > 0) {
            PENDING.offer(new Payload(fileName, utf8Json, writeRaw));
        }
    }

    /** 每 tick 至多处理一个文件，避免长时间卡帧。 */
    public static void tickConsumeOne() {
        Payload p = PENDING.poll();
        if (p == null) {
            return;
        }
        try {
            MeshCaptureService.enrichAndWriteClientExport(p.fileName, p.utf8Json, p.writeRaw);
        } catch (Exception e) {
            FMLLog.severe("[SDE] mesh capture enrich failed: " + p.fileName + " — " + e.getMessage());
            e.printStackTrace();
        }
    }

    private static final class Payload {

        final String fileName;
        final byte[] utf8Json;
        final boolean writeRaw;

        Payload(String fileName, byte[] utf8Json, boolean writeRaw) {
            this.fileName = fileName;
            this.utf8Json = utf8Json;
            this.writeRaw = writeRaw;
        }
    }
}
