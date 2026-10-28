package com.lightning.mod.client.meshcapture.env.probes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;
import com.lightning.mod.client.meshcapture.env.TogglePresence;

/**
 * {@link AngelicaChestCacheToggleProbe} 的注册契约与降级读数。
 * <p>
 * 测试 classpath 上没有批处理渲染层，因此探针只能得出 {@link TogglePresence#ABSENT}——这正是"不在场"的
 * 可解释读数（而不是抛错或猜 PRESENT）。
 */
public class AngelicaChestCacheToggleProbeTest {

    @Test
    public void priorityAndAppliesContract() {
        AngelicaChestCacheToggleProbe probe = new AngelicaChestCacheToggleProbe();
        assertEquals(650, probe.priority());
        assertFalse("空上下文不跑", probe.applies(null));
        assertTrue(probe.applies(CaptureProbeContext.forTesting(1L)));
    }

    @Test
    public void absentTargetClassYieldsAbsentWithANote() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        new AngelicaChestCacheToggleProbe().probe(CaptureProbeContext.forTesting(1L), facts);
        assertEquals(TogglePresence.ABSENT, facts.chestCacheToggle());
        boolean noted = false;
        for (String note : facts.notes()) {
            if (note.startsWith("angelica_chest_cache_toggle:")) {
                noted = true;
            }
        }
        assertTrue("降级必须留下可解释的读数", noted);
    }
}
