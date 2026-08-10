import { describe, it, expect } from "vitest";
import { resolveInlineRefs } from "../src/context/promptBuilder";
import type { ContextChip } from "../src/context/types";

describe("resolveInlineRefs", () => {
  it("inlines a cited text chip as a prompt block and drops uncited chips", () => {
    const cited: ContextChip = {
      kind: "document",
      id: "1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      text: "Hello world",
      displayLabel: "📄 notes.txt",
    };
    const orphan: ContextChip = {
      kind: "document",
      id: "2",
      fileName: "other.txt",
      mimeType: "text/plain",
      text: "other",
      displayLabel: "📄 other.txt",
    };
    const { prompt, chipsForMessage, imageChips } = resolveInlineRefs(
      "see `📄 notes.txt` please",
      [cited, orphan],
    );
    expect(prompt).toContain("[Context: document notes.txt]");
    expect(prompt).toContain("Hello world");
    expect(chipsForMessage.map((c) => c.id)).toEqual(["1"]);
    expect(imageChips).toEqual([]);
    expect(prompt).not.toContain("other.txt");
  });

  it("image chip becomes [Image ref] placeholder and fills imageChips", () => {
    const image: ContextChip = {
      kind: "image",
      id: "img1",
      mimeType: "image/png",
      data: "AA",
      displayLabel: "image: pic.png",
    };
    const { prompt, chipsForMessage, imageChips } = resolveInlineRefs(
      "look at `image: pic.png`",
      [image],
    );
    expect(prompt).toContain("[Image ref: image: pic.png]");
    expect(prompt).not.toContain("AA");
    expect(chipsForMessage.map((c) => c.id)).toEqual(["img1"]);
    expect(imageChips.map((c) => c.id)).toEqual(["img1"]);
  });

  it("leaves un-resolvable @label refs intact", () => {
    const { prompt, chipsForMessage, imageChips } = resolveInlineRefs(
      "use `@notes.txt` and `missing`",
      [],
    );
    expect(prompt).toBe("use `@notes.txt` and `missing`");
    expect(chipsForMessage).toEqual([]);
    expect(imageChips).toEqual([]);
  });

  it("orders images by citation order", () => {
    const i1: ContextChip = { kind: "image", id: "1", mimeType: "image/png", data: "AA", displayLabel: "image: a" };
    const i2: ContextChip = { kind: "image", id: "2", mimeType: "image/png", data: "BB", displayLabel: "image: b" };
    const { imageChips, prompt } = resolveInlineRefs("`image: b` then `image: a`", [i1, i2]);
    expect(imageChips.map((c) => c.id)).toEqual(["2", "1"]);
    expect(prompt).toContain("[Image ref: image: b]");
    expect(prompt).toContain("[Image ref: image: a]");
  });

});
