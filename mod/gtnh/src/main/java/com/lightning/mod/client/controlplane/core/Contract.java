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
     * 1.0=动作面；1.1=取证动作；1.2=双轨判据（te-state-equals/image-uniform）；
     * 1.3=观察面读面 + L0 布景原语（{@code read.*} 八动作；{@code scene.*} 六动作，
     * 见 contract.md §7.2/§7.5）；
     * 1.4=命令通道（{@code cmd.exec} / {@code export.session}，见 contract.md §7.6）；
     * 1.5=L1 玩家操作（{@code player.*} 九动作，见 contract.md §7.7）：
     * 1.6=无人值守收尾原语（{@code core.shutdown}，见 contract.md §7.9）；
     * 1.7=导出与产物纪律批次：
     * <ul>
     * <li>导出与产物纪律（{@code export.scene} / {@code export.registry} /
     * {@code export.multiblock} 三动作，见 contract.md §7.8）；</li>
     * <li>托管世界标记前置与 {@code complete} 状态机（{@code world.rebuild} 的标记前置 +
     * {@code world.info} 新增 {@code markerComplete} 响应字段 + {@code world.snapshot} 只接受构建完成的
     * 世界，见 contract.md §10 第 2 条/第 10 条）；</li>
     * <li>L0 流体注入（{@code scene.tank.fill}，见 contract.md §7.5；同一批的
     * {@code scene.inventory.write} 追加 {@code material}+{@code prefix} 条目形态——只增可选字段、
     * 不改既有语义，故该动作 {@code since} 仍为 1.3）；</li>
     * <li>捕获通道自证诊断由 {@code read.capture} 读面（§7.2）与 {@code capture.diag}
     * 布防/drain-dump（§7.4）承担。</li>
     * </ul>
     * 1.8=通用玩家输入设施：
     * <ul>
     * <li>输入手段族五个动作注册（{@code input.key} / {@code input.text} / {@code input.mouse} /
     * {@code input.release} 四个 {@code scene} 级可写动作 + {@code input.state} 只读观察面），
     * 见 contract.md §7.10 与 {@code input-contract.md}；</li>
     * <li>{@code ActionDescriptor} 新增<b>可选</b>自描述字段 {@code means}（手段归因）。<b>不设默认值</b>：
     * 只在承担归因义务的动作上写（本版本只为输入族写 {@code "input"}），缺省时该键<b>不出现</b>，
     * 因此是 43 个既有动作自描述 JSON 的逐字节不变增量——见 {@code contract.md} §5 的「离线防线」；</li>
     * <li>输入族返回值以 {@code means:"input"} 归因、{@code layer} 恒 {@code null}（§7.7 第 6 条的
     * {@code layer}/{@code semantics} 成对规则的<b>显式例外</b>，理由见 {@code input-contract.md} §9 第 3 条）。</li>
     * </ul>
     * 小版本只增不改义（contract.md §13）。
     *
     * <p>
     * <b>版本号要点</b>：多批「只增」能力同期落地时，{@code contractVersion}
     * 只能有一个值，故统一取 <b>1.7</b>（并禁止出现 {@code 1.10} 这类值：
     * 版本按字符串/浮点比较，{@code 1.10} 会排到 {@code 1.6} 之前）。
     *
     * <p>
     * <b>1.7 为什么算增量而不是破坏</b>：新增的是响应字段与一个新的世界状态（构建中的
     * {@code complete:false}）。既有世界（旧代码建的标记无 {@code complete} 键 ⇒ 按完成读）行为逐字不变，
     * {@code world.snapshot} 的接受集合因此没有缩小；被新拒的只有「本次构建尚未收口的世界」——
     * 那个状态在 1.7 之前根本不存在（那时它是「无标记」，本来就被拒）。
     *
     * <p>
     * <b>不变式</b>：本值必须 ≥ 任一动作自描述的 {@code since}——否则自述端点会给出
     * 「服务契约版本比某个动作的引入版本还旧」这种自相矛盾的目录（D1/D3 会判红）。
     * 新增动作时两处要一起改。
     *
     * <p>
     * <b>1.8 为什么算增量而不是破坏</b>：五个新动作是纯新增；{@code means} 是<b>可选</b>字段
     * （缺省不出现，既有动作 JSON 逐字节不变）；输入族返回值是新增形态，不改任何既有动作的语义。
     * 唯一被改动的既有契约文字是「动作计数 43→48」与「版本 1.7→1.8」，两者都是计数/版本前进，
     * 不是语义变更。
     */
    public static final String VERSION = "1.8";

    /** 契约 URI 前缀，即契约大版本。 */
    public static final String PREFIX = "/cp/v1";

    /** 默认监听端口（contract.md §1 第 4 条）。 */
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

    /** 托管世界元数据文件名（contract.md §10 第 1 条）。 */
    public static final String MANAGED_WORLD_MARKER = "cp_world.json";

    /** 托管世界存档目录前缀（contract.md §10 第 1 条）。 */
    public static final String MANAGED_WORLD_PREFIX = "cp_";

    private Contract() {}
}
