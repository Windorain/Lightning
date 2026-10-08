package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import org.junit.Test;

/**
 * 进程退出清理链的**接线守卫**（Gitea #166 的 DR-3）。
 *
 * <h2>为什么用源码文本而不是调用栈做判据</h2>
 * 「进程正常退出时会尽力投递抬起」这条承诺横跨两层：{@code core/ControlPlaneServer} 只提供钩子里的
 * 清理段（它不认识输入设施），真正的释放由 {@code mc/ControlPlaneBootstrap} 注册（那是唯一同时
 * 看得到控制面与输入设施的装配点）。两处**任意一处断线**，机读面都重新变成「宣称了一条没有代码的路径」，
 * 而这条链路在单测里无法端到端触发（要跑真 JVM 退出）。
 *
 * <p>
 * 因此本守卫钉住接线本身：钩子体必须调用清理段，且装配点必须把输入运行时的**释放入口**注册进去
 * （不是「随便注册一个 Runnable」）。它与 {@code ControlPlaneServerTest} 的行为断言互补：
 * 那条证明「注册了就会跑、抛了也不阻断」，本条证明「真的注册了输入释放」。
 */
public class ControlPlaneShutdownWiringTest {

    /** {@code <repoRoot>}（从 {@code user.dir} 向上找，与 {@code CaseSegmentOrderDocTest} 同一手法）。 */
    private static Path repoRoot() {
        Path dir = Paths.get("")
            .toAbsolutePath()
            .normalize();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("docs")
                .resolve("control-plane");
            if (Files.isDirectory(candidate)) {
                return dir;
            }
            dir = dir.getParent();
        }
        fail(
            "找不到仓根（从 " + Paths.get("")
                .toAbsolutePath() + " 向上 8 层没有 docs/control-plane）——退出清理接线守卫无法执行");
        return null;
    }

    private static String source(String relativePath) throws IOException {
        Path p = repoRoot().resolve(relativePath);
        assertTrue("守卫自身失效：源文件不存在 " + p, Files.isRegularFile(p));
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    private static final String CP = "mod/gtnh/src/main/java/com/lightning/mod/client/controlplane/";

    /** 既有 shutdown hook 必须在停服务之前跑清理段（§3.4 路径 5）。 */
    @Test
    public void shutdownHookRunsTheCleanupBeforeStopping() throws IOException {
        String src = source(CP + "core/ControlPlaneServer.java");
        assertTrue("shutdown hook 必须调用 runShutdownCleanup()（否则 §3.4 路径 5 只是散文）", src.contains("runShutdownCleanup();"));
        int hook = src.indexOf("installShutdownHook()");
        assertTrue("守卫自身失效：找不到 installShutdownHook", hook > 0);
        int cleanupCall = src.indexOf("runShutdownCleanup();", hook);
        int stopCall = src.indexOf("stop();", hook);
        assertTrue("钩子体里清理必须排在 stop() 之前", cleanupCall > 0 && stopCall > cleanupCall);
        assertTrue(
            "best-effort 的语义要求整段吞异常并只 WARN",
            src.contains("catch (Throwable t)") && src.contains("进程退出时的 best-effort 清理失败"));
    }

    /** 装配点必须把**输入运行时的释放入口**注册进既有钩子（而不是留空或另起一条链）。 */
    @Test
    public void bootstrapRegistersTheInputReleaseEntryPoint() throws IOException {
        String src = source(CP + "mc/ControlPlaneBootstrap.java");
        assertTrue("装配点必须注册退出清理", src.contains("setShutdownCleanup("));
        assertTrue("清理体必须经唯一实现点（InputRuntimeImpl.shared()）走释放入口", src.contains("InputRuntimeImpl.shared()"));
        assertTrue(
            "退出钩子不在 tick 线程上 ⇒ 必须走不校验 owner 线程的 releaseAllForShutdown()",
            src.contains("releaseAllForShutdown()"));
        assertTrue(
            "注册必须发生在 installShutdownHook() 之前",
            src.indexOf("setShutdownCleanup(") < src.indexOf("srv.installShutdownHook()"));
    }

    /** 取消注册/停服务不得把清理段顺手删掉（负对照：这条断言本身必须能失败——见下条用例）。 */
    @Test
    public void guardItselfIsFalsifiable() throws IOException {
        String src = source(CP + "core/ControlPlaneServer.java");
        assertTrue("守卫的判据必须是文件里真实存在的字符串", src.contains("public void runShutdownCleanup()"));
        // 负对照：一个不存在的方法名在同一个文件里必然找不到 —— 说明上面的 contains 判据真的在判东西，
        // 而不是恒真（恒真的守卫等于没有守卫）。
        assertTrue(!src.contains("runShutdownCleanupAndAlsoReleaseInputs();"));
    }
}
