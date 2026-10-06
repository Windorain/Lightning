package com.lightning.mod.client.controlplane.core;

import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * 时间源。core 层所有时间戳都经此取得，便于单测注入固定时钟
 * （run 目录名、事件 ts、观测记录 createdAt 都依赖它）。
 */
public interface TimeSource {

    /** ISO-8601 带时区偏移，例：{@code 2026-10-06T12:00:00+08:00}。 */
    String isoNow();

    /** 紧凑形式，用于 run 目录名：{@code yyyyMMdd-HHmmss}。 */
    String compactNow();

    /** 当前毫秒时刻（uptime 计算用）。 */
    long millis();

    /** 系统时钟（本地时区）。 */
    static TimeSource system() {
        return new TimeSource() {

            private final DateTimeFormatter compact = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

            @Override
            public String isoNow() {
                return OffsetDateTime.now()
                    .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
            }

            @Override
            public String compactNow() {
                return OffsetDateTime.now()
                    .format(compact);
            }

            @Override
            public long millis() {
                return System.currentTimeMillis();
            }
        };
    }

    /** 固定时钟，供单测使用。 */
    static TimeSource fixed(final String iso, final String compact, final long millis) {
        return new TimeSource() {

            @Override
            public String isoNow() {
                return iso;
            }

            @Override
            public String compactNow() {
                return compact;
            }

            @Override
            public long millis() {
                return millis;
            }
        };
    }

    /** 递增时钟：每次取时间都前进一步，供需要唯一时间戳的单测使用。 */
    static TimeSource ticking(final long startMillis, final long stepMillis) {
        return new TimeSource() {

            private long now = startMillis;

            private synchronized long next() {
                long v = now;
                now += stepMillis;
                return v;
            }

            @Override
            public String isoNow() {
                return OffsetDateTime.ofInstant(java.time.Instant.ofEpochMilli(next()), ZoneId.systemDefault())
                    .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
            }

            @Override
            public String compactNow() {
                return OffsetDateTime.ofInstant(java.time.Instant.ofEpochMilli(next()), ZoneId.systemDefault())
                    .format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
            }

            @Override
            public long millis() {
                return next();
            }
        };
    }
}
