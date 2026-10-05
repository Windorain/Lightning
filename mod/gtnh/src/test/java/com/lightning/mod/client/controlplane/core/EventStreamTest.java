package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@link EventStream} 单测：seq 单调递增、环形缓冲淘汰、落盘 writer、{@code since} 查询与 kind 统计。
 */
public class EventStreamTest {

    /** 内存落盘口，断言「每条事件一行 JSON」。 */
    private static final class MemoryWriter implements EventStream.LineWriter {

        final List<String> lines = new ArrayList<String>();

        @Override
        public void writeLine(String json) {
            lines.add(json);
        }
    }

    @Test
    public void seqIsMonotonicAndSinceFiltersStrictlyGreater() {
        MemoryWriter w = new MemoryWriter();
        EventStream s = new EventStream(16, w, null);
        s.append(EventStream.LEVEL_INFO, EventStream.Kinds.SERVER_START, "启动");
        s.append(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_SUBMIT, "入队");
        s.append(EventStream.LEVEL_WARN, EventStream.Kinds.ACTION_REJECT, "拒绝");

        assertEquals(3L, s.lastSeq());
        assertEquals(3, s.size());

        JsonArray all = s.since(0, 0);
        assertEquals(3, all.size());
        assertEquals(
            1L,
            all.get(0)
                .getAsJsonObject()
                .get("seq")
                .getAsLong());
        assertEquals(
            3L,
            all.get(2)
                .getAsJsonObject()
                .get("seq")
                .getAsLong());

        JsonArray tail = s.since(1, 0);
        assertEquals(2, tail.size());
        assertEquals(
            2L,
            tail.get(0)
                .getAsJsonObject()
                .get("seq")
                .getAsLong());

        JsonArray limited = s.since(0, 2);
        assertEquals(2, limited.size());

        assertEquals(
            0,
            s.since(3, 0)
                .size());
    }

    @Test
    public void ringBufferEvictsOldestButKeepsSeqGrowing() {
        MemoryWriter w = new MemoryWriter();
        EventStream s = new EventStream(3, w, null);
        for (int i = 1; i <= 5; i++) {
            s.append(EventStream.LEVEL_INFO, "k" + i, "m" + i);
        }
        assertEquals(5L, s.lastSeq());
        assertEquals(3, s.size());
        JsonArray arr = s.since(0, 0);
        assertEquals(3, arr.size());
        assertEquals(
            3L,
            arr.get(0)
                .getAsJsonObject()
                .get("seq")
                .getAsLong());
        assertEquals(
            5L,
            arr.get(2)
                .getAsJsonObject()
                .get("seq")
                .getAsLong());
        // 落盘不受环形缓冲影响：全量 5 行
        assertEquals(5, w.lines.size());
    }

    @Test
    public void writerReceivesOneCompactJsonLinePerEvent() {
        MemoryWriter w = new MemoryWriter();
        EventStream s = new EventStream(8, w, null);
        JsonObject data = new JsonObject();
        data.addProperty("progress", 0.5d);
        s.append(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_PROGRESS, "case.run", "j1", "进度", data);

        assertEquals(1, w.lines.size());
        String line = w.lines.get(0);
        assertFalse("落盘行不能含换行", line.contains("\n"));
        JsonObject parsed = Json.parseStrictObject(line);
        assertEquals(
            "case.run",
            parsed.get("action")
                .getAsString());
        assertEquals(
            "j1",
            parsed.get("jobId")
                .getAsString());
        assertTrue(
            parsed.get("data")
                .getAsJsonObject()
                .has("progress"));
    }

    @Test
    public void writerFailureDoesNotBreakAppend() {
        EventStream s = new EventStream(4, new EventStream.LineWriter() {

            @Override
            public void writeLine(String json) {
                throw new RuntimeException("disk full");
            }
        }, null);
        s.append(EventStream.LEVEL_INFO, "k", "m");
        assertEquals(1L, s.lastSeq());
    }

    @Test
    public void countKindAndLastOfKind() {
        EventStream s = new EventStream(16, null, null);
        s.append(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_DONE, "a");
        s.append(EventStream.LEVEL_ERROR, EventStream.Kinds.ACTION_FAIL, "b");
        s.append(EventStream.LEVEL_INFO, EventStream.Kinds.ACTION_DONE, "c");

        assertEquals(2, s.countKind(EventStream.Kinds.ACTION_DONE));
        assertEquals(1, s.countKind(EventStream.Kinds.ACTION_FAIL));
        assertEquals(0, s.countKind("nope"));
        assertEquals(0, s.countKind(null));
        assertEquals(
            "c",
            s.lastOfKind(EventStream.Kinds.ACTION_DONE)
                .message());
        assertNull(s.lastOfKind("nope"));
    }

    @Test
    public void nullableOptionalFieldsAreOmittedFromJson() {
        EventStream s = new EventStream(4, null, null);
        EventStream.Event e = s.append(EventStream.LEVEL_INFO, "k", "only message");
        JsonObject o = e.toJson();
        assertFalse(o.has("action"));
        assertFalse(o.has("jobId"));
        assertFalse(o.has("data"));
        assertEquals(
            "only message",
            o.get("message")
                .getAsString());
        assertEquals(
            EventStream.DEFAULT_CAPACITY,
            new EventStream(null, (java.util.function.Consumer<String>) null).capacity());
    }
}
