export interface Notifier {
  info(title: string, message?: string): void;
  warn(title: string, message?: string): void;
  /** 错误级:应原生弹窗(不受面板可见性/通知开关约束)。 */
  error(title: string, message?: string): void;
}

export class NoopNotifier implements Notifier {
  info(_title: string, _message?: string): void {}
  warn(_title: string, _message?: string): void {}
  error(_title: string, _message?: string): void {}
}

export class VscodeNotifier implements Notifier {
  constructor(
    private readonly show: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    },
  ) {}
  info(title: string, message?: string): void {
    this.show.info(message ? `${title}: ${message}` : title);
  }
  warn(title: string, message?: string): void {
    this.show.warn(message ? `${title}: ${message}` : title);
  }
  error(title: string, message?: string): void {
    this.show.error(message ? `${title}: ${message}` : title);
  }
}
