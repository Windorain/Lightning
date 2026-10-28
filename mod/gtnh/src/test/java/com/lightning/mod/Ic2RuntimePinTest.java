package com.lightning.mod;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import org.junit.Test;

/**
 * IC2 运行期版本的静态守卫。
 *
 * <p>
 * 运行期必须落在 CurseForge 2.2.828（文件 6833054），不得回退到 gtnhconvention 2.0.19 默认的
 * CurseForge 2353971（该文件 mcmod.info 自报 2.2.827）。本测试只检查构建配置，不启动客户端，
 * 也不替代 check 绑定的 Gradle 实际解析判据（{@code ic2RuntimePinCheck}）；test 不解析运行期依赖矩阵。
 * </p>
 *
 * <p>
 * 断言前会先剔除 Groovy 的 {@code //} 行注释与块注释、以及 properties 的 {@code #}/{@code !}
 * 注释，避免“注释掉配置但保留说明文字”仍然变绿；负向用例会把删块/注释 flag 的副本写到
 * 操作系统临时目录再读回，证明检查逻辑不是空转。
 * </p>
 *
 * <p>
 * 路径解析从 {@code user.dir} 向上逐级查找：在 {@code mod/gtnh} 下直接命中，在仓库根目录
 * IDE 运行则命中 {@code mod/gtnh/<file>}。
 * </p>
 */
public class Ic2RuntimePinTest {

    private static final String NEW_CF = "curse.maven:ic2-242638:6833054";
    private static final String OLD_CF = "curse.maven:ic2-242638:2353971";

    @Test
    public void realBuildConfigPinsCf828() throws Exception {
        String deps = stripGroovyComments(readBuildFile("dependencies.gradle"));
        String props = stripPropertiesComments(readBuildFile("gradle.properties"));
        List<String> problems = check(deps, props);
        assertTrue("IC2 828 pin 配置不完整: " + problems, problems.isEmpty());
    }

    @Test
    public void deletingSubstitutionBlockIsRejected() throws Exception {
        String deps = stripGroovyComments(readBuildFile("dependencies.gradle"));
        String props = stripPropertiesComments(readBuildFile("gradle.properties"));
        String mutated = removeBlock(deps, "dependencySubstitution");
        assertFalse("测试前置：必须能定位 dependencySubstitution 块", mutated.equals(deps));
        assertFalse("删掉 dependencySubstitution 后检查器必须报错", check(mutated, props).isEmpty());

        Path temp = writeTemp("dependencies.gradle", mutated);
        try {
            assertFalse("从临时副本读回后删块仍必须报错", check(stripGroovyComments(read(temp)), props).isEmpty());
        } finally {
            deleteRecursively(temp.getParent());
        }
    }

    @Test
    public void commentingFlagIsRejected() throws Exception {
        String deps = stripGroovyComments(readBuildFile("dependencies.gradle"));
        String props = stripPropertiesComments(readBuildFile("gradle.properties"));
        String mutated = props.replace("useIC2FromCurseforge = false", "# useIC2FromCurseforge = false");
        assertFalse("测试前置：必须能定位 flag", mutated.equals(props));
        assertFalse("注释掉 flag 后检查器必须报错", check(deps, mutated).isEmpty());

        Path temp = writeTemp("gradle.properties", mutated);
        try {
            assertFalse("从临时副本读回后注释 flag 仍必须报错", check(deps, stripPropertiesComments(read(temp))).isEmpty());
        } finally {
            deleteRecursively(temp.getParent());
        }
    }

    @Test
    public void commentingDeobfuscateIsRejected() throws Exception {
        String deps = stripGroovyComments(readBuildFile("dependencies.gradle"));
        String props = stripPropertiesComments(readBuildFile("gradle.properties"));
        String line = "modUtils.deobfuscate(\"" + NEW_CF + "\")";
        String commented = deps.replace(line, "// " + line);
        assertFalse("测试前置：必须能定位 deobfuscate 行", commented.equals(deps));
        String mutated = stripGroovyComments(commented);
        assertFalse("注释掉 deobfuscate 后检查器必须报错", check(mutated, props).isEmpty());
    }

    @Test
    public void revertingOldCurseForgeTargetIsRejected() throws Exception {
        String deps = stripGroovyComments(readBuildFile("dependencies.gradle"));
        String props = stripPropertiesComments(readBuildFile("gradle.properties"));
        String mutated = deps.replace("using module('" + NEW_CF + "')", "using module('" + OLD_CF + "')");
        assertFalse("测试前置：必须能定位 CurseForge 目标", mutated.equals(deps));
        assertFalse("替换目标回退到 2353971 后检查器必须报错", check(mutated, props).isEmpty());
    }

    @Test
    public void unversionedNetIndustrialCraftRuleIsRejected() throws Exception {
        String deps = stripGroovyComments(readBuildFile("dependencies.gradle"));
        String props = stripPropertiesComments(readBuildFile("gradle.properties"));
        String mutated = deps.replace(
            "substitute module('net.industrial-craft:industrialcraft-2:2.2.828-experimental')",
            "substitute module('net.industrial-craft:industrialcraft-2')");
        assertFalse("测试前置：必须能定位 net.industrial-craft 规则", mutated.equals(deps));
        assertFalse("去掉 2.2.828-experimental 版本后检查器必须报错", check(mutated, props).isEmpty());
    }

