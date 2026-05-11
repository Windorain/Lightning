package com.lightning.mod.server.command;

import java.nio.file.Files;
import java.nio.file.Paths;

import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.event.ClickEvent;
import net.minecraft.event.HoverEvent;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.MathHelper;
import net.minecraft.util.MovingObjectPosition;

import com.lightning.mod.core.session.ExportSession;
import com.lightning.mod.core.session.SdeSelectionMode;
import com.lightning.mod.core.util.RayTraceUtil;
import com.lightning.mod.network.SdeNetwork;
import com.lightning.mod.server.SdePermissions;
import com.lightning.mod.server.SdeServerRecordScheduler;
import com.lightning.mod.server.web.SdeWebServer;
import com.google.gson.JsonObject;

public class CommandSde extends CommandBase {

    @Override
    public String getCommandName() {
        return "sde";
    }

    @Override
    public String getCommandUsage(ICommandSender sender) {
        return "/sde <pos1|pos2|hpos1|hpos2|sel [cuboid|extend]|start|end|setName|setFrame|setStructureId|record [N|cycle]|export [raw]|dump|status|web [port]|webstop>";
    }

    @Override
    public int getRequiredPermissionLevel() {
        return 2;
    }

    @Override
    public void processCommand(ICommandSender sender, String[] args) {
        if (args.length == 0) {
            sender.addChatMessage(new ChatComponentText(getCommandUsage(sender)));
            return;
        }
        ExportSession s = ExportSession.get();
        String sub = args[0].toLowerCase();
        try {
            switch (sub) {
                case "pos1":
                    if (!checkPlayer(sender)) return;
                    applyPos1FromPlayerBlock((EntityPlayerMP) sender, s);
                    break;
                case "pos2":
                    if (!checkPlayer(sender)) return;
                    applyPos2FromPlayerBlock((EntityPlayerMP) sender, s);
                    break;
                case "hpos1":
                    if (!checkPlayer(sender)) return;
                    applyPos1FromRay((EntityPlayerMP) sender, s);
                    break;
                case "hpos2":
                    if (!checkPlayer(sender)) return;
                    applyPos2FromRay((EntityPlayerMP) sender, s);
                    break;
                case "sel": {
                    SdeSelectionMode mode = SdeSelectionMode.CUBOID;
                    if (args.length >= 2) {
                        String a = args[1].toLowerCase();
                        if ("extend".equals(a)) {
                            mode = SdeSelectionMode.EXTEND;
                        } else if (!"cuboid".equals(a)) {
                            sender
                                .addChatMessage(new ChatComponentText("SDE: 用法: /sde sel [cuboid|extend]（默認 cuboid）"));
                            return;
                        }
                    }
                    s.setSelectionMode(mode);
                    sender.addChatMessage(
                        new ChatComponentText("SDE: 选区模式=" + mode + "（cuboid=两角点；extend=新点并入并扩张 AABB，对齐 //sel）"));
                    if (sender instanceof EntityPlayerMP) {
                        SdeNetwork.sendSelectionSync((EntityPlayerMP) sender);
                    }
                    break;
                }
                case "start":
                    s.startSession();
                    sender.addChatMessage(new ChatComponentText("SDE: 会话已开始"));
                    if (sender instanceof EntityPlayerMP) {
                        SdeNetwork.sendSelectionSync((EntityPlayerMP) sender);
                    }
                    break;
                case "end":
                    s.endSession();
                    sender.addChatMessage(new ChatComponentText("SDE: 会话已结束"));
                    if (sender instanceof EntityPlayerMP) {
                        SdeNetwork.sendSelectionSync((EntityPlayerMP) sender);
                    }
                    break;
                case "setname":
                    s.setOutputName(joinArgs(args, 1));
                    sender.addChatMessage(new ChatComponentText("SDE: 输出文件名（无后缀）=" + s.getOutputName()));
                    break;
                case "setframe":
                    s.setActiveFrame(parseIntRequired(args, 1));
                    sender.addChatMessage(new ChatComponentText("SDE: 活动帧=" + s.getActiveFrame()));
                    break;
                case "setstructureid":
                    s.setStructureId(joinArgs(args, 1));
                    sender.addChatMessage(new ChatComponentText("SDE: structureId=" + s.getStructureId()));
                    break;
                case "record": {
                    if (!checkPlayer(sender)) return;
                    EntityPlayerMP recP = (EntityPlayerMP) sender;
                    if (!SdePermissions.canUseSde(recP)) {
                        recP.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
                        return;
                    }
                    if (args.length == 1) {
                        s.record(recP);
                        sender.addChatMessage(new ChatComponentText("SDE: 已写入内存帧 " + s.getActiveFrame() + "（未落盘）"));
                        break;
                    }
                    if (SdeServerRecordScheduler.get()
                        .isBusy()) {
                        sender.addChatMessage(new ChatComponentText("SDE: 已有连录或 cycle 进行中，请等待结束或拒绝后重试"));
                        return;
                    }
                    if (args.length == 2 && "cycle".equalsIgnoreCase(args[1])) {
                        int f0 = s.getActiveFrame();
                        JsonObject scan0 = s.scanToStructureJsonOnly(recP);
                        String baseline = s.jsonStringForScanCompare(scan0);
                        s.commitScanToFrame(f0, scan0, recP);
                        if (!SdeServerRecordScheduler.get()
                            .tryStartCycleFromNextTick(recP, f0, baseline)) {
                            sender.addChatMessage(new ChatComponentText("SDE: 无法启动 cycle"));
                            return;
                        }
                        sender.addChatMessage(
                            new ChatComponentText(
                                "SDE: cycle 已启动（首帧 F" + f0
                                    + " 已写入；自下一 tick 起比较 scan，最多 "
                                    + SdeServerRecordScheduler.MAX_CYCLE_ATTEMPTS
                                    + " tick，未落盘）"));
                        break;
                    }
                    if (args.length == 2) {
                        int n;
                        try {
                            n = Integer.parseInt(args[1]);
                        } catch (NumberFormatException ex) {
                            sender.addChatMessage(
                                new ChatComponentText(
                                    "SDE: record 用法: /sde record | /sde record <N> | /sde record cycle"));
                            return;
                        }
                        if (n <= 0) {
                            sender.addChatMessage(new ChatComponentText("SDE: N 须为正整数"));
                            return;
                        }
                        if (n > SdeServerRecordScheduler.MAX_CONSECUTIVE_RECORD_TICKS) {
                            sender.addChatMessage(
                                new ChatComponentText(
                                    "SDE: N 过大（上限 " + SdeServerRecordScheduler.MAX_CONSECUTIVE_RECORD_TICKS + "），已拒绝"));
                            return;
                        }
                        int f0b = s.getActiveFrame();
                        if (!SdeServerRecordScheduler.get()
                            .tryStartTickBatch(recP, f0b, n)) {
                            sender.addChatMessage(new ChatComponentText("SDE: 无法启动连录"));
                            return;
                        }
                        sender.addChatMessage(
                            new ChatComponentText(
                                "SDE: 连录已启动 " + n + " tick（自下一 tick 写入 F" + f0b + "–F" + (f0b + n - 1) + "，未落盘）"));
                        break;
                    }
                    sender.addChatMessage(
                        new ChatComponentText("SDE: record 用法: /sde record | /sde record <N> | /sde record cycle"));
                    break;
                }
                case "export":
                    if (!checkPlayer(sender)) return;
                    EntityPlayerMP exporter = (EntityPlayerMP) sender;
                    boolean writeRaw = args.length >= 2 && "raw".equalsIgnoreCase(args[1]);
                    String path = s.exportToFile();
                    sender.addChatMessage(new ChatComponentText("SDE: 已写出场景文件: " + path));
                    java.io.File outFile = new java.io.File(path);
                    byte[] payload = Files.readAllBytes(Paths.get(path));
                    SdeNetwork.sendEnrichExportedScene(exporter, outFile.getName(), payload, writeRaw);
                    break;
                case "dump":
                    if (!checkPlayer(sender)) return;
                    String dumpRoot = s.requestRegistryDump();
                    sender.addChatMessage(
                        new ChatComponentText(
                            "SDE: 已写入 pending_dump.json，客户端将生成全量 block_registry.json / material_registry.json: "
                                + dumpRoot));
                    break;
                case "status":
                    sender.addChatMessage(new ChatComponentText(s.statusLine()));
                    break;
                case "web": {
                    int port = 37564;
                    if (args.length >= 2) {
                        port = Integer.parseInt(args[1]);
                    }
                    String tok = java.util.UUID.randomUUID()
                        .toString()
                        .replace("-", "");
                    SdeWebServer.start(port, tok);
                    int boundPort = SdeWebServer.getBoundPort();
                    // 勿用 MinecraftServer.getServerHostname()/getHostname()：1.7.10 上为 @SideOnly(SERVER)，
                    // 集成服客户端环境会 NoSuchMethodError。本机浏览器用回环即可；远程访问请自行换为机器局域网 IP。
                    String host = "127.0.0.1";
                    String base = "http://" + host + ":" + boundPort;
                    String workbenchUrl = base + "/?apiBase="
                        + java.net.URLEncoder.encode(base, "UTF-8")
                        + "&token="
                        + tok;

                    ChatComponentText webLine = new ChatComponentText("[SDE] ");
                    webLine.appendSibling(sdeClickableLink("点我打开工作区", workbenchUrl, "在浏览器中打开工作台"));
                    sender.addChatMessage(webLine);
                    break;
                }
                case "webstop":
                    SdeWebServer.stopServer();
                    sender.addChatMessage(new ChatComponentText("SDE Web 已停止"));
                    break;
                default:
                    sender.addChatMessage(new ChatComponentText("未知子命令: " + sub));
                    sender.addChatMessage(new ChatComponentText(getCommandUsage(sender)));
                    break;
            }
        } catch (Exception e) {
            sender.addChatMessage(new ChatComponentText("SDE 错误: " + e.getMessage()));
        }
    }

