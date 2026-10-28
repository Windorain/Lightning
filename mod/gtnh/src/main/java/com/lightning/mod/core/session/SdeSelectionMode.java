package com.lightning.mod.core.session;

/**
 * 与 WorldEdit {@code //sel} 对应的选区语义：{@link #CUBOID} 为两角点长方体，{@link #EXTEND} 为在已有选区上逐步扩张（包含新点）。
 */
public enum SdeSelectionMode {

    CUBOID,
    EXTEND
}
