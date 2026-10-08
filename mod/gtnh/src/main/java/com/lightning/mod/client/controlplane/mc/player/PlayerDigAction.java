package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.dig}（scene，步进）：<b>左键破坏方块</b>——攻击与挖掘同一条玩家路径。
 *
 * <h2>三个目标分支（原版鼠标左键的三条路，各自走原版自己的方法）</h2>
 * <ol>
 * <li>{@code target:"entity"} / 视线命中实体：{@code PlayerControllerMP.attackEntity(player, entity)}
 * ——发 {@code C02PacketUseEntity(ATTACK)} 并在客户端本地跑
 * {@code EntityPlayer.attackTargetEntityWithCurrentItem}；服务端在
 * {@code NetHandlerPlayServer.processUseEntity} 的 ATTACK 分支里跑权威攻击
 * （伤害、击退、死亡、掉落）。</li>
 * <li>{@code target:"block"} / 视线命中方块：{@code PlayerControllerMP.clickBlock(x,y,z,side)}
 * ——发 {@code C07PacketPlayerDigging(0, …)}（START_DESTROY_BLOCK），并在客户端本地跑
 * {@code onPlayerDestroyBlock}。服务端在 {@code processPlayerDigging} 的 {@code 0} 分支里
 * {@code ItemInWorldManager.onBlockClicked}：<b>创造模式当场破坏</b>，
 * 生存模式开始累计挖掘进度。</li>
 * <li>一次破坏未完成时（生存模式挖硬方块）：本动作在 {@code holdTicks} 内持续调
 * {@code PlayerControllerMP.onPlayerDamageBlock(x,y,z,side)}——这是原版
 * {@code Minecraft.func_147115_a} 按住左键时每 tick 调的同一个方法，累计够了它会自己发
 * {@code C07PacketPlayerDigging(2, …)}（FINISH_DESTROY_BLOCK）并跑 {@code onPlayerDestroyBlock}。</li>
 * </ol>
 *
 * <h2>为什么「挖不动基岩」是正确行为而不是失败</h2>
 * 基岩的 {@code getPlayerRelativeBlockHardness} 返回 -1（不可破坏），服务端
 * {@code ItemInWorldManager.onBlockClicked} 因此永远不满足 {@code f >= 1.0F}。
 * 本动作在这种情况下<b>不发假成功</b>：返回 {@code observed:false} + {@code blockUnbreakable:true}
 * + 未变化的逐格回读。这正是「探索模式纪律」要的东西——失败显式、进程不死、可继续试错
 * （#96 §3、§8.5）。
 */
