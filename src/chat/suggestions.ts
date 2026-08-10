/**
 * 输入框 `/`、`@` 建议的触发检测与过滤(纯 TS,无 node 依赖)。
 * 从 learn 项目移植;webview(浏览器 bundle)与 host 共用。
 */

export type TriggerInfo = {
  trigger: "@" | "/";
  query: string;
  start: number;
  end: number;
};

/**
 * 检测光标所在 token 是否以 `@` 或 `/` 开头。
 * token 从光标往前扫到空白处(或字符串开头)。
 */
export function detectTrigger(
  text: string,
  cursor: number,
): TriggerInfo | null {
  const pos = Math.max(0, Math.min(cursor, text.length));
  let start = pos;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === " " || ch === "\n" || ch === "\t") {
      break;
    }
    start -= 1;
  }
  const token = text.slice(start, pos);
  if (token.startsWith("@")) {
    return { trigger: "@", query: token.slice(1), start, end: pos };
  }
  if (token.startsWith("/")) {
    return { trigger: "/", query: token.slice(1), start, end: pos };
  }
  return null;
}

export type BuiltInCommand = {
  kind: "command";
  name: string;
  detail: string;
};

/** 聊天内可执行的命令(其余如 rewind/memory 等走命令面板)。 */
export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  { kind: "command", name: "new", detail: "新会话" },
  { kind: "command", name: "plugins", detail: "推荐插件" },
  { kind: "command", name: "cancel", detail: "停止当前任务" },
  { kind: "command", name: "compact", detail: "压缩当前会话上下文" },
  { kind: "command", name: "export", detail: "导出对话(md/json)" },
  { kind: "command", name: "memory", detail: "记忆管理(dream 整合)" },
  { kind: "command", name: "help", detail: "显示命令帮助" },
];

export function filterBuiltInCommands(query: string): BuiltInCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...BUILT_IN_COMMANDS];
  return BUILT_IN_COMMANDS.filter(
    (c) => c.name.includes(q) || c.detail.toLowerCase().includes(q),
  );
}

export function filterByQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => getText(item).toLowerCase().includes(q));
}

/** 移除光标处的 trigger token(供选中建议后重写输入)。 */
export function stripTriggerToken(
  text: string,
  start: number,
  end: number,
): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  return (before + after).replace(/  +/g, " ").trimStart();
}
