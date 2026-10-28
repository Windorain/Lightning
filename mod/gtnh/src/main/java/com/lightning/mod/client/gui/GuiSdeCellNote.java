package com.lightning.mod.client.gui;

import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.gui.GuiTextField;
import net.minecraft.util.StatCollector;

import org.lwjgl.input.Keyboard;

import com.lightning.mod.network.SdeNetwork;
import com.lightning.mod.network.packet.PacketSaveCellNote;

/**
 * 体素备注编辑：多行以换行；保存发往服务端 {@link com.lightning.mod.core.session.ExportSession}。
 */
public class GuiSdeCellNote extends GuiScreen {

    private final int frameIndex;
    private final int zSlice;
    private final int row;
    private final int column;
    private final String initial;
    private GuiTextField textField;

    public GuiSdeCellNote(int frameIndex, int zSlice, int row, int column, String initial) {
        this.frameIndex = frameIndex;
        this.zSlice = zSlice;
        this.row = row;
        this.column = column;
        this.initial = initial != null ? initial : "";
    }

    @Override
    public void initGui() {
        super.initGui();
        Keyboard.enableRepeatEvents(true);
        this.buttonList.clear();
        int cx = this.width / 2;
        int y0 = this.height / 2 - 50;
        this.textField = new GuiTextField(this.fontRendererObj, cx - 150, y0, 300, 16);
        this.textField.setMaxStringLength(8000);
        this.textField.setText(this.initial);
        this.textField.setFocused(true);
        this.buttonList.add(
            new GuiButton(0, cx - 100, y0 + 100, 90, 20, StatCollector.translateToLocal("sde.gui.cell_note.save")));
        this.buttonList.add(
            new GuiButton(1, cx + 10, y0 + 100, 90, 20, StatCollector.translateToLocal("sde.gui.cell_note.cancel")));
    }

    @Override
    public void onGuiClosed() {
        Keyboard.enableRepeatEvents(false);
        super.onGuiClosed();
    }

    @Override
    public void updateScreen() {
        super.updateScreen();
    }

    @Override
    protected void actionPerformed(GuiButton b) {
        if (b.id == 0) {
            saveAndClose();
        } else if (b.id == 1) {
            this.mc.displayGuiScreen(null);
        }
    }

    private void saveAndClose() {
        if (SdeNetwork.isReady()) {
            SdeNetwork.sendSaveCellNoteToServer(
                new PacketSaveCellNote(
                    this.frameIndex,
                    this.zSlice,
                    this.row,
                    this.column,
                    this.textField != null ? this.textField.getText() : ""));
        }
        this.mc.displayGuiScreen(null);
    }

    @Override
    protected void keyTyped(char c, int key) {
        if (this.textField == null) {
            return;
        }
        if (key == 1) {
            this.mc.displayGuiScreen(null);
            return;
        }
        if (key == 28 || key == 156) {
            saveAndClose();
            return;
        }
        this.textField.textboxKeyTyped(c, key);
    }

    @Override
    protected void mouseClicked(int mX, int mY, int btn) {
        super.mouseClicked(mX, mY, btn);
        if (this.textField != null) {
            this.textField.mouseClicked(mX, mY, btn);
        }
    }

    @Override
    public void drawScreen(int mX, int mY, float partialTicks) {
        this.drawDefaultBackground();
        int cx = this.width / 2;
        this.drawCenteredString(
            this.fontRendererObj,
            StatCollector.translateToLocal("sde.gui.cell_note.title") + " ["
                + this.frameIndex
                + " / "
                + this.zSlice
                + ","
                + this.row
                + ","
                + this.column
                + "]",
            cx,
            this.height / 2 - 70,
            0xffffff);
        this.drawString(
            this.fontRendererObj,
            StatCollector.translateToLocal("sde.gui.cell_note.hint"),
            cx - 150,
            this.height / 2 - 58,
            0xa0a0a0);
        if (this.textField != null) {
            this.textField.drawTextBox();
        }
        super.drawScreen(mX, mY, partialTicks);
    }
}