public final class PlayerDigAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.dig";

    /** 默认按住 tick 数（一次左键点击 = 1；挖掘需要按住）。 */
    public static final int DEFAULT_HOLD_TICKS = 1;

    /** 按住上限（超过必然等价于卡死，显式拒绝而不是慢慢耗）。 */
    public static final int MAX_HOLD_TICKS = 1200;

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        net.minecraft.client.multiplayer.PlayerControllerMP controller = PlayerSession.requireController(NAME);
        NetHandlerPlayClient handler = PlayerSession.requireNetHandler(client, NAME);
        EntityPlayerMP server = PlayerSession.serverPlayer();
        WorldServer world = PlayerSession.serverWorld();
        if (server == null || world == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：服务端玩家或服务端世界不可用（未进入世界或玩家尚未加入集成服）",
                Json.object(
                    "action",
                    NAME,
                    "worldAvailable",
                    Boolean.valueOf(world != null),
                    "playerAvailable",
                    Boolean.valueOf(server != null),
                    "hint",
                    "先进世界：world.rebuild 或 case.run 的 world 段"));
        }

        String target = ctx.optString("target", "auto");
        if (target != null) {
            target = target.trim()
                .toLowerCase(java.util.Locale.ROOT);
        }
        double reach = ctx.has("reach") ? PlayerSession.optNumberPublic(ctx, "reach")
            .doubleValue() : PlayerSession.SERVER_REACH;
        if (reach <= 0.0D || reach > 64.0D) {
            throw CpException.param("reach 非法", "reach", "须在 (0,64]，收到 " + reach);
        }
        int holdTicks = ctx.optInt("holdTicks", DEFAULT_HOLD_TICKS);
        if (holdTicks < 1 || holdTicks > MAX_HOLD_TICKS) {
            throw CpException.param("holdTicks 非法", "holdTicks", "须在 1.." + MAX_HOLD_TICKS + "，收到 " + holdTicks);
        }
        int[] at = optBlockPos(ctx, "at");
        // 未给 at 时用真实视线（与玩家按左键时的 objectMouseOver 同一口径）
        PlayerSession.Sight sight = at == null ? PlayerSession.sight(server, reach, true) : null;
        if (at != null) {
            int[] blockAt = blockUnder(world, at);
            if (blockAt == null) {
                throw new CpException(
                    ErrorCodes.STATE,
                    NAME + "：at 位置没有方块可挖（是空气）",
                    Json.object("action", NAME, "at", PlayerSession.posArray(at[0], at[1], at[2])));
            }
            at = blockAt;
        }

        String resolved;
        if ("entity".equals(target)) {
            resolved = "entity";
        } else if ("block".equals(target)) {
            resolved = "block";
        } else if ("auto".equals(target) || target == null) {
            if (at != null) {
                resolved = "block";
            } else if (sight != null && sight.entityHit()) {
                resolved = "entity";
            } else if (sight != null && sight.blockHit()) {
                resolved = "block";
            } else {
                // 视线未命中：原版 Minecraft.func_147116_af 在这个情形下什么都不做（只把 leftClickCounter 置 10）。
                // 如实报告，不发假包。
                JsonObject o = new JsonObject();
                o.addProperty("target", "none");
                o.add("sight", PlayerSession.sightRead(sight));
                o.addProperty("before", (String) null);
                o.addProperty("after", (String) null);
                o.addProperty("destroyed", Boolean.valueOf(false));
                // 这条路径**没有发出任何包**（原版在此情形也不发包），因此无需等服务端——
                // 如实写 0 而不是去等一个不会到来的处理。
                o.addProperty("serverSyncWaitedMs", Long.valueOf(0L));
                o.addProperty("observed", Boolean.valueOf(false));
                o.addProperty("miss", Boolean.valueOf(true));
                o.addProperty(
                    "notObservedReason",
                    "视线没有命中任何方块或实体（原版在 func_147116_af 里对此只置 leftClickCounter，不产生包与效果）。"
                        + "要挖指定格请给 at:[x,y,z] 并确保它在服务端交互距离内，或先用 player.look 瞄准");
                o.addProperty("serverReachLimit", Double.valueOf(Math.sqrt(PlayerSession.serverReachLimitSquared())));
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.CASE_SEGMENT,
                    NAME + "：视线未命中（如实报告，未发假包）",
                    Json.object("miss", Boolean.valueOf(true)));
                return PlayerSession.decorated(NAME, "dig", o, server);
            }
        } else {
            throw CpException.param("target 非法", "target", "只允许 auto | block | entity，收到: " + target);
        }

        if ("entity".equals(resolved)) {
            return digEntity(ctx, client, controller, handler, server, world, sight, target);
        }
        return digBlock(ctx, client, controller, handler, server, world, at, sight, holdTicks, target);
    }

    // ------------------------------------------------------------ 实体分支

    private JsonObject digEntity(ActionContext ctx, EntityClientPlayerMP client,
        net.minecraft.client.multiplayer.PlayerControllerMP controller, NetHandlerPlayClient handler,
        EntityPlayerMP server, WorldServer world, PlayerSession.Sight sight, String target) {
        net.minecraft.entity.Entity victim = sight == null ? null : sight.hit == null ? null : sight.hit.entityHit;
        if (victim == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：target=entity 但视线没有命中任何实体（先 player.look {lookAt:[…]} 或 player.move 靠近目标）",
                Json.object("action", NAME, "sight", PlayerSession.sightRead(sight)));
        }
        if (victim == server) {
            throw CpException.param("目标非法", "target", "不能攻击玩家自己");
        }
        int victimId = victim.getEntityId();
        float healthBefore = victim instanceof net.minecraft.entity.EntityLivingBase
            ? ((net.minecraft.entity.EntityLivingBase) victim).getHealth()
            : Float.NaN;
        JsonObject before = entityRead(victim);
        try {
            controller.attackEntity(client, victim);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                NAME + "：attackEntity 抛出异常: " + t,
                Json.object("action", NAME, "entityId", Integer.valueOf(victimId)),
                t);
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        net.minecraft.entity.Entity after = findEntity(world, victimId);
        float healthAfter = after instanceof net.minecraft.entity.EntityLivingBase
            ? ((net.minecraft.entity.EntityLivingBase) after).getHealth()
            : Float.NaN;
        boolean observed = Float.isNaN(healthBefore) ? after == null
            : (after == null || healthAfter != healthBefore
                || ((net.minecraft.entity.EntityLivingBase) after).hurtResistantTime > 0);

        JsonObject o = new JsonObject();
        o.addProperty("target", "entity");
        o.addProperty("requestedTarget", target);
        o.add("victim", before);
        o.add("sight", PlayerSession.sightRead(sight));
        // 非生物目标（船/矿车/画…）没有血量：读数是 NaN，**不能**直接写进 JSON
        // （NaN 不是合法 JSON 字面量，会把整份响应体毒成非法 JSON；见 PlayerSession.finiteOrNull）。
        PlayerSession.addFinite(o, "healthBefore", healthBefore);
        PlayerSession.addFinite(o, "healthAfter", healthAfter);
        if (!Double.isFinite(healthBefore)) {
            o.addProperty(
                "healthNote",
                "该实体不是 EntityLivingBase（没有血量概念），因此 healthBefore/After 为 null 而不是 NaN/"
                    + "Infinity —— 那是非法的 JSON 字面量，会把整份响应体变成非法 JSON");
        }
        o.add("after", after == null ? null : entityRead(after));
        o.addProperty("removed", Boolean.valueOf(after == null));
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                "服务端权威血量未变、实体仍在：多为攻击被服务端拒（距离 >36 或不可见时 >9，见 processUseEntity），"
                    + "或该实体的 attackEntityFrom 未生效；服务端侧不变就是没变，本动作不代它宣布成功");
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.attackEntity（C02PacketUseEntity(ATTACK)），"
                + "服务端在 NetHandlerPlayServer.processUseEntity 的 ATTACK 分支里跑权威攻击；"
                + "EntityItem/EntityXPOrb/EntityArrow/自己都会被服务端踢下线（原版行为），本动作照原样走这条路");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "（实体）：attack 后 health " + healthBefore + " → " + healthAfter,
            Json.object("entityId", Integer.valueOf(victimId), "observed", Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "dig-entity", o, server);
    }

    // ------------------------------------------------------------ 方块分支

    private JsonObject digBlock(ActionContext ctx, EntityClientPlayerMP client,
        net.minecraft.client.multiplayer.PlayerControllerMP controller, NetHandlerPlayClient handler,
        EntityPlayerMP server, WorldServer world, int[] at, PlayerSession.Sight sight, int holdTicks, String target) {
        int x = at[0];
        int y = at[1];
        int z = at[2];
        int side = sight != null && sight.blockHit() && sameBlock(sight.blockPos(), at) ? sight.side() : 1;

        JsonObject before = PlayerSession.blockRead(world, x, y, z);
        if (before.get("blockId") != null && before.get("blockId")
            .getAsInt() == 0) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：目标是空气，没有可破坏的方块",
                Json.object("action", NAME, "at", PlayerSession.posArray(x, y, z), "readBack", before));
        }

        // 服务端自己的距离判定（预检），见 PlayerSession.serverReachSquared
        double distSq = PlayerSession.serverReachSquared(server, x, y, z);
        double limitSq = PlayerSession.serverReachLimitSquared();
        boolean inReach = distSq >= 0.0D && distSq <= limitSq;

        // 硬度在挖之前读（挖完该格就是空气了，读出来的不是「我们试图挖的那个方块有多硬」）。
        // 原版对空气/硬度 0 的方块会给出 Infinity——那不能直接写进 JSON（见 finiteOrNull）。
        double beforeHardness = Double.NaN;
        double beforeBlockHardness = Double.NaN;
        try {
            net.minecraft.block.Block b = world.getBlock(x, y, z);
            if (b != null) {
                beforeHardness = b.getPlayerRelativeBlockHardness(server, world, x, y, z);
                // 原始硬度：不可破坏性只认它（Forge 把负硬度折叠成 0 了，见下方注释）
                beforeBlockHardness = b.getBlockHardness(world, x, y, z);
            }
        } catch (Throwable ignored) {
            // 硬度读数失败不影响主流程；NaN 会被 finiteOrNull 写成 null
        }

        ItemStack heldBefore = server.getHeldItem();

        // 原版左键按下：clickBlock（本地预测 + C07 START）
        try {
            controller.clickBlock(x, y, z, side);
        } catch (Throwable t) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                NAME + "：clickBlock 抛出异常: " + t,
                Json.object("action", NAME, "at", PlayerSession.posArray(x, y, z), "side", Integer.valueOf(side)),
                t);
        }
        int damageTicks = 0;
        // 按住：原版 Minecraft.func_147115_a 每 tick 调 onPlayerDamageBlock
        for (int i = 1; i < holdTicks; i++) {
            try {
                controller.onPlayerDamageBlock(x, y, z, side);
            } catch (Throwable t) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    NAME + "：onPlayerDamageBlock 抛出异常（第 " + (i + 1) + " tick）: " + t,
                    Json.object("action", NAME, "at", PlayerSession.posArray(x, y, z), "tick", Integer.valueOf(i + 1)),
                    t);
            }
            damageTicks++;
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        JsonObject after = PlayerSession.blockRead(world, x, y, z);
        boolean destroyed = after.get("blockId") != null && after.get("blockId")
            .getAsInt() == 0;

        JsonObject o = new JsonObject();
        o.addProperty("target", "block");
        o.addProperty("requestedTarget", target);
        o.add("at", PlayerSession.posArray(x, y, z));
        o.addProperty("side", Integer.valueOf(side));
        o.add("before", before);
        o.add("after", after);
        o.add("sight", PlayerSession.sightRead(sight));
        o.addProperty("holdTicks", Integer.valueOf(holdTicks));
        o.addProperty("damageTicks", Integer.valueOf(damageTicks));
        o.addProperty("destroyed", Boolean.valueOf(destroyed));
        o.addProperty("distanceSquared", Double.valueOf(round(distSq)));
        o.addProperty("serverReachLimitSquared", Double.valueOf(round(limitSq)));
        o.addProperty("inServerReach", Boolean.valueOf(inReach));
        JsonObject gameMode = new JsonObject();
        if (server.theItemInWorldManager != null) {
            Object gt = server.theItemInWorldManager.getGameType();
            gameMode.addProperty("gameType", gt == null ? null : String.valueOf(gt));
            gameMode.addProperty("isCreative", Boolean.valueOf(server.theItemInWorldManager.isCreative()));
        }
        o.add("gameMode", gameMode);
        o.add("heldBefore", PlayerSession.stackRead(heldBefore));
        o.add("heldAfter", PlayerSession.stackRead(server.getHeldItem()));
        o.add("heldChange", UseItemAction.stackChange(heldBefore, server.getHeldItem()));

        // 两个硬度口径都要给，因为它们回答不同问题、而且**在 Forge 上不等价**：
        // - relativeHardness = Block.getPlayerRelativeBlockHardness（可破坏度，>0 才是"挖得动"，越大越快）；
        // - blockHardness = Block.getBlockHardness（原始硬度；**< 0 表示不可破坏**，如基岩 -1）。
        //
        // 关键事实（读 ForgeHooks.blockStrength 源码确认，实机首轮也印证了）：
        // Forge 把「不可破坏」的负硬度**折叠成 0.0F** 返回：
        // float hardness = block.getBlockHardness(...);
        // if (hardness < 0.0F) return 0.0F; // ← 基岩走这条路
        // 因此 **不能**用 relativeHardness < 0 判定不可破坏（那永远不成立）。
        // 实机首轮用 relativeHardness<0 判定，于是挖基岩报了 blockUnbreakable=false、
        // 而原因被写成「超出交互距离」——真正的理由是「不可破坏」。判定必须读 getBlockHardness。
        o.addProperty("relativeHardness", PlayerSession.finiteOrNull(beforeHardness));
        if (!Double.isFinite(beforeHardness)) {
            o.addProperty(
                "relativeHardnessNote",
                "该方块的可破坏度不是有限值（原版对空气等方块会给出 Infinity 或 NaN）；"
                    + "此处如实写 null 而不是把 Infinity 写进 JSON —— JSON 没有 Infinity 字面量，"
                    + "写进去会让整份响应体变成非法 JSON（实测：会让严格解析的调用方直接报错）");
        }
        o.addProperty("blockHardness", PlayerSession.finiteOrNull(beforeBlockHardness));
        boolean unbreakable = Double.isFinite(beforeBlockHardness) && beforeBlockHardness < 0.0D;
        o.addProperty("blockUnbreakable", Boolean.valueOf(unbreakable));
        o.addProperty(
            "hardnessScope",
            "relativeHardness=Block.getPlayerRelativeBlockHardness（可破坏度；Forge 会把负硬度折叠成 0）；"
                + "blockHardness=Block.getBlockHardness（原始硬度，<0 即不可破坏）。"
                + "不可破坏性以 blockHardness 为准——Forge 的折叠让 relativeHardness 判不出这件事");
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(destroyed));
        if (!destroyed) {
            StringBuilder why = new StringBuilder();
            if (unbreakable) {
                why.append(
                    "该方块**不可破坏**（Block.getBlockHardness < 0，如基岩）——服务端永远不会完成破坏，这是原版行为；"
                        + "注意 Forge 的 ForgeHooks.blockStrength 会把负硬度折叠成 0，因此 relativeHardness 看不出这一点；");
            }
            if (!inReach) {
                why.append(
                    "目标超出服务端交互距离（d²=" + round(distSq)
                        + " > "
                        + round(limitSq)
                        + "，服务端 processPlayerDigging 会直接 return）；");
            }
            if (!unbreakable && inReach) {
                why.append("方块仍在：多为生存模式下 holdTicks 不足以挖穿（加大 holdTicks），" + "或服务端把这次破坏拒了（保护/事件）；");
            }
            if (why.length() == 0) {
                why.append("方块未变为空气，原因未定");
            }
            o.addProperty("notObservedReason", why.toString());
        }
        o.addProperty(
            "pathNote",
            "本动作走 PlayerControllerMP.clickBlock / onPlayerDamageBlock（C07PacketPlayerDigging 0/2），"
                + "服务端在 NetHandlerPlayServer.processPlayerDigging 里跑 ItemInWorldManager.onBlockClicked/"
                + "uncheckedTryHarvestBlock；创造模式当场破坏，生存模式按 holdTicks 累计进度");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "（方块）：" + x + "," + y + "," + z + " destroyed=" + destroyed + (unbreakable ? "（不可破坏）" : ""),
            Json.object(
                "at",
                PlayerSession.posArray(x, y, z),
                "destroyed",
                Boolean.valueOf(destroyed),
                "blockUnbreakable",
                Boolean.valueOf(unbreakable)));
        return PlayerSession.decorated(NAME, "dig-block", o, server);
    }

    // ------------------------------------------------------------ 工具

    /** 实体读数。 */
    static JsonObject entityRead(net.minecraft.entity.Entity e) {
        JsonObject o = new JsonObject();
        if (e == null) {
            o.addProperty("present", false);
            return o;
        }
        o.addProperty("present", true);
        o.addProperty("entityId", Integer.valueOf(e.getEntityId()));
        o.addProperty(
            "class",
            e.getClass()
                .getName());
        o.add("pos", PlayerSession.doubleArray(e.posX, e.posY, e.posZ));
        if (e instanceof net.minecraft.entity.EntityLivingBase) {
            o.addProperty("health", Float.valueOf(((net.minecraft.entity.EntityLivingBase) e).getHealth()));
            o.addProperty("maxHealth", Float.valueOf(((net.minecraft.entity.EntityLivingBase) e).getMaxHealth()));
            o.addProperty("dead", Boolean.valueOf(((net.minecraft.entity.EntityLivingBase) e).isDead));
        }
        o.addProperty(
            "name",
            e instanceof net.minecraft.entity.EntityLivingBase
                ? ((net.minecraft.entity.EntityLivingBase) e).getCommandSenderName()
                : null);
        return o;
    }

    /** 按 id 在服务端世界找实体。 */
    static net.minecraft.entity.Entity findEntity(WorldServer world, int entityId) {
        try {
            if (world == null || world.loadedEntityList == null) {
                return null;
            }
            for (Object o : world.loadedEntityList) {
                if (o instanceof net.minecraft.entity.Entity
                    && ((net.minecraft.entity.Entity) o).getEntityId() == entityId) {
                    return (net.minecraft.entity.Entity) o;
                }
            }
        } catch (Throwable ignored) {
            // 找不到即视为已移除
        }
        return null;
    }

    /** 取 at 处的方块坐标；是空气时返回 null。 */
    private static int[] blockUnder(WorldServer world, int[] at) {
        try {
            net.minecraft.block.Block b = world.getBlock(at[0], at[1], at[2]);
            if (b == null || b.getMaterial() == net.minecraft.block.material.Material.air) {
                return null;
            }
        } catch (Throwable t) {
            return null;
        }
        return new int[] { at[0], at[1], at[2] };
    }

    private static boolean sameBlock(int[] a, int[] b) {
        return a != null && b != null && a[0] == b[0] && a[1] == b[1] && a[2] == b[2];
    }

    /** 取方块坐标参数 {@code [x,y,z]}（整数；小数按 floor，与 MC 的格语义一致）。 */
    private static int[] optBlockPos(ActionContext ctx, String name) {
        JsonArray a = ctx.optArray(name);
        if (a == null) {
            return null;
        }
        if (a.size() != 3) {
            throw CpException.param("坐标非法", name, "须为 [x,y,z] 三个数");
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            try {
                out[i] = (int) Math.floor(
                    a.get(i)
                        .getAsDouble());
            } catch (RuntimeException e) {
                throw CpException.param("坐标分量非法", name + "[" + i + "]", "须为数字");
            }
        }
        return out;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0D) / 1000.0D;
    }
}
