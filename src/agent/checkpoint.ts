import * as fs from "fs";
import * as path from "path";

/** 同一文件保留的快照份数,超出按旧→新删除。 */
const KEEP = 10;

/** 快照文件名中的时间戳前缀位数(`Date`/hrtime 补零后固定位数,保证字典序 = 时间序)。 */
const STAMP_LEN = 20;

/** 快照内容哨兵:原文件当时不存在(全新文件)的快照,restore 时删除目标文件而非写入内容。 */
const ABSENT = "__DSB_CHECKPOINT_ABSENT__\n";

/**
 * 把原文件相对工作区的路径可逆编码进快照文件名,让 /rewind 能从快照目录还原真实
 * 文件路径,并区分同名不同目录的文件(仅按 basename 会碰撞)。
 * 使用 encodeURIComponent:对任意字符串是双射,文件名合法,`/` 变为 `%2F`。
 */
function encodeRel(rel: string): string {
  return encodeURIComponent(rel);
}

function decodeRel(stem: string): string {
  return decodeURIComponent(stem);
}

/**
 * 快照文件名是否属于给定 key(严格匹配,而非 endsWith)。encodeURIComponent 不转义 `-`,
 * 若用 `endsWith("-" + key)`,`unit-test.ts` 的快照会误配 key `test.ts`;这里按
 * 固定 20 位时间戳 + `-` + key 精确比对,只有同 key 的快照才命中。
 */
function isSnapshotFor(filename: string, key: string): boolean {
  return filename.length === STAMP_LEN + 1 + key.length && filename.slice(STAMP_LEN + 1) === key;
}

/**
 * 文件 checkpoint / rewind 存储。编辑(Write/StrReplace/Delete)前把原文件内容以
 * `时间戳-原路径` 快照平铺到 `<root>/.dsb/checkpoints/<sessionId>/` 目录(会话级
 * 隐藏点目录,避免在用户 git status 产生未跟踪文件),同一文件保留最近 KEEP 份;
 * `/rewind` 命令据此把文件恢复到最近一份快照。全新文件(快照时不存在)会写入 ABSENT
 * 哨兵快照,restore 时删除目标文件,从而支持撤销对新建文件的 Write。
 *
 * 接口按 brief 的说明:`snapshot`/`list`/`restore` 接收**绝对路径**(checkpoint
 * 需要真实文件路径),`restore` 未指定快照时恢复最近一份。
 *
 * 注意:`.dsb` 仍会被 Glob/Grep/LS 遍历(工具无隐藏目录过滤),这里只解决 git
 * 污染与可识别性问题,不改变 M1 工具语义。
 */
export class CheckpointStore {
  private readonly root: string;
  private readonly dir: string;

  constructor(root: string, sessionId: string) {
    this.root = root;
    this.dir = path.join(root, ".dsb", "checkpoints", sessionId);
  }

  private relOf(absPath: string): string {
    return path.relative(this.root, absPath);
  }

  /** 单调递增、同长度零填充的时间戳前缀,保证快照按字符串排序即按时间排序。 */
  private stamp(): string {
    return String(process.hrtime.bigint()).padStart(STAMP_LEN, "0");
  }

  /** 编辑前快照:把 absPath 当前内容写入会话目录。目录/读取失败时静默 no-op;文件不存在时记录 ABSENT 哨兵(可撤销新建文件)。 */
  snapshot(absPath: string): void {
    const key = encodeRel(this.relOf(absPath));
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(path.join(this.dir, `${this.stamp()}-${key}`), ABSENT, "utf8");
      this.prune(key);
      return;
    }
    let content: string;
    try {
      if (fs.statSync(absPath).isDirectory()) return;
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      return; // 读取失败不阻断编辑
    }
    fs.writeFileSync(path.join(this.dir, `${this.stamp()}-${key}`), content, "utf8");
    this.prune(key);
  }

  /** 该文件(按原路径)的快照路径列表,新→旧。 */
  list(absPath: string): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const key = encodeRel(this.relOf(absPath));
    return fs
      .readdirSync(this.dir)
      .filter((f) => isSnapshotFor(f, key))
      .sort()
      .reverse()
      .map((f) => path.join(this.dir, f));
  }

  /** 恢复最近一份快照到原路径并删除该快照;指定 snapshot 时恢复它。无快照时静默 no-op。 */
  restore(absPath: string, snapshot?: string): void {
    const snaps = this.list(absPath);
    if (snaps.length === 0) return;
    const chosen = snapshot && snaps.includes(snapshot) ? snapshot : snaps[0];
    const content = fs.readFileSync(chosen, "utf8");
    if (content === ABSENT) {
      // 快照时文件不存在:撤销新建文件的 Write → 删除目标文件
      fs.rmSync(absPath, { force: true });
    } else {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf8");
    }
    fs.rmSync(chosen, { force: true });
  }

  /** 当前会话有快照的原文件路径列表,按快照数量降序。供 /rewind 枚举候选。 */
  files(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const counts = new Map<string, number>();
    for (const f of fs.readdirSync(this.dir)) {
      const sep = f.indexOf("-");
      if (sep <= 0) continue;
      let rel: string;
      try {
        rel = decodeRel(f.slice(sep + 1));
      } catch {
        continue; // 无法解码的脏文件名跳过
      }
      const abs = path.join(this.root, rel);
      counts.set(abs, (counts.get(abs) ?? 0) + 1);
    }
    return [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  }

  /** 同一文件快照超 KEEP 份时按旧→新删除。 */
  private prune(key: string): void {
    const snaps = fs
      .readdirSync(this.dir)
      .filter((f) => isSnapshotFor(f, key))
      .sort();
    for (let i = 0; i < snaps.length - KEEP; i++) {
      fs.rmSync(path.join(this.dir, snaps[i]), { force: true });
    }
  }
}
