package com.lightning.mod.client.export;

import java.lang.reflect.Field;
import java.util.List;

import net.minecraft.nbt.*;

import com.google.gson.*;

public class NbtTagSerializer implements JsonSerializer<NBTBase> {

    @Override
    public JsonElement serialize(NBTBase src, java.lang.reflect.Type typeOfSrc, JsonSerializationContext context) {
        if (src == null) return JsonNull.INSTANCE;

        switch (src.getId()) {
            case 0:
                return JsonNull.INSTANCE; // TAG_End
            case 1:
                return new JsonPrimitive(((NBTTagByte) src).func_150290_f()); // TAG_Byte
            case 2:
                return new JsonPrimitive(((NBTTagShort) src).func_150289_e()); // TAG_Short
            case 3:
                return new JsonPrimitive(((NBTTagInt) src).func_150287_d()); // TAG_Int
            case 4:
                return new JsonPrimitive(((NBTTagLong) src).func_150291_c()); // TAG_Long
            case 5:
                return new JsonPrimitive(((NBTTagFloat) src).func_150288_h()); // TAG_Float
            case 6:
                return new JsonPrimitive(((NBTTagDouble) src).func_150286_g()); // TAG_Double
            case 7: { // TAG_Byte_Array
                JsonArray arr = new JsonArray();
                for (byte b : ((NBTTagByteArray) src).func_150292_c()) arr.add(new JsonPrimitive(b));
                return arr;
            }
            case 8:
                return new JsonPrimitive(((NBTTagString) src).func_150285_a_()); // TAG_String
            case 9: { // TAG_List
                JsonArray arr = new JsonArray();
                NBTTagList list = (NBTTagList) src;
                for (int i = 0; i < list.tagCount(); i++) {
                    try {
                        Field f = NBTTagList.class.getDeclaredField("tagList");
                        f.setAccessible(true);
                        List<NBTBase> tags = (List<NBTBase>) f.get(list);
                        arr.add(context.serialize(tags.get(i)));
                    } catch (Exception e) {
                        arr.add(context.serialize(list.getCompoundTagAt(i)));
                    }
                }
                return arr;
            }
            case 10: { // TAG_Compound
                JsonObject obj = new JsonObject();
                NBTTagCompound cmp = (NBTTagCompound) src;
                for (Object keyObj : cmp.func_150296_c()) {
                    String key = (String) keyObj;
                    obj.add(key, context.serialize(cmp.getTag(key)));
                }
                return obj;
            }
            case 11: { // TAG_Int_Array
                JsonArray arr = new JsonArray();
                for (int i : ((NBTTagIntArray) src).func_150302_c()) arr.add(new JsonPrimitive(i));
                return arr;
            }
            default:
                return JsonNull.INSTANCE;
        }
    }
}
