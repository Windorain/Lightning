package com.lightning.mod.client.controlplane.core;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * SHA-256 工具：产物登记、用例内容哈希、观测摘要哈希共用同一口径
 * （observation-record.md §2.1：对文件字节内容计算）。
 */
public final class Hashing {

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Hashing() {}

    /** 对字节数组计算 sha256 十六进制小写串。 */
    public static String sha256Hex(byte[] data) {
        MessageDigest md = newDigest();
        md.update(data == null ? new byte[0] : data);
        return toHex(md.digest());
    }

    /** 对 UTF-8 文本计算 sha256 十六进制小写串。 */
    public static String sha256HexUtf8(String text) {
        return sha256Hex(text == null ? new byte[0] : text.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 对流式内容计算 sha256 十六进制小写串（不把整个文件读入内存）。
     *
     * @throws IOException 读取失败
     */
    public static String sha256Hex(InputStream in) throws IOException {
        MessageDigest md = newDigest();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) {
            if (n > 0) {
                md.update(buf, 0, n);
            }
        }
        return toHex(md.digest());
    }

    /**
     * 对文件内容计算 sha256；文件不存在或不可读时抛 {@link CpException}（CP-IO-001）。
     */
    public static String sha256Hex(Path file) {
        if (file == null) {
            throw CpException.io("哈希目标为 null", null);
        }
        InputStream in = null;
        try {
            in = new BufferedInputStream(Files.newInputStream(file));
            return sha256Hex(in);
        } catch (IOException e) {
            throw CpException.io("计算 sha256 失败: " + file, e);
        } finally {
            closeQuietly(in);
        }
    }

    /** 十六进制编码（小写）。 */
    public static String toHex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int v = bytes[i] & 0xFF;
            out[i * 2] = HEX[v >>> 4];
            out[i * 2 + 1] = HEX[v & 0x0F];
        }
        return new String(out);
    }

    private static MessageDigest newDigest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            // JDK 8 必然提供 SHA-256；走到这里说明运行环境被裁剪
            throw new IllegalStateException("JVM 不提供 SHA-256", e);
        }
    }

    private static void closeQuietly(InputStream in) {
        if (in != null) {
            try {
                in.close();
            } catch (IOException ignored) {
                // 关闭失败不影响哈希结果
            }
        }
    }
}
