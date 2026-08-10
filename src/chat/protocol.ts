import type { SessionSummary } from "../session/sessionTypes";
import type { PermissionMode } from "../agent/permission";
import type { CompactionStatsSnapshot } from "../agent/compactionStats";
import type { ToolBodyBlock } from "./toolPresentation";
import type { Capabilities, Mode, ModelInfo } from "../providers/types";

/** 供应商列表项(webview 下拉用)。 */
export type ProviderListItem = {
  id: string;
  name: string;
  active: boolean;
};

/** 输入框 `/`、`@` 建议项。 */
export type SuggestionItem =
  | { kind: "command"; name: string; detail: string }
  | { kind: "skill"; name: string; description: string }
  | { kind: "file"; relativePath: string };

/** 时间线步骤(host → webview)。 */
export type TimelineStepMessage =
  | {
      type: "timeline_step";
      messageId: string;
      stepId: string;
      kind: "thinking";
      status: "running" | "completed";
      durationMs?: number;
      text?: string;
    }
  | {
      type: "timeline_step";
      messageId: string;
      stepId: string;
      kind: "tool";
      name: string;
      displayName: string;
      status: "running" | "completed" | "error";
      headerSecondary?: string;
      summary?: string;
      body?: ToolBodyBlock[];
    }
  | {
      type: "timeline_step";
      messageId: string;
      stepId: string;
      kind: "todos";
      status: "completed";
      items: Array<{ id: string; content: string; done: boolean }>;
    }
  | {
      type: "timeline_step";
      messageId: string;
      stepId: string;
      kind: "text";
      status: "running" | "completed";
      text?: string;
      /** 仅该轮最后一段助手文字为 true,webview 加蓝框 */
      final?: boolean;
    };

export type HostToWebviewMessage =
  | {
      type: "init";
      cwd: string;
      hasKey: boolean;
      model: string;
      vimMode: boolean;
      permissionMode: PermissionMode;
      providers: ProviderListItem[];
      models: ModelInfo[];
      modes: Mode[];
      currentCapabilities: Capabilities;
      /** UI 语言:zh=中文,en=英文(设置面板可切换)。 */
      locale: "zh" | "en";
      notificationsEnabled: boolean;
    }
  | { type: "locale_changed"; locale: "zh" | "en" }
  | { type: "provider_changed"; providerId: string; providerName: string; models: ModelInfo[]; modes: Mode[]; capabilities: Capabilities }
  | {
      type: "models_updated";
      providerId: string;
      source: "loading" | "remote" | "builtin";
      /** models 仅在 source 非 loading 时下发(类型上保持可选)。 */
      models?: ModelInfo[];
    }
  | { type: "message"; id: string; role: "user" | "assistant"; text: string }
  | { type: "stream"; messageId: string; text: string; stepId?: string }
  | { type: "tool"; messageId: string; name: string; status: "running" | "completed" | "error"; detail?: string }
  | TimelineStepMessage
  | { type: "status"; busy: boolean; info?: string; error?: boolean }
  | { type: "toast"; message: string; error?: boolean }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "compaction_stats"; stats: CompactionStatsSnapshot }
  | { type: "reset" }
  | { type: "history_start" }
  | { type: "history_end" }
  | { type: "ask_permission"; askId: string; toolName: string; detail?: string }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "chipsAttached"; chips: Array<{ id: string; kind: string; label: string; dataUrl?: string }>; insertTexts: string[] }
  | { type: "pasteHandled"; consumed: boolean; text?: string }
  | { type: "chipRemoved"; id: string; label?: string }
  | { type: "assistant_done"; messageId: string }
  | { type: "todos"; items: Array<{ id: string; content: string; done: boolean }> }
  | { type: "plugin_recommendations"; items: Array<{ name: string; origin: string; reason: string; installable: boolean }> }
  | { type: "plugin_installed"; ok: boolean; message: string }
  | { type: "suggestions"; items: SuggestionItem[] }
  | { type: "suggestionPicked"; inputText: string; caret?: number; insertText?: string; chips?: Array<{ id: string; kind: string; label: string }> };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "new" }
  | { type: "new_session" }
  | { type: "load_session"; id: string }
  | { type: "delete_session"; id: string }
  | { type: "set_mode"; mode: "agent" | "plan" | "ask" }
  | { type: "set_model"; model: string }
  | { type: "set_provider"; providerId: string }
  | { type: "attach_images"; images: Array<{ mimeType: string; data: string; fileName?: string }> }
  | { type: "attach_documents"; documents: Array<{ fileName: string; mimeType: string; data: string }> }
  | { type: "permission_response"; askId: string; approved: boolean }
  | { type: "approve_once"; toolName: string }
  | { type: "remove_chip"; id: string }
  | { type: "paste"; text: string }
  | { type: "open_chip"; id: string }
  | { type: "open_file"; path: string; line?: number }
  | { type: "skill_command"; name: string }
  | { type: "recommend_plugins"; query: string }
  | { type: "install_plugin"; marketplace: string; name: string }
  | { type: "suggest"; trigger: "@" | "/"; query: string }
  | { type: "pickSuggestion"; item: SuggestionItem; triggerStart: number; triggerEnd: number; inputText: string }
  | { type: "set_permission_mode"; mode: PermissionMode }
  | { type: "set_language"; language: "" | "zh" | "en" }
  | { type: "set_vim_mode"; enabled: boolean }
  | { type: "set_notifications"; enabled: boolean }
  | { type: "open_provider_settings" }
  | { type: "open_memory_manager" }
  | { type: "open_agent_settings" };

export function newMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
