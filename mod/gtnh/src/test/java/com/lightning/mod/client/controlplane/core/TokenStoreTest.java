package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonObject;

/**
 * {@link TokenStore} 单测：三级 token 的生成、判定（高阶含低阶）、持久化与「空 token 不放行」。
 */
public class TokenStoreTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedTokensAreDistinct64HexChars() {
        TokenStore s = TokenStore.generate();
        String o = s.tokenFor(Tier.OBSERVE);
        String sc = s.tokenFor(Tier.SCENE);
        String f = s.tokenFor(Tier.FORENSIC);
        for (String t : new String[] { o, sc, f }) {
            assertEquals(64, t.length());
            assertTrue("须为十六进制: " + t, t.matches("[0-9a-f]{64}"));
        }
        assertNotEquals(o, sc);
        assertNotEquals(sc, f);
        assertNotEquals(o, f);
        assertFalse(s.isEmpty());
    }

    @Test
    public void tierOfReturnsExactTierForEachToken() {
        TokenStore s = TokenStore.generate();
        assertEquals(Tier.OBSERVE, s.tierOf(s.tokenFor(Tier.OBSERVE)));
        assertEquals(Tier.SCENE, s.tierOf(s.tokenFor(Tier.SCENE)));
        assertEquals(Tier.FORENSIC, s.tierOf(s.tokenFor(Tier.FORENSIC)));
    }

    @Test
    public void tierOfRejectsUnknownEmptyAndModifiedTokens() {
        TokenStore s = TokenStore.generate();
        assertNull(s.tierOf(null));
        assertNull(s.tierOf(""));
        assertNull(s.tierOf("   "));
        assertNull(s.tierOf("deadbeef"));
        assertNull(s.tierOf(s.tokenFor(Tier.OBSERVE) + "0"));
        assertNull(s.tierOf("0" + s.tokenFor(Tier.OBSERVE)));
    }

    @Test
    public void emptyConfiguredStoreNeverAuthenticates() {
        TokenStore s = new TokenStore("", "", "");
        assertTrue(s.isEmpty());
        assertNull(s.tierOf(""));
        assertNull(s.tierOf("anything"));
        assertNull(new TokenStore(null, null, null).tierOf(""));
    }

    @Test
    public void higherTierCoversLowerTier() {
        assertTrue(Tier.FORENSIC.covers(Tier.FORENSIC));
        assertTrue(Tier.FORENSIC.covers(Tier.SCENE));
        assertTrue(Tier.FORENSIC.covers(Tier.OBSERVE));
        assertTrue(Tier.SCENE.covers(Tier.OBSERVE));
        assertFalse(Tier.SCENE.covers(Tier.FORENSIC));
        assertFalse(Tier.OBSERVE.covers(Tier.SCENE));
        assertFalse(Tier.OBSERVE.covers(null));
        assertTrue(Tier.SCENE.isWritable());
        assertFalse(Tier.OBSERVE.isWritable());
    }

    @Test
    public void saveAndLoadRoundTrip() throws IOException {
        TokenStore s = TokenStore.generate();
        Path file = tmp.getRoot()
            .toPath()
            .resolve("controlplane/tokens.json");
        s.save(file, "2026-10-06T12:00:00+08:00");
        assertTrue(Files.isRegularFile(file));

        String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        assertTrue(text.contains(Contract.SCHEMA_TOKENS));
        assertTrue(text.contains("\"tokens\""));

        TokenStore back = TokenStore.load(file);
        assertEquals(Tier.OBSERVE, back.tierOf(s.tokenFor(Tier.OBSERVE)));
        assertEquals(Tier.SCENE, back.tierOf(s.tokenFor(Tier.SCENE)));
        assertEquals(Tier.FORENSIC, back.tierOf(s.tokenFor(Tier.FORENSIC)));
    }

    @Test
    public void loadAcceptsFlatForm() throws IOException {
        Path file = tmp.getRoot()
            .toPath()
            .resolve("flat.json");
        JsonObject flat = new JsonObject();
        flat.addProperty("observe", "aaaa");
        flat.addProperty("scene", "bbbb");
        flat.addProperty("forensic", "cccc");
        Files.write(
            file,
            Json.toJson(flat)
                .getBytes(StandardCharsets.UTF_8));
        TokenStore s = TokenStore.load(file);
        assertEquals(Tier.SCENE, s.tierOf("bbbb"));
        assertEquals(Tier.FORENSIC, s.tierOf("cccc"));
    }

    @Test
    public void loadRejectsBrokenJson() throws IOException {
        Path file = tmp.getRoot()
            .toPath()
            .resolve("broken.json");
        Files.write(file, "{not json".getBytes(StandardCharsets.UTF_8));
        try {
            TokenStore.load(file);
            fail("应当抛 IOException");
        } catch (IOException expected) {
            assertTrue(
                expected.getMessage(),
                expected.getMessage()
                    .contains("tokens.json"));
        }
    }

    @Test
    public void pathHelperBuildsDataDirRelativeFile() {
        Path p = TokenStore.defaultFile(java.nio.file.Paths.get("cp-data"));
        assertEquals(
            "tokens.json",
            p.getFileName()
                .toString());
        assertTrue(
            p.toString()
                .replace('\\', '/')
                .endsWith("cp-data/tokens.json"));
    }
}
