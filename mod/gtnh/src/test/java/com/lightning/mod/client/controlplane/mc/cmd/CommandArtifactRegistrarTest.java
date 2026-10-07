package com.lightning.mod.client.controlplane.mc.cmd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

import com.lightning.mod.core.export.RegistryDumpDelivery;

/**
 * {@link CommandArtifactRegistrar} 的就绪判据与队列语义（Gitea #102 裁决 6）。
 *
 * <h2>为什么这两条判据值得单测</h2>
 *
 * 「命令通道产物进 run 清单」的全部机制都压在 {@link CommandArtifactRegistrar.Pending#ready()} 上：
 *
 * <ol>
 * <li><b>{@code SceneFile.ready()}</b> 必须只在文件已是<b>客户端 enrich 后的终态</b>时为真。
 * 若它过早返回真，登记下来的就是服务端那份 {@code geometryPhase=scan} 半成品——实测后果是
 * D2 双通道比对必然判红，且红得没有意义（比的是半成品 vs 成品）。</li>
 * <li><b>{@code RegistryFiles.ready()}</b> 必须同时要求「投递单已被消费」且「三份文件都在」。
 * 少任何一条都会登记出空/缺份的清单项。</li>
 * </ol>
 *
 * <p>
 * 这两条都是<b>纯本地判定</b>（读文件 / 读投递单状态），不需要 MC 运行时，因此可以在纯 JVM 下钉死。
 */
public class CommandArtifactRegistrarTest {

    private static File tempDir() throws Exception {
        return Files.createTempDirectory("sde-deferred-reg")
            .toFile();
    }

    /** 服务端那份 scan 中间态**不是**终态（否则会登记半成品）。 */
    @Test
    public void sceneFileNotReadyForServerSideScanIntermediate() throws Exception {
        File dir = tempDir();
        File src = new File(dir, "demo.json");
        // 服务端 exportToFile 的 World 多帧形态：无 documentFormat，帧内还是 scan
        Files.write(
            src.toPath(),
            ("{\"id\":\"demo\",\"mode\":\"multiblock\",\"frames\":[{\"index\":0,\"structure\":"
                + "{\"geometryPhase\":\"scan\",\"id\":\"demo\",\"cellGrid\":[[[0]]],\"cellTypes\":[]}}],\"playback\":{}}")
                    .getBytes(StandardCharsets.UTF_8));
        CommandArtifactRegistrar.SceneFile p = new CommandArtifactRegistrar.SceneFile(
            src,
            "run-1",
            "cmd-exec/demo.json",
            100);
        assertFalse("scan 中间态不得被判为终态（否则登记半成品）", p.ready());
        assertTrue(
            "超时说明必须点出「还是中间态」",
            p.phaseNote()
                .contains("scan"));
    }

    /** 客户端 enrich 后的 Envelope 是终态。 */
    @Test
    public void sceneFileReadyAfterClientEnrichEnvelope() throws Exception {
        File dir = tempDir();
        File src = new File(dir, "demo.json");
        Files.write(
            src.toPath(),
            "{\"documentFormat\":\"Envelope\",\"payloadEncoding\":\"gzip+base64\",\"meta\":{},\"payload\":\"e30=\"}"
                .getBytes(StandardCharsets.UTF_8));
        CommandArtifactRegistrar.SceneFile p = new CommandArtifactRegistrar.SceneFile(
            src,
            "run-1",
            "cmd-exec/demo.json",
            100);
        assertTrue("Envelope 是客户端 enrich 的产物形态 ⇒ 终态", p.ready());
    }

    /** 显式 raw（Plain）也是终态——`/sde export raw` 走这条。 */
    @Test
    public void sceneFileReadyForExplicitPlainRaw() throws Exception {
        File dir = tempDir();
        File src = new File(dir, "demo.json");
        Files.write(
            src.toPath(),
            "{\"documentFormat\":\"Plain\",\"geometryPhase\":\"baked\",\"cellGrid\":[[[0]]],\"blockPalette\":[]}"
                .getBytes(StandardCharsets.UTF_8));
        CommandArtifactRegistrar.SceneFile p = new CommandArtifactRegistrar.SceneFile(
            src,
            "run-1",
            "cmd-exec/demo.json",
            100);
        assertTrue(p.ready());
    }

