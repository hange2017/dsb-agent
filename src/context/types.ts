export type EditorChip = {
  kind: "editor";
  id: string;
  relativePath: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  text: string;
  displayLabel?: string;
};

export type TerminalChip = {
  kind: "terminal";
  id: string;
  terminalName: string;
  cwd?: string;
  text: string;
  capturedAt: string;
  displayLabel?: string;
};

export type FileChip = {
  kind: "file";
  id: string;
  relativePath: string;
  absolutePath: string;
  text: string;
  displayLabel?: string;
};

export type SkillChip = {
  kind: "skill";
  id: string;
  name: string;
  absolutePath: string;
  text: string;
  displayLabel?: string;
};

export type RuleChip = {
  kind: "rule";
  id: string;
  name: string;
  absolutePath: string;
  text: string;
  displayLabel?: string;
};

export type ImageChip = {
  kind: "image";
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Raw base64 without data: URL prefix */
  data: string;
  fileName?: string;
  width?: number;
  height?: number;
  displayLabel?: string;
};

export type DocumentChip = {
  kind: "document";
  id: string;
  fileName: string;
  mimeType: string;
  /** Extracted text, already truncated for prompt use */
  text: string;
  byteSize?: number;
  truncated?: boolean;
  displayLabel?: string;
};

export type ContextChip =
  | EditorChip
  | TerminalChip
  | FileChip
  | SkillChip
  | RuleChip
  | ImageChip
  | DocumentChip;
