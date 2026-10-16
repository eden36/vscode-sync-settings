import { PluginConfiguration } from './types';

const STARTUP_SYNC_DELAY_MS = 1_500;

export interface SyncSchedulesOptions {
  fingerprint: () => Promise<string>;
  /** 远端是否可能有新内容；为否时远程轮询不发起整轮同步。探测失败按有变化处理。 */
  remoteChanged: () => Promise<boolean>;
  isLeader: () => boolean;
  isEnabled: () => boolean;
  configuration: () => PluginConfiguration;
  requestSync: (source: 'timer' | 'startup') => void;
  reportError: (message: string) => void;
}

/**
 * 触发同步的全部定时器：本机指纹检测、远端轮询、启动后的首轮、失败后的重试。
 * 只负责到点发出同步请求，要不要真的开跑由调度层决定。
 */
export class SyncSchedules {
  private localTimer: NodeJS.Timeout | undefined;
  private remoteTimer: NodeJS.Timeout | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private localFingerprint: string | undefined;
  private localCheckRunning = false;
  private remoteCheckRunning = false;
  /** start 中途要等一次指纹计算，期间若又被 stop 或重新 start，旧的那次必须作废。 */
  private generation = 0;

  public constructor(private readonly options: SyncSchedulesOptions) {}

  public async start(): Promise<void> {
    this.stop();
    if (!this.options.isLeader() || !this.options.isEnabled()) return;
    const generation = this.generation;
    this.localFingerprint = await this.options.fingerprint();
    if (!this.options.isLeader() || generation !== this.generation) return;

    const configuration = this.options.configuration();
    this.localTimer = setInterval(() => {
      if (this.localCheckRunning || !this.options.isLeader()) return;
      this.localCheckRunning = true;
      void (async () => {
        try {
          const current = await this.options.fingerprint();
          if (current !== this.localFingerprint) {
            this.localFingerprint = current;
            this.options.requestSync('timer');
          }
        } catch (error) {
          // 指纹读取失败不升级为同步失败：下个周期会重试，但要留下可见原因。
          this.options.reportError(`本机配置检测失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.localCheckRunning = false;
        }
      })();
    }, configuration.debounceSeconds * 1_000);
    // 备份模式不写回本机，远端轮询拉不出任何要应用的变化，只会空转并占用独占锁。
    if (configuration.mode === 'sync') {
      this.remoteTimer = setInterval(() => void this.checkRemote(), configuration.pollIntervalSeconds * 1_000);
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.options.requestSync('startup');
    }, STARTUP_SYNC_DELAY_MS);
  }

  /** 停掉周期性的定时器；排下的重试由调度层单独决定是否撤销。 */
  public stop(): void {
    this.generation += 1;
    if (this.localTimer) clearInterval(this.localTimer);
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.localTimer = undefined;
    this.remoteTimer = undefined;
    this.startupTimer = undefined;
  }

  public scheduleRetry(delayMs: number): void {
    this.cancelRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.options.requestSync('timer');
    }, delayMs);
  }

  public cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** 只接收本轮实际处理过的指纹，轮后采集当前状态会吞掉尚未同步的新改动。 */
  public acceptFingerprint(fingerprint: string): void {
    this.localFingerprint = fingerprint;
  }

  public dispose(): void {
    this.stop();
    this.cancelRetry();
  }

  /**
   * 远程轮询先用一次 ls-remote 探测，远端没动就不跑整轮：整轮要采集快照、起十几个 Git 进程并抢独占锁。
   * 本机改动由指纹检测负责，这里只关心远端。
   */
  private async checkRemote(): Promise<void> {
    if (this.remoteCheckRunning || !this.options.isLeader()) return;
    this.remoteCheckRunning = true;
    try {
      const changed = await this.options.remoteChanged().catch(() => true);
      if (changed && this.options.isLeader()) this.options.requestSync('timer');
    } finally {
      this.remoteCheckRunning = false;
    }
  }
}
