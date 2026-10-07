package com.lightning.mod.client.controlplane.core;

/**
 * 控制面契约 v1（{@code lightning.controlplane}）的不可变常量集合。
 *
 * <p>
 * 常量值取自 {@code docs/control-plane/contract.md}；任何取值变更都必须与文档同步修订，
 * 因为调用方依赖它们（URI 前缀即契约大版本，错误码只增不改义）。
 */
public final class Contract {

    /**
     * 契约版本（{@code GET /cp/v1/about} 的 {@code contractVersion} 字段）。
     * 1.0=PR-1 动作面；1.1=PR-2 取证动作；1.2=PR-3 双轨判据（te-state-equals/image-uniform）；
     * 1.3=观察面读面 + L0 布景原语（issue #98：{@code read.*} 八动作；issue #99：{@code scene.*} 六动作，
     * 见 contract.md §4.1/§4.4）；
     * 1.4=收口T3 命令通道（issue #100：{@code cmd.exec} / {@code export.session}，见 contract.md §4.5）；
     * 1.5=L1 玩家操作（issue #101：{@code player.*} 九动作，见 contract.md §4.6；调度者撞号裁决：
     * 本单分支自报 1.4 与 #100 撞号，合流时统一为 1.5）；
     * 1.6=无人值守收尾原语（issue #103：{@code core.shutdown}，见 contract.md §4.8）；
     * 1.7=收口批次（调度者裁决）：L0 流体注入（issue #122：{@code scene.tank.fill}，见 contract.md §4.4；
     * 同一批的 {@code scene.inventory.write} 追加 {@code material}+{@code prefix} 条目形态
     * ——只增可选字段、不改既有语义，故该动作 {@code since} 仍为 1.3）；
     * 并轨同批：导出族（#102，见 contract.md §4.7）与捕获诊断（#114，见 contract.md §4.1）。
     * 小版本只增不改义（contract.md §5）。
     *
     * <p>
     * <b>撞号提示（如实留痕）</b>：#102/#114/#122/#123 四单并行，各自开号必然撞号（#122 自报 1.6，
     * 与 #103 的 1.6 冲突）。四单同为「只增」，撞号不产生语义冲突，但 {@code contractVersion}
     * 只能有一个值——由调度者统一裁决为 <b>1.7</b>（并禁止出现 {@code 1.10} 这类值：
     * 版本按字符串/浮点比较，{@code 1.10} 会排到 {@code 1.6} 之前）。
     *
     * <p>
     * <b>不变式</b>：本值必须 ≥ 任一动作自描述的 {@code since}——否则自述端点会给出
     * 「服务契约版本比某个动作的引入版本还旧」这种自相矛盾的目录（D1/D3 会判红）。
     * 新增动作时两处要一起改。
     */
    public static final String VERSION = "1.7";

    /** 契约 URI 前缀，即契约大版本。 */
    public static final String PREFIX = "/cp/v1";

    /** 默认监听端口（contract.md §1.3）。 */
    public static final int DEFAULT_PORT = 23057;

    /** 默认绑定地址：仅回环。 */
    public static final String DEFAULT_BIND = "127.0.0.1";

    /** 端口回退尝试次数上限（{@code preferred + 1 .. preferred + 127}）。 */
    public static final int MAX_PORT_ATTEMPTS = 128;

    /** 日志前缀约定；core 层写出的每条日志都已带此前缀（注入的 logger 不得重复添加）。 */
    public static final String LOG_PREFIX = "[SDE][CP]";

    /** {@code tokens.json} 的 schema 标识。 */
    public static final String SCHEMA_TOKENS = "lightning.cp-tokens/1";

    /** {@code server.json} 的 schema 标识（文档未规定，属实现细节）。 */
    public static final String SCHEMA_SERVER = "lightning.cp-server/1";

    /** run 目录 {@code manifest.json} 的 schema 标识（文档未规定，属实现细节）。 */
    public static final String SCHEMA_MANIFEST = "lightning.cp-manifest/1";

    /** 判据汇总 {@code criteria.json} 的 schema 标识。 */
    public static final String SCHEMA_CRITERIA = "lightning.criteria/1";

    /** 用例文件 schema（case-file.md §1）。 */
    public static final String SCHEMA_CASE = "lightning.case/1";

    /** 观测记录 schema（observation-record.md §1）。 */
    public static final String SCHEMA_OBSERVATION = "lightning.observation/1";

    /** 托管世界元数据文件名（contract.md §6.1）。 */
    public static final String MANAGED_WORLD_MARKER = "cp_world.json";

    /** 托管世界存档目录前缀（contract.md §6.1）。 */
    public static final String MANAGED_WORLD_PREFIX = "cp_";

    private Contract() {}
}
