import { describe, it, expect } from "vitest";
import { acceptImages } from "../src/context/imageAttach";
import { classifyAttachFile } from "../src/context/fileClassify";

describe("context", () => {
  it("accepts a valid png image", () => {
    const data = Buffer.from("pngbytes").toString("base64");
    const { accepted, errors } = acceptImages(0, [{ mimeType: "image/png", data }], () => "id1");
    expect(accepted).toHaveLength(1);
    expect(accepted[0].kind).toBe("image");
    expect(errors).toEqual([]);
  });
  it("rejects unsupported image types", () => {
    const { accepted, errors } = acceptImages(0, [{ mimeType: "image/bmp", data: "AAA=" }], () => "id");
    expect(accepted).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });
  it("classifies files by extension", () => {
    expect(classifyAttachFile("a.png", "image/png")).toBe("image");
    expect(classifyAttachFile("a.pdf", "application/pdf")).toBe("document");
    expect(classifyAttachFile("a.bin", "application/octet-stream")).toBe("unsupported");
  });
});
