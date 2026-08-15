
/** 平台信息集中:供系统提示词、Bash 描述、executor 共用。 */

export type PlatformInfo = {
  /** OS 展示名,如 "Windows (win32)"。 */
  os: string;
  /** Bash 工具实际使用的 shell。 */
  shell: string;
  /** 路径分隔符。 */
  sep: string;
  /** 命令风格指引(注入提示词)。 */
  commandStyle: string;
  /** 是否 POSIX 风格(Linux/macOS)。 */
  posix: boolean;
};

export function platformInfo(platform?: NodeJS.Platform): PlatformInfo {
  const p = platform ?? process.platform;
  if (p === "win32") {
    return {
      os: "Windows (win32)",
      shell: "cmd.exe",
      sep: "\\",
      commandStyle: "使用 dir/type/copy 等 Windows 命令;不要使用 ls/cat/rm -rf/$HOME",
      posix: false,
    };
  }
  if (p === "linux") {
    return {
      os: "Linux",
      shell: "/bin/bash",
      sep: "/",
      commandStyle: "使用 ls/cat/grep/rm 等 POSIX 命令;可用 $HOME",
      posix: true,
    };
  }
  if (p === "darwin") {
    return {
      os: "macOS (darwin)",
      shell: "/bin/bash",
      sep: "/",
      commandStyle: "使用 ls/cat/grep/rm 等 POSIX 命令;可用 $HOME",
      posix: true,
    };
  }
  // 未知平台:返回通用信息(不注入提示词段时调用方自行省略)
  return {
    os: String(p),
    shell: "sh",
    sep: "/",
    commandStyle: "使用 POSIX 风格命令",
    posix: true,
  };
}
