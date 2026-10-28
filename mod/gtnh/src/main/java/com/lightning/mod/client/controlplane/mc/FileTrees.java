package com.lightning.mod.client.controlplane.mc;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Hashing;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 目录树工具：整目录复制、删除、以及「目录哈希清单」（world.snapshot / world.rollback 的 v1 口径）。
 *
 * <h2>哈希口径</h2>
 * 目录哈希清单 = {@code {"files":[{"path","bytes","sha256"}, ...]}}，{@code path} 为相对根的
 * {@code '/'} 分隔路径并<b>按字典序排序</b>，<b>不含目录项</b>（空目录不影响树哈希）。
 * 树哈希 = {@link Json#canonical} 规范化（键排序、无空白）后的 sha256——与
 * observation-record.md §2 第 1 条的摘要哈希口径一致，因此同一份目录内容在任意机器上哈希相同。
 */
public final class FileTrees {

    /** 一个文件的哈希清单项。 */
    public static final class Entry {

        private final String path;
        private final long bytes;
        private final String sha256;

        Entry(String path, long bytes, String sha256) {
            this.path = path;
            this.bytes = bytes;
            this.sha256 = sha256;
        }

        /** 相对路径（'/' 分隔）。 */
        public String path() {
            return path;
        }

        /** 字节数。 */
        public long bytes() {
            return bytes;
        }

        /** 内容 sha256。 */
        public String sha256() {
            return sha256;
        }

        /** {@code {path,bytes,sha256}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("path", path);
            o.addProperty("bytes", bytes);
            o.addProperty("sha256", sha256);
            return o;
        }
    }

    /** 一棵目录树的哈希清单。 */
    public static final class Manifest {

        private final List<Entry> files;
        private final long bytes;
        private final String treeSha256;

        Manifest(List<Entry> files, long bytes, String treeSha256) {
            this.files = Collections.unmodifiableList(files);
            this.bytes = bytes;
            this.treeSha256 = treeSha256;
        }

        /** 文件清单（按路径排序）。 */
        public List<Entry> files() {
            return files;
        }

        /** 文件总字节数。 */
        public long bytes() {
            return bytes;
        }

        /** 树哈希（见类注释）。 */
        public String treeSha256() {
            return treeSha256;
        }

        /** 文件数。 */
        public int fileCount() {
            return files.size();
        }

        /** {@code {treeSha256,fileCount,bytes,files:[...]}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("treeSha256", treeSha256);
            o.addProperty("fileCount", files.size());
            o.addProperty("bytes", bytes);
            JsonArray arr = new JsonArray();
            for (Entry e : files) {
                arr.add(e.toJson());
            }
            o.add("files", arr);
            return o;
        }
    }

    private FileTrees() {}

    /** 递归复制目录树（目标已存在的同名文件覆盖）。 */
    public static void copyTree(final Path src, final Path dst) throws IOException {
        if (!Files.isDirectory(src)) {
            throw new IOException("源目录不存在: " + src);
        }
        Files.createDirectories(dst);
        Files.walkFileTree(src, new SimpleFileVisitor<Path>() {

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                Files.createDirectories(dst.resolve(src.relativize(dir)));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.copy(
                    file,
                    dst.resolve(src.relativize(file)),
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.COPY_ATTRIBUTES);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /** 递归删除目录树（目录不存在时无操作）。 */
    public static void deleteTree(final Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<Path>() {

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException exc) throws IOException {
                // Windows 上偶发的句柄未释放：尽力再删一次，失败则上报
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                if (exc != null) {
                    throw exc;
                }
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /**
     * 计算目录树的哈希清单。
     *
     * @throws IOException 遍历或读取失败
     */
    public static Manifest manifest(final Path root) throws IOException {
        final List<Entry> entries = new ArrayList<Entry>();
        if (Files.isDirectory(root)) {
            Files.walkFileTree(root, new SimpleFileVisitor<Path>() {

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    String rel = root.relativize(file)
                        .toString()
                        .replace('\\', '/');
                    String sha = sha256Of(file);
                    entries.add(new Entry(rel, Files.size(file), sha));
                    return FileVisitResult.CONTINUE;
                }
            });
        }
        entries.sort(Comparator.comparing(Entry::path));
        long total = 0L;
        JsonArray arr = new JsonArray();
        for (Entry e : entries) {
            total += e.bytes();
            JsonObject o = new JsonObject();
            o.addProperty("path", e.path());
            o.addProperty("bytes", e.bytes());
            o.addProperty("sha256", e.sha256());
            arr.add(o);
        }
        JsonObject canonical = new JsonObject();
        canonical.add("files", arr);
        String treeSha = Hashing.sha256HexUtf8(Json.canonical(canonical));
        return new Manifest(entries, total, treeSha);
    }

    /** 单文件 sha256（流式，不整文件入内存）。 */
    public static String sha256Of(Path file) throws IOException {
        InputStream in = Files.newInputStream(file);
        try {
            return Hashing.sha256Hex(in);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 关闭失败不影响哈希
            }
        }
    }
}
