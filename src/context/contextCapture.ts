import * as vscode from "vscode";
import * as path from "path";
import type { ContextChip, EditorChip, TerminalChip } from "./types";
import {
  classifyEditorPasteMode,
  type EditorPasteMode,
} from "./editorPasteMode";

/** 可参与「复制→粘贴提升」的 chip:均带 text,不含 ImageChip。 */
type PastePromotableChip = EditorChip | TerminalChip;

function newId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ContextCapture {
  private last: PastePromotableChip | undefined;
  private lastPasteMode: EditorPasteMode | undefined;
  private onCaptured: ((chip: ContextChip) => void) | undefined;

  setOnCaptured(handler: (chip: ContextChip) => void): void {
    this.onCaptured = handler;
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "dsbAgent.captureEditorCopy",
        () => {
          this.captureEditorSelection();
          return vscode.commands.executeCommand(
            "editor.action.clipboardCopyAction",
          );
        },
      ),
      vscode.commands.registerCommand(
        "dsbAgent.attachTerminalClipboard",
        async () => {
          const text = await vscode.env.clipboard.readText();
          const chip = this.captureTerminalSelection(text);
          if (chip) {
            this.onCaptured?.(chip);
            this.last = undefined;
          }
        },
      ),
      vscode.window.onDidChangeActiveTerminal(() => {
        /* reserved */
      }),
    );
  }

  captureEditorSelection(): EditorChip | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }
    const doc = editor.document;
    const selection = editor.selection;
    const text = doc.getText(selection);
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
    const absolutePath = doc.uri.fsPath;
    const relativePath = ws
      ? path.relative(ws.uri.fsPath, absolutePath)
      : path.basename(absolutePath);
    const fullLineText = doc.lineAt(selection.start.line).text;
    const pasteMode = classifyEditorPasteMode({
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      selectedText: text,
      fullLineText,
    });
    const chip: EditorChip = {
      kind: "editor",
      id: newId(),
      relativePath: relativePath.replace(/\\/g, "/"),
      absolutePath,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      text,
    };
    this.last = chip;
    this.lastPasteMode = pasteMode;
    return chip;
  }

  captureTerminalSelection(text: string): TerminalChip | undefined {
    const term = vscode.window.activeTerminal;
    if (!text.trim()) {
      return undefined;
    }
    const chip: TerminalChip = {
      kind: "terminal",
      id: newId(),
      terminalName: term?.name ?? "terminal",
      cwd: undefined,
      text,
      capturedAt: new Date().toISOString(),
    };
    this.last = chip;
    this.lastPasteMode = undefined;
    return chip;
  }

  /**
   * When the webview reports a paste, if the pasted text matches the last
   * captured selection text, promote it to a chip instead of raw text.
   */
  consumePasteAsChips(pastedText: string): ContextChip[] {
    if (!this.last) {
      return [];
    }
    if (pastedText.trim() !== this.last.text.trim()) {
      return [];
    }
    if (this.last.kind === "editor" && this.lastPasteMode === "partialLine") {
      this.last = undefined;
      this.lastPasteMode = undefined;
      return [];
    }
    const chip = this.last;
    this.last = undefined;
    this.lastPasteMode = undefined;
    return [chip];
  }

  getLastCopy(): PastePromotableChip | undefined {
    return this.last;
  }

  getLastPasteMode(): EditorPasteMode | undefined {
    return this.lastPasteMode;
  }

  /** @internal test helper */
  setLastEditorForTest(chip: EditorChip, pasteMode: EditorPasteMode): void {
    this.last = chip;
    this.lastPasteMode = pasteMode;
  }
}
