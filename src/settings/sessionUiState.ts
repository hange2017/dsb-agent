export type SessionInterrupted = { sessionId: string; at: number };

export interface SessionUiState {
  getLastSessionId(): string | undefined;
  setLastSessionId(id: string | undefined): void;
  getInterrupted(): SessionInterrupted | undefined;
  setInterrupted(v: SessionInterrupted | undefined): void;
  /** 返回绑定到指定 projectKey 的隔离实例(多项目互不串扰)。 */
  scoped(projectKey: string): SessionUiState;
}

/** 无 projectKey 的根实例:读写无前缀 key,`scoped(key)` 派生子实例。 */
export class MemorySessionUiState implements SessionUiState {
  private mLastSessionId: string | undefined;
  private mInterrupted: SessionInterrupted | undefined;
  private readonly legacy: MemorySessionUiState | undefined;
  private readonly prefix: string;

  constructor(prefix: string = "", legacy?: MemorySessionUiState) {
    this.prefix = prefix;
    this.legacy = legacy;
  }

  scoped(projectKey: string): SessionUiState {
    // 子实例共享同一份 legacy 根(回退链一致)
    return new MemorySessionUiState(projectKey, this.legacy ?? this);
  }

  getLastSessionId(): string | undefined {
    if (this.prefix && this.mLastSessionId === undefined) {
      return this.legacy?.getLastSessionId();
    }
    return this.mLastSessionId;
  }

  setLastSessionId(id: string | undefined): void {
    this.mLastSessionId = id;
  }

  getInterrupted(): SessionInterrupted | undefined {
    if (this.prefix && this.mInterrupted === undefined) {
      return this.legacy?.getInterrupted();
    }
    return this.mInterrupted;
  }

  setInterrupted(v: SessionInterrupted | undefined): void {
    this.mInterrupted = v;
  }
}

type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
};

export class VscodeSessionUiState implements SessionUiState {
  private static readonly KEY_LAST_SESSION_ID = "dsbAgent.lastSessionId";
  private static readonly KEY_SESSION_INTERRUPTED = "dsbAgent.sessionInterrupted";

  private readonly prefix: string;

  constructor(
    private readonly globalState: MementoLike,
    projectKey?: string,
  ) {
    this.prefix = projectKey ? `.${projectKey}` : "";
  }

  scoped(projectKey: string): SessionUiState {
    return new VscodeSessionUiState(this.globalState, projectKey);
  }

  private lastKey(): string {
    return `${VscodeSessionUiState.KEY_LAST_SESSION_ID}${this.prefix}`;
  }

  private interruptedKey(): string {
    return `${VscodeSessionUiState.KEY_SESSION_INTERRUPTED}${this.prefix}`;
  }

  getLastSessionId(): string | undefined {
    const scoped = this.globalState.get<string>(this.lastKey());
    if (scoped !== undefined) return scoped;
    // 升级兼容:无前缀旧 key 作为回退(旧会话已被迁移到当前项目目录,id 不变仍可恢复)
    return this.prefix
      ? this.globalState.get<string>(VscodeSessionUiState.KEY_LAST_SESSION_ID)
      : scoped;
  }

  setLastSessionId(id: string | undefined): void {
    this.globalState.update(this.lastKey(), id);
  }

  getInterrupted(): SessionInterrupted | undefined {
    const scoped = this.globalState.get<SessionInterrupted>(this.interruptedKey());
    if (scoped !== undefined) return scoped;
    return this.prefix
      ? this.globalState.get<SessionInterrupted>(VscodeSessionUiState.KEY_SESSION_INTERRUPTED)
      : scoped;
  }

  setInterrupted(v: SessionInterrupted | undefined): void {
    this.globalState.update(this.interruptedKey(), v);
  }
}
