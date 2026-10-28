package com.lightning.mod.client.meshcapture.zeroproduce;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * {@link DeclaredEmptyPolicy} 的核心判据：<strong>"没有 attachment"才是合法空</strong>。
 * <p>
 * 这条判据写反的后果不是"多画一个方块"，而是把一次真实的丢失洗成"这一格本来就该是空的"——
 * 后者没有任何读数能发现。因此状态判据（而不是类名）单独钉住。
 */
public class DeclaredEmptyPolicyTest {

    @Test
    public void absentAttachmentContainerCountsAsEmpty() {
        assertTrue(DeclaredEmptyPolicy.allEntriesNullOrAbsent(null));
    }

    @Test
    public void arrayOfNullsCountsAsEmpty() {
        assertTrue(DeclaredEmptyPolicy.allEntriesNullOrAbsent(new Object[] { null, null, null, null, null, null }));
        assertTrue(DeclaredEmptyPolicy.allEntriesNullOrAbsent(new Object[0]));
    }

    @Test
    public void anyAttachmentMeansNotEmpty() {
        assertFalse(DeclaredEmptyPolicy.allEntriesNullOrAbsent(new Object[] { null, "attachment", null }));
        assertFalse(DeclaredEmptyPolicy.allEntriesNullOrAbsent(new Object[] { "a", "b", "c", "d", "e", "f" }));
    }

    @Test
    public void unknownContainerShapeIsNeverTreatedAsEmpty() {
        // 形状不认识时保守返回 false：交给兜底落占位，而不是宣布"这一格本来就空"
        assertFalse(DeclaredEmptyPolicy.allEntriesNullOrAbsent("not-an-array"));
        assertFalse(DeclaredEmptyPolicy.allEntriesNullOrAbsent(Integer.valueOf(0)));
    }
}