    /**
     * 与 WorldEdit {@code //pos1} 一致：取玩家脚下方块坐标（体素化位置），不依赖准星。
     */
    private static void applyPos1FromPlayerBlock(EntityPlayerMP player, ExportSession s) {
        if (!SdePermissions.canUseSde(player)) {
            player.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return;
        }
        int x = MathHelper.floor_double(player.posX);
        int y = MathHelper.floor_double(player.posY);
        int z = MathHelper.floor_double(player.posZ);
        s.setPos1Block(x, y, z);
        SdeNetwork.sendSelectionSync(player);
        player.addChatMessage(new ChatComponentText("SDE: pos1 已记录（" + x + ", " + y + ", " + z + "，脚下方块）"));
    }

    private static void applyPos2FromPlayerBlock(EntityPlayerMP player, ExportSession s) {
        if (!SdePermissions.canUseSde(player)) {
            player.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return;
        }
        int x = MathHelper.floor_double(player.posX);
        int y = MathHelper.floor_double(player.posY);
        int z = MathHelper.floor_double(player.posZ);
        s.setPos2Block(x, y, z);
        SdeNetwork.sendSelectionSync(player);
        player.addChatMessage(new ChatComponentText("SDE: pos2 已记录（" + x + ", " + y + ", " + z + "，脚下方块）"));
    }

