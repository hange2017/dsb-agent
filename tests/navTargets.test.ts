import { describe, it, expect } from "vitest";
import {
  kNavTolerance,
  pickNavTarget,
  type NavAnchor,
} from "../webview/navTargets";

/** 构造一个 user 锚点(锚点块高 h)。 */
function user(id: string, top: number, h = 40): NavAnchor {
  return { id, kind: "user", top, bottom: top + h };
}

/** 构造一个 dsb 锚点(锚点块高 h)。 */
function dsb(id: string, top: number, h = 80): NavAnchor {
  return { id, kind: "dsb", top, bottom: top + h };
}

describe("pickNavTarget · up", () => {
  it("连续多个 user 锚点时逐个跳最近", () => {
    const anchors = [user("u1", 0), user("u2", 200), user("u3", 400)];
    // 从 u2/u3 之间上跳 → 最近的 user 是 u2
    expect(pickNavTarget(anchors, 300, "up", false)?.id).toBe("u2");
    // 从 u1/u2 之间上跳 → u1
    expect(pickNavTarget(anchors, 150, "up", true)?.id).toBe("u1");
    // 从第一个 user 之内上跳 → 无更上的 user,null
    expect(pickNavTarget(anchors, 20, "up", false)).toBeNull();
  });

  it("up 无目标返回 null(空列表或没有更上的 user)", () => {
    expect(pickNavTarget([user("u1", 0, 40)], 0, "up", false)).toBeNull();
    expect(pickNavTarget([], 100, "up", false)).toBeNull();
    // 只有 dsb,无 user → null
    expect(
      pickNavTarget([dsb("d1", 100, 80)], 300, "up", false)
    ).toBeNull();
  });

  it("up 忽略 dsb 锚点", () => {
    const anchors = [dsb("d1", 0, 80), user("u1", 200, 40), dsb("d2", 300, 80)];
    // refTop 在 d2 之下:最近的 user 是 u1,dsb 不参与
    expect(pickNavTarget(anchors, 500, "up", false)?.id).toBe("u1");
  });

  it("refTop 恰在锚点之间:取上一个 user", () => {
    const anchors = [user("u1", 0, 40), user("u2", 100, 40), user("u3", 200, 40)];
    // refTop 恰在 u2 与 u3 之间 → u2
    expect(pickNavTarget(anchors, 140, "up", false)?.id).toBe("u2");
  });

  it("8px 容差:anchor.bottom === refTop + 8 应命中(上跳含边界)", () => {
    const anchors = [user("u1", 0, 100)];
    // bottom = 100,refTop = 92 → bottom <= 100 成立,命中
    expect(pickNavTarget(anchors, 92, "up", false)?.id).toBe("u1");
    // bottom = 100,refTop = 91 → 100 <= 99 不成立,无目标
    expect(pickNavTarget(anchors, 91, "up", false)).toBeNull();
    expect(kNavTolerance).toBe(8);
  });
});

describe("pickNavTarget · down", () => {
  it("stickToBottom=true 时直接返回 null", () => {
    const anchors = [
      user("u1", 0, 40),
      dsb("d1", 100, 80),
      dsb("d2", 300, 80),
    ];
    expect(pickNavTarget(anchors, 50, "down", true)).toBeNull();
  });

  it("stickToBottom=false 时找最近的 dsb", () => {
    const anchors = [dsb("d1", 100, 80), dsb("d2", 300, 80)];
    expect(pickNavTarget(anchors, 50, "down", false)?.id).toBe("d1");
    // refTop 在 d1 与 d2 之间 → d2
    expect(pickNavTarget(anchors, 200, "down", false)?.id).toBe("d2");
    // refTop 恰在 d1 顶之下但仍在其内部 → d2(严格在 refTop 之下)
    expect(pickNavTarget(anchors, 120, "down", false)?.id).toBe("d2");
  });

  it("down 无 dsb 返回 null", () => {
    expect(
      pickNavTarget([user("u1", 0, 40), user("u2", 200, 40)], 50, "down", false)
    ).toBeNull();
    expect(pickNavTarget([], 0, "down", false)).toBeNull();
  });

  it("8px 容差:anchor.top === refTop - 8 应命中(下跳含边界)", () => {
    const anchors = [dsb("d1", 100, 80)];
    // top = 100,refTop = 108 → 100 >= 100 成立,命中
    expect(pickNavTarget(anchors, 108, "down", false)?.id).toBe("d1");
    // top = 100,refTop = 109 → 100 >= 101 不成立,无目标
    expect(pickNavTarget(anchors, 109, "down", false)).toBeNull();
  });

  it("down 时忽略 user 锚点,只找 dsb", () => {
    const anchors = [
      user("u1", 0, 40),
      user("u2", 60, 40), // 更近的 user,但不是目标
      dsb("d1", 200, 80),
    ];
    // refTop 之下最近的是 user u2,但 down 只找 dsb → d1
    expect(pickNavTarget(anchors, 50, "down", false)?.id).toBe("d1");
  });
});

describe("pickNavTarget · 空数组", () => {
  it("空数组任何方向都返回 null", () => {
    expect(pickNavTarget([], 0, "up", false)).toBeNull();
    expect(pickNavTarget([], 0, "up", true)).toBeNull();
    expect(pickNavTarget([], 0, "down", false)).toBeNull();
    expect(pickNavTarget([], 0, "down", true)).toBeNull();
  });
});
