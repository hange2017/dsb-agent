import { describe, it, expect } from "vitest";
import { newMessageId, type HostToWebviewMessage, type TimelineStepMessage } from "../src/chat/protocol";

describe("protocol", () => {
  it("generates unique message ids", () => {
    const a = newMessageId();
    const b = newMessageId();
    expect(a).not.toBe(b);
    expect(a.startsWith("m_")).toBe(true);
  });

  it("accepts timeline_step kind text with final", () => {
    const msg: TimelineStepMessage = {
      type: "timeline_step",
      messageId: "a1",
      stepId: "text-1",
      kind: "text",
      status: "completed",
      text: "hello **x**",
      final: true,
    };
    expect(msg.kind).toBe("text");
    expect(msg.final).toBe(true);
  });

  it("accepts models_updated remote/builtin with models and loading without", () => {
    const remote: HostToWebviewMessage = {
      type: "models_updated",
      providerId: "p1",
      source: "remote",
      models: [{ id: "deepseek-v4-flash", capabilities: { supportsVision: true, supportsThinking: true }, source: "remote" }],
    };
    expect(remote.source).toBe("remote");
    expect(remote.models).toHaveLength(1);
    const builtin: HostToWebviewMessage = { type: "models_updated", providerId: "p1", source: "builtin" };
    expect(builtin.source).toBe("builtin");
    const loading: HostToWebviewMessage = { type: "models_updated", providerId: "p1", source: "loading" };
    expect(loading.source).toBe("loading");
    expect(loading.models).toBeUndefined();
  });
});
