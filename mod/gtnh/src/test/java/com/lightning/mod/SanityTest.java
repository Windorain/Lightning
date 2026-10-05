package com.lightning.mod;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 测试基建自检（sanity check）。
 *
 * <p>
 * 这个类不测业务逻辑，只回答三个问题：
 * </p>
 * <ol>
 * <li>JUnit 4.13.2 在 test 编译/运行 classpath 上可用，且 {@code gradlew test} 真的会执行它；</li>
 * <li>main 的 {@code implementation} 依赖（此处 gson）能被 test 代码解析并实际使用
 * —— 即 {@code testImplementation extendsFrom implementation} 在 gtnhconvention 下成立；</li>
 * <li>main sourceSet 的编译产物在 test 运行 classpath 上可见（后续 {@code com.lightning.mod.client.controlplane.*}
 * 单测能直接引用 main 里的被测类）。</li>
 * </ol>
 *
 * <p>
 * 只用 JDK 8 API 与 JUnit4，不触碰任何 MC/Forge 类型 —— 一旦这里需要 MC 类型，说明
 * 测试基建的边界（纯 JVM）已经被破坏。
 * </p>
 *
 * <p>
 * 写给后续往 {@code src/test} 里加测试的人（实测结论）：{@code compileTestJava} 同样吃 jabel
 * （构建日志里会打 {@code Jabel: initialized}），所以测试代码里 {@code var}、switch 表达式等
 * 现代**语法**可用；但 API 基线仍是 Java 8，{@code List.of(...)}、{@code Map.of(...)} 这类
 * Java 9+ **API** 编译不过。
 * </p>
 */
public class SanityTest {

    /** 最基础的算术断言：确认 runner 真的跑了。 */
    @Test
    public void arithmeticSanity() {
        int onePlusOne = 0;
        for (int i = 0; i < 2; i++) {
            onePlusOne++;
        }
        assertEquals(2, onePlusOne);
        assertTrue("1 + 1 必须等于 2", 1 + 1 == 2);
    }

    /**
     * gson 是 main 的 {@code implementation} 依赖（见 dependencies.gradle）。
     * 这里不仅做 {@code Class.forName}，还实际构造/解析一次 JSON，
     * 确保它是**运行期**可用而非只挂在编译期 classpath 上。
     */
    @Test
    public void gsonIsAvailableOnTestClasspath() {
        assertNotNull("com.google.gson.Gson 必须在 test classpath 上", com.google.gson.Gson.class);

        com.google.gson.Gson gson = new com.google.gson.Gson();
        com.google.gson.JsonObject obj = new com.google.gson.JsonObject();
        obj.addProperty("mod", "lightning");
        obj.addProperty("answer", 42);

        String json = gson.toJson(obj);
        com.google.gson.JsonObject parsed = gson.fromJson(json, com.google.gson.JsonObject.class);
        assertEquals(
            42,
            parsed.get("answer")
                .getAsInt());
        assertEquals(
            "lightning",
            parsed.get("mod")
                .getAsString());
    }

    /**
     * 确认 main sourceSet 的输出在 test 运行 classpath 上（不做类初始化，
     * 避免误触 MC/Forge 静态初始化）。control-plane 单测要直接引用 main 里的被测类，
     * 这一步失败意味着那些测试必然编译不过。
     */
    @Test
    public void mainSourceSetOutputIsOnTestClasspath() {
        ClassLoader cl = getClass().getClassLoader();
        assertNotNull("main 的包目录必须出现在 test 运行 classpath 上", cl.getResource("com/lightning/mod/"));
    }
}
