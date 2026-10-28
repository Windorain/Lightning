package com.lightning.mod.client.export;

import net.minecraft.nbt.NBTBase;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

public final class NbtJsonSerializer {

    private static final Gson GSON = new GsonBuilder()
        .registerTypeHierarchyAdapter(NBTBase.class, new NbtTagSerializer())
        .create();

    public static String toJson(NBTBase nbt) {
        return GSON.toJson(nbt);
    }
}