    /** 文件不存在 / 不是合法 JSON ⇒ 不就绪（不抛）。 */
    @Test
    public void sceneFileNotReadyWhenMissingOrMalformed() throws Exception {
        File dir = tempDir();
        CommandArtifactRegistrar.SceneFile missing = new CommandArtifactRegistrar.SceneFile(
            new File(dir, "nope.json"),
            "run-1",
            "cmd-exec/nope.json",
            100);
        assertFalse(missing.ready());
        assertTrue(missing.bytes() == null);

        File bad = new File(dir, "bad.json");
        Files.write(bad.toPath(), "not json at all".getBytes(StandardCharsets.UTF_8));
        CommandArtifactRegistrar.SceneFile malformed = new CommandArtifactRegistrar.SceneFile(
            bad,
            "run-1",
            "cmd-exec/bad.json",
            100);
        assertFalse("非法 JSON 不得被判为终态", malformed.ready());
    }

    /** 注册表：投递单未消费 ⇒ 不就绪；三份缺一 ⇒ 不就绪；齐了且已消费 ⇒ 就绪。 */
    @Test
    public void registryFilesReadyRequiresSettledRequestAndAllThreeFiles() throws Exception {
        RegistryDumpDelivery.clear();
        File dir = tempDir();
        File runDir = new File(dir, "cmd-exec");
        assertTrue(runDir.mkdirs());
        String[] names = { "block_registry.json", "material_registry.json", "model_registry.json" };
        for (String n : names) {
            Files.write(new File(runDir, n).toPath(), "{\"schemaVersion\":1}".getBytes(StandardCharsets.UTF_8));
        }
        RegistryDumpDelivery.Request req = RegistryDumpDelivery.request("run-2", runDir, "cmd-exec");
        assertTrue(req != null);
        CommandArtifactRegistrar.RegistryFiles p = new CommandArtifactRegistrar.RegistryFiles(
            req,
            runDir,
            names,
            "run-2",
            "cmd-exec",
            100);

        assertFalse("投递单未消费 ⇒ 不就绪（哪怕文件已存在）", p.ready());

        RegistryDumpDelivery.finish(req, null);
        assertTrue("已消费 + 三份齐 ⇒ 就绪", p.ready());

        // 缺一份 ⇒ 不就绪
        assertTrue(new File(runDir, "model_registry.json").delete());
        assertFalse("缺份 ⇒ 不就绪（不得登记出缺份清单）", p.ready());
        RegistryDumpDelivery.clear();
    }

    /** 投递单写出失败 ⇒ 永不就绪（由 pump 在超时后如实记 WARN，不静默登记空产物）。 */
    @Test
    public void registryFilesNeverReadyWhenClientWriteFailed() throws Exception {
        RegistryDumpDelivery.clear();
        File dir = tempDir();
        File runDir = new File(dir, "cmd-exec");
        assertTrue(runDir.mkdirs());
        String[] names = { "block_registry.json", "material_registry.json", "model_registry.json" };
        RegistryDumpDelivery.Request req = RegistryDumpDelivery.request("run-3", runDir, "cmd-exec");
        CommandArtifactRegistrar.RegistryFiles p = new CommandArtifactRegistrar.RegistryFiles(
            req,
            runDir,
            names,
            "run-3",
            "cmd-exec",
            100);
        RegistryDumpDelivery.finish(req, "图集未就绪");
        assertFalse("写出失败时不得就绪", p.ready());
        assertFalse("settled 必须为 false（成功语义）", p.settled());
        assertEquals("图集未就绪", p.error());
        RegistryDumpDelivery.clear();
    }

    /** 入队/长度/清空的基础语义（pump 的装配正确性由实机验收覆盖）。 */
    @Test
    public void queueEnqueueAndSize() throws Exception {
        CommandArtifactRegistrar.clearForTest();
        assertEquals(0, CommandArtifactRegistrar.size());
        File dir = tempDir();
        File src = new File(dir, "a.json");
        Files.write(src.toPath(), "{}".getBytes(StandardCharsets.UTF_8));
        CommandArtifactRegistrar.enqueue(new CommandArtifactRegistrar.SceneFile(src, "run-4", "cmd-exec/a.json", 5));
        CommandArtifactRegistrar.enqueue(null);
        assertEquals("null 不入队", 1, CommandArtifactRegistrar.size());
        assertEquals(
            "1",
            CommandArtifactRegistrar.describeForTest()
                .get(0)
                .split("\\|")[0].replace("run-4", "1"));
        CommandArtifactRegistrar.clearForTest();
        assertEquals(0, CommandArtifactRegistrar.size());
    }
}
