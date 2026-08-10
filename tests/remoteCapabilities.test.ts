import { describe, it, expect } from "vitest";
import { mapRemoteModelCapabilities } from "../src/providers/remoteCapabilities";

describe("mapRemoteModelCapabilities", () => {
  it("maps Anthropic/OpenAI-ish vision flags", () => {
    expect(mapRemoteModelCapabilities({ supports_vision: true })).toEqual({ supportsVision: true });
    expect(mapRemoteModelCapabilities({ supportsVision: false })).toEqual({ supportsVision: false });
    expect(mapRemoteModelCapabilities({ vision: true })).toEqual({ supportsVision: true });
    expect(mapRemoteModelCapabilities({ capabilities: { vision: true } })).toEqual({
      supportsVision: true,
    });
  });

  it("maps thinking / reasoning flags", () => {
    expect(mapRemoteModelCapabilities({ supports_thinking: true })).toEqual({ supportsThinking: true });
    expect(mapRemoteModelCapabilities({ supportsThinking: false })).toEqual({ supportsThinking: false });
    expect(mapRemoteModelCapabilities({ thinking: true })).toEqual({ supportsThinking: true });
    expect(mapRemoteModelCapabilities({ capabilities: { thinking: false } })).toEqual({
      supportsThinking: false,
    });
    expect(mapRemoteModelCapabilities({ capabilities: { reasoning: true } })).toEqual({
      supportsThinking: true,
    });
  });

  it("is fail-open: only sets fields when confidently boolean", () => {
    expect(mapRemoteModelCapabilities({})).toEqual({});
    expect(mapRemoteModelCapabilities({ supports_vision: "yes" })).toEqual({});
    expect(mapRemoteModelCapabilities({ vision: 1 })).toEqual({});
    expect(mapRemoteModelCapabilities({ capabilities: { vision: "true" } })).toEqual({});
    expect(mapRemoteModelCapabilities({ capabilities: null as unknown as undefined })).toEqual({});
  });

  it("prefers top-level explicit keys over nested capabilities", () => {
    expect(
      mapRemoteModelCapabilities({
        supports_vision: false,
        capabilities: { vision: true },
      }),
    ).toEqual({ supportsVision: false });
  });

  it("maps both vision and thinking when present", () => {
    expect(
      mapRemoteModelCapabilities({
        supports_vision: true,
        supports_thinking: false,
      }),
    ).toEqual({ supportsVision: true, supportsThinking: false });
  });
});
