export function extractPlainText(buffer: Buffer): string {
  // Strip UTF-8 BOM if present
  let start = 0;
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    start = 3;
  }
  return buffer.slice(start).toString("utf8");
}
