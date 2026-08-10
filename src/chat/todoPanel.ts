// webview 侧"任务清单"面板。宿主通过 protocol 的 { type: "todos" } 消息推送,
// 面板用原生 <details>/<summary> 折叠,展示 ✓/○ 与内容。

export type TodoItem = { id: string; content: string; done: boolean };

export function createTodoPanel(): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "todo-panel";
  panel.hidden = true;
  panel.style.cssText = "border-bottom:1px solid var(--vscode-panel-border);padding:4px 12px;";

  const details = document.createElement("details");
  details.className = "todo-details";
  const summary = document.createElement("summary");
  summary.textContent = "任务清单";
  summary.style.cssText = "cursor:pointer;font-weight:600;font-size:12px;";
  const listEl = document.createElement("ul");
  listEl.className = "todo-list";
  listEl.style.cssText = "margin:4px 0;padding:0;";

  details.append(summary, listEl);
  panel.append(details);
  return panel;
}

export function renderTodos(panel: HTMLElement, items: TodoItem[]): void {
  const details = panel.querySelector<HTMLDetailsElement>("details.todo-details");
  const listEl = panel.querySelector<HTMLUListElement>("ul.todo-list");
  if (!details || !listEl) return;
  listEl.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    li.className = item.done ? "todo done" : "todo";
    li.style.cssText = "display:flex;gap:6px;align-items:baseline;font-size:12px;margin:2px 0;list-style:none;";
    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent = item.done ? "✓" : "○";
    mark.style.cssText = item.done ? "color:#4ade80;" : "color:var(--vscode-descriptionForeground);";
    const text = document.createElement("span");
    text.className = "todo-content";
    text.textContent = item.content;
    li.append(mark, text);
    listEl.append(li);
  }
  panel.hidden = items.length === 0;
}
