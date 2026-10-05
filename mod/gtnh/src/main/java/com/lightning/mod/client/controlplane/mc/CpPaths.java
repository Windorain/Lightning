package com.lightning.mod.client.controlplane.mc;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 控制面产物路径口径（contract.md §1.9/§1.10）。
 *
 * <p>
 * 一切产物落 {@code <mcDataDir>/controlplane/}，<b>绝不写 CWD 相对路径</b>：
 * 
 * <pre>
 * controlplane/
 *   server.json          实际绑定端口与契约版本
 *   tokens.json          三级 token
 *   events.jsonl         事件流水（全量）
 *   runs/&lt;runId&gt;/        case.run 与场景动作的 run 目录
 *   snapshots/&lt;id&gt;/      世界快照（整目录复制）
 *   snapshots/&lt;id&gt;.json  快照元数据（树哈希清单）
 *   cases/               用例文件默认目录（case.validate/case.run 的相对路径基准）
 * </pre>
 */
public final class CpPaths {

    /** 控制面数据目录名（相对 mcDataDir）。 */
    public static final String DIR_NAME = "controlplane";

    private CpPaths() {}

    /** {@code <mcDataDir>/controlplane}。 */
    public static Path dataDir(File mcDataDir) {
        File base = mcDataDir == null ? new File(".") : mcDataDir;
        return new File(base, DIR_NAME).toPath()
            .toAbsolutePath()
            .normalize();
    }

    /** {@code <mcDataDir>/controlplane/runs}。 */
    public static Path runsRoot(File mcDataDir) {
        return dataDir(mcDataDir).resolve("runs");
    }

    /** {@code <mcDataDir>/controlplane/snapshots}。 */
    public static Path snapshotsRoot(File mcDataDir) {
        return dataDir(mcDataDir).resolve("snapshots");
    }

    /** {@code <mcDataDir>/controlplane/cases}。 */
    public static Path casesRoot(File mcDataDir) {
        return dataDir(mcDataDir).resolve("cases");
    }

    /** {@code <mcDataDir>/controlplane/tokens.json}。 */
    public static Path tokensFile(File mcDataDir) {
        return dataDir(mcDataDir).resolve("tokens.json");
    }

    /** {@code <mcDataDir>/controlplane/events.jsonl}。 */
    public static Path eventsFile(File mcDataDir) {
        return dataDir(mcDataDir).resolve("events.jsonl");
    }

    /** {@code <mcDataDir>/logs/fml-client-latest.log}（logs/tail 数据源）。 */
    public static Path clientLogFile(File mcDataDir) {
        File base = mcDataDir == null ? new File(".") : mcDataDir;
        return new File(new File(base, "logs"), "fml-client-latest.log").toPath()
            .toAbsolutePath()
            .normalize();
    }

    /**
     * {@code <mcDataDir>/saves}（存档根）。
     *
     * <p>
     * 客户端 1.7.10 的存档根恒为 {@code mcDataDir/saves}；不用 {@code getSaveLoader()} 免得依赖
     * 运行期状态。
     */
    public static Path savesRoot(File mcDataDir) {
        File base = mcDataDir == null ? new File(".") : mcDataDir;
        return new File(base, "saves").toPath()
            .toAbsolutePath()
            .normalize();
    }

    /** 把任意字符串路径解析为绝对路径（相对路径按 {@code base} 解析）。 */
    public static Path resolve(Path base, String raw) {
        Path p = Paths.get(raw);
        return p.isAbsolute() ? p.normalize()
            : base.resolve(p)
                .normalize();
    }
}
