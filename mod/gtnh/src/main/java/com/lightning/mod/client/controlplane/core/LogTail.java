package com.lightning.mod.client.controlplane.core;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.google.gson.JsonObject;

/**
 * 客户端日志 tail（contract.md §2 的 {@code GET /cp/v1/logs/tail} 数据源）。
 *
 * <p>
 * 纯文件读取，不触碰 MC 状态，因此可以安全地在 HTTP 线程执行（contract.md §1.8）。
 * 只从文件尾部回读 {@link #MAX_SCAN_BYTES} 字节，避免大日志把内存打满；
 * 行数与扫描量都写进响应，方便调用方判断「拿到的不是全量」。
 */
public final class LogTail {

    /** 默认行数（contract.md §2）。 */
    public static final int DEFAULT_LINES = 200;

    /** 行数上限（contract.md §2）。 */
    public static final int MAX_LINES = 5000;

    /** 单次最多回读的字节数（4 MiB）。 */
    public static final int MAX_SCAN_BYTES = 4 * 1024 * 1024;

    private LogTail() {}

    /**
     * 取日志尾部若干行。
     *
     * @param file           日志文件
     * @param requestedLines 期望行数；&le;0 取 {@link #DEFAULT_LINES}，超过 {@link #MAX_LINES} 按上限
     * @return {@code {path, requestedLines, lines, truncated, content}}
     * @throws IOException 文件不存在或读取失败
     */
    public static JsonObject tail(Path file, int requestedLines) throws IOException {
        if (file == null) {
            throw new FileNotFoundException("日志路径为空");
        }
        if (!Files.isRegularFile(file)) {
            throw new FileNotFoundException(file.toString());
        }
        int want = requestedLines <= 0 ? DEFAULT_LINES : Math.min(requestedLines, MAX_LINES);
        long size = Files.size(file);
        long start = Math.max(0L, size - MAX_SCAN_BYTES);
        int len = (int) (size - start);
        byte[] buf = new byte[len];
        if (len > 0) {
            RandomAccessFile raf = new RandomAccessFile(file.toFile(), "r");
            try {
                raf.seek(start);
                raf.readFully(buf);
            } finally {
                raf.close();
            }
        }
        String text = new String(buf, StandardCharsets.UTF_8);
        String[] all = text.split("\r?\n", -1);
        int end = all.length;
        if (end > 0 && all[end - 1].isEmpty()) {
            end--;
        }
        int begin = Math.max(0, end - want);
        StringBuilder sb = new StringBuilder();
        for (int i = begin; i < end; i++) {
            if (sb.length() > 0) {
                sb.append('\n');
            }
            sb.append(all[i]);
        }
        int returned = Math.max(0, end - begin);
        JsonObject o = new JsonObject();
        o.addProperty(
            "path",
            file.toAbsolutePath()
                .toString());
        o.addProperty("requestedLines", requestedLines);
        o.addProperty("lines", returned);
        o.addProperty("truncated", start > 0 || begin > 0);
        o.addProperty("scannedBytes", len);
        o.addProperty("fileBytes", size);
        o.addProperty("content", sb.toString());
        return o;
    }
}