    /** 与 WorldEdit {@code //hpos1} 一致：准星指向的方块。 */
    private static void applyPos1FromRay(EntityPlayerMP player, ExportSession s) {
        if (!SdePermissions.canUseSde(player)) {
            player.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return;
        }
        MovingObjectPosition mop = RayTraceUtil.rayTraceBlock(player);
        if (!RayTraceUtil.isBlockHit(mop)) {
            player.addChatMessage(new ChatComponentText("SDE: 未指向方块"));
            return;
        }
        s.setPos1Block(mop.blockX, mop.blockY, mop.blockZ);
        SdeNetwork.sendSelectionSync(player);
        player.addChatMessage(new ChatComponentText("SDE: hpos1 已记录（准星方块）"));
    }

    private static void applyPos2FromRay(EntityPlayerMP player, ExportSession s) {
        if (!SdePermissions.canUseSde(player)) {
            player.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return;
        }
        MovingObjectPosition mop = RayTraceUtil.rayTraceBlock(player);
        if (!RayTraceUtil.isBlockHit(mop)) {
            player.addChatMessage(new ChatComponentText("SDE: 未指向方块"));
            return;
        }
        s.setPos2Block(mop.blockX, mop.blockY, mop.blockZ);
        SdeNetwork.sendSelectionSync(player);
        player.addChatMessage(new ChatComponentText("SDE: hpos2 已记录（准星方块）"));
    }

    private static boolean checkPlayer(ICommandSender sender) {
        if (!(sender instanceof EntityPlayerMP)) {
            sender.addChatMessage(new ChatComponentText("SDE: 该子命令仅玩家可用"));
            return false;
        }
        return true;
    }

    private static String joinArgs(String[] args, int from) {
        if (from >= args.length) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < args.length; i++) {
            if (i > from) sb.append(' ');
            sb.append(args[i]);
        }
        return sb.toString();
    }

    private static int parseIntRequired(String[] args, int i) {
        if (i >= args.length) throw new IllegalArgumentException("缺少整数参数");
        return Integer.parseInt(args[i]);
    }

    private static ChatComponentText sdeClickableLink(String label, String url, String hover) {
        ChatComponentText t = new ChatComponentText(label);
        t.setChatStyle(
            new ChatStyle().setChatClickEvent(new ClickEvent(ClickEvent.Action.OPEN_URL, url))
                .setChatHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, new ChatComponentText(hover)))
                .setUnderlined(true)
                .setColor(EnumChatFormatting.AQUA));
        return t;
    }
}
