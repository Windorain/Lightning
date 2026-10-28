package com.lightning.mod.core.export;

/**
 * 服务端写出 {@link #FILE_NAME}，客户端轮询同目录并生成全量 block_registry / material_registry（无自定义网络包）。
 * <p>
 * {@link #SCHEMA_VERSION} 为 <strong>pending_dump 小协议</strong>顶层字段，与 StructureData / World / capture 的 schema 无关。
 */
public final class PendingDumpFiles {

    public static final String FILE_NAME = "pending_dump.json";

    /** {@code pending_dump.json} 根对象 {@code schemaVersion}，仅用于触发文件握手。 */
    public static final int SCHEMA_VERSION = 1;

    private PendingDumpFiles() {}
}
