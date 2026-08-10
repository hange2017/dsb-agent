export async function extractPdfText(buffer: Buffer): Promise<string> {
  // Classic pdf-parse 1.x (pure JS); avoid 2.x @napi-rs/canvas native addon.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse") as (
    data: Buffer,
  ) => Promise<{ text?: string }>;
  const result = await pdfParse(buffer);
  return (result.text ?? "").trim();
}
