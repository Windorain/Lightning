package com.lightning.mod.client.controlplane.core;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 作业登记：分配作业号、保存最近作业、供 {@code GET /cp/v1/jobs/{id}} 查询。
 *
 * <p>
 * 只保留最近 {@code capacity} 条（默认 256），运行期不落盘——产物与事件流水才是审计载体。
 * 作业号 {@code seq} 进程内单调递增，{@code jobId} 形如 {@code j7}。
 */
public final class JobRegistry {

    /** 默认保留条数。 */
    public static final int DEFAULT_CAPACITY = 256;

    private final int capacity;
    private final Map<String, Job> jobs = new LinkedHashMap<String, Job>();
    private final Deque<String> order = new ArrayDeque<String>();
    private long lastSeq;

    /** 默认容量。 */
    public JobRegistry() {
        this(DEFAULT_CAPACITY);
    }

    /** 指定容量。 */
    public JobRegistry(int capacity) {
        this.capacity = capacity <= 0 ? DEFAULT_CAPACITY : capacity;
    }

    /**
     * 创建并登记一个新作业（状态 queued）。
     *
     * @param action 动作名
     * @param params 入参
     */
    public synchronized Job create(String action, JsonObject params, String submittedAt) {
        return create(action, params, submittedAt, Tier.OBSERVE);
    }

    /**
     * 创建并登记一个新作业（状态 queued），并记录提交方的权限级。
     *
     * <p>
     * 权限级随作业带到 tick 线程：{@code case.run} 需要按用例内容做运行期升格检查
     * （含 cameras 段的用例必须 forensic 调用），而鉴权只发生在 HTTP 线程。
     *
     * @param action      动作名
     * @param params      入参
     * @param submittedAt 入队时刻
     * @param tier        提交方权限级，null 视为 {@link Tier#OBSERVE}
     */
    public synchronized Job create(String action, JsonObject params, String submittedAt, Tier tier) {
        long seq = ++lastSeq;
        Job job = new Job(seq, "j" + seq, action, params, submittedAt, tier);
        jobs.put(job.jobId(), job);
        order.addLast(job.jobId());
        while (order.size() > capacity) {
            String evicted = order.removeFirst();
            jobs.remove(evicted);
        }
        return job;
    }

    /** 按 jobId 取作业；不存在返回 null。 */
    public synchronized Job get(String jobId) {
        return jobId == null ? null : jobs.get(jobId);
    }

    /** 最近 n 条作业（新的在前）；n &le; 0 表示全部。 */
    public synchronized JsonArray recent(int n) {
        JsonArray arr = new JsonArray();
        java.util.List<String> ids = new java.util.ArrayList<String>(order);
        for (int i = ids.size() - 1; i >= 0; i--) {
            if (n > 0 && arr.size() >= n) {
                break;
            }
            Job j = jobs.get(ids.get(i));
            if (j != null) {
                arr.add(j.toJson());
            }
        }
        return arr;
    }

    /** 当前最大作业号。 */
    public synchronized long lastSeq() {
        return lastSeq;
    }

    /** 已登记作业数。 */
    public synchronized int size() {
        return jobs.size();
    }

    /** 各状态计数（{@code /cp/v1/about} 用）。 */
    public synchronized JsonObject stateCounts() {
        JsonObject o = new JsonObject();
        for (Job.State s : Job.State.values()) {
            o.addProperty(s.id(), 0);
        }
        for (Job j : jobs.values()) {
            String id = j.state()
                .id();
            o.addProperty(
                id,
                o.get(id)
                    .getAsInt() + 1);
        }
        return o;
    }
}
