import { describe, it, expect, vi } from "vitest";
import { VscodeNotifier, NoopNotifier } from "../src/notifications/notifier";

describe("VscodeNotifier", () => {
  it("forwards info with title prefix", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const n = new VscodeNotifier({ info, warn, error });
    n.info("A", "b");
    expect(info).toHaveBeenCalledWith("A: b");
    n.warn("A", "c");
    expect(warn).toHaveBeenCalledWith("A: c");
  });
  it("forwards error to show.error", () => {
    const error = vi.fn();
    const n = new VscodeNotifier({ info: vi.fn(), warn: vi.fn(), error });
    n.error("Boom", "details");
    expect(error).toHaveBeenCalledWith("Boom: details");
    n.error("Boom");
    expect(error).toHaveBeenCalledWith("Boom");
  });
  it("NoopNotifier does nothing", () => {
    const n = new NoopNotifier();
    expect(() => n.info("x")).not.toThrow();
    expect(() => n.warn("x")).not.toThrow();
    expect(() => n.error("x")).not.toThrow();
  });
});