    private static List<String> check(String deps, String props) {
        List<String> problems = new ArrayList<String>();
        if (!hasFlagFalse(props)) {
            problems.add("gradle.properties 缺少未注释的 useIC2FromCurseforge = false");
        }
        requireContains(
            deps,
            "substitute module('net.industrial-craft:industrialcraft-2:2.2.828-experimental')",
            "net.industrial-craft 替换必须精确到 2.2.828-experimental",
            problems);
        requireContains(
            deps,
            "substitute module('" + OLD_CF + "') using module('" + NEW_CF + "')",
            "旧 CurseForge 2353971 必须替换到 6833054",
            problems);
        requireContains(deps, "using module('" + NEW_CF + "')", "必须指向 CurseForge 6833054", problems);
        if (count(deps, "withoutClassifier()") < 2) {
            problems.add("两条替换规则都必须带 withoutClassifier()（否则会请求不存在的 *-dev.jar）");
        }
        requireContains(deps, "modUtils.deobfuscate(\"" + NEW_CF + "\")", "必须注册 RFG 去混淆", problems);
        if (deps.contains("using module('" + OLD_CF + "')")) {
            problems.add("替换目标不得回退到旧 CurseForge 2353971");
        }
        if (deps.contains("substitute module('net.industrial-craft:industrialcraft-2')")) {
            problems.add("net.industrial-craft 替换不得省略 2.2.828-experimental 版本");
        }
        return problems;
    }

    private static boolean hasFlagFalse(String props) {
        for (String line : props.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (trimmed.equals("useIC2FromCurseforge = false") || trimmed.equals("useIC2FromCurseforge=false")) {
                return true;
            }
        }
        return false;
    }

    private static void requireContains(String text, String needle, String message, List<String> problems) {
        if (!text.contains(needle)) {
            problems.add(message + "（缺少: " + needle + "）");
        }
    }

    private static int count(String text, String needle) {
        int count = 0;
        int index = 0;
        while ((index = text.indexOf(needle, index)) >= 0) {
            count++;
            index += needle.length();
        }
        return count;
    }

    private static String stripGroovyComments(String text) {
        StringBuilder out = new StringBuilder(text.length());
        boolean inSingle = false;
        boolean inDouble = false;
        boolean inBlock = false;
        boolean inLine = false;
        boolean escape = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            char next = i + 1 < text.length() ? text.charAt(i + 1) : '\0';
            if (inBlock) {
                if (c == '*' && next == '/') {
                    inBlock = false;
                    i++;
                } else if (c == '\n') {
                    out.append('\n');
                }
                continue;
            }
            if (inLine) {
                if (c == '\n') {
                    inLine = false;
                    out.append('\n');
                }
                continue;
            }
            if (inSingle || inDouble) {
                out.append(c);
                if (escape) {
                    escape = false;
                } else if (c == '\\') {
                    escape = true;
                } else if (inSingle && c == '\'') {
                    inSingle = false;
                } else if (inDouble && c == '"') {
                    inDouble = false;
                }
                continue;
            }
            if (c == '\'') {
                inSingle = true;
                out.append(c);
                continue;
            }
            if (c == '"') {
                inDouble = true;
                out.append(c);
                continue;
            }
            if (c == '/' && next == '/') {
                inLine = true;
                i++;
                continue;
            }
            if (c == '/' && next == '*') {
                inBlock = true;
                i++;
                continue;
            }
            out.append(c);
        }
        return out.toString();
    }

    private static String stripPropertiesComments(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (String line : text.split("\\r?\\n", -1)) {
            String trimmed = line.trim();
            if (trimmed.startsWith("#") || trimmed.startsWith("!")) {
                out.append('\n');
            } else {
                out.append(line)
                    .append('\n');
            }
        }
        return out.toString();
    }

    private static String removeBlock(String text, String keyword) {
        int start = text.indexOf(keyword);
        if (start < 0) {
            return text;
        }
        int open = text.indexOf('{', start);
        if (open < 0) {
            return text;
        }
        int depth = 0;
        for (int i = open; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return text.substring(0, start) + text.substring(i + 1);
                }
            }
        }
        return text;
    }

    private static String readBuildFile(String name) throws IOException {
        return read(findBuildFile(name));
    }

    private static Path findBuildFile(String name) {
        File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (dir != null) {
            File direct = new File(dir, name);
            if (direct.isFile()) {
                return direct.toPath();
            }
            File nested = new File(dir, "mod/gtnh/" + name);
            if (nested.isFile()) {
                return nested.toPath();
            }
            dir = dir.getParentFile();
        }
        throw new AssertionError("找不到 " + name + "（从 " + System.getProperty("user.dir") + " 向上）");
    }

    private static String read(Path path) throws IOException {
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    private static Path writeTemp(String name, String content) throws IOException {
        Path dir = Files.createTempDirectory("ic2-pin-mutation-");
        Path file = dir.resolve(name);
        Files.write(file, content.getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private static void deleteRecursively(Path dir) {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException ignored) {
                        // 临时目录清理失败不影响断言。
                    }
                });
        } catch (IOException ignored) {
            // 临时目录清理失败不影响断言。
        }
    }
}
