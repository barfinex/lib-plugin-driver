import { Injectable, Logger } from '@nestjs/common';
import type { PluginCapabilities, PluginInterface } from '@barfinex/types';

interface PluginRuntimeEntry {
  id: string;
  plugin: PluginInterface;
  context: any;
  capabilities: Required<PluginCapabilities>;
  cleanupTasks: Set<() => void>;
}

interface UnregisterReport {
  detached: string[];
  failed: string[];
  durationMs: number;
}

interface PluginHealthState {
  detectorKey: string;
  pluginId: string;
  nodeKey: string;
  failureTimestamps: number[];
  forbiddenCapabilityTimestamps: number[];
  forbiddenReason?: string;
  circuitOpen: boolean;
  reason?: string;
  lastLoggedFailureCount: number;
}

interface DisabledPluginState {
  pluginId: string;
  reason: string;
  disabledAt: number;
}

@Injectable()
export class PluginDriverService {
  private readonly logger = new Logger(PluginDriverService.name);
  private readonly registry: Map<string, PluginRuntimeEntry[]> = new Map();
  private readonly disabledRegistry: Map<
    string,
    Map<string, DisabledPluginState>
  > = new Map();
  private readonly hookTimeoutMs = Number(
    process.env.PLUGIN_DRIVER_HOOK_TIMEOUT_MS ?? 5000,
  );
  private readonly pluginHealth = new Map<string, PluginHealthState>();
  private readonly failWindowMs = Number(
    process.env.PLUGIN_FAIL_WINDOW_MS ?? 60_000,
  );
  private readonly failThreshold = Number(
    process.env.PLUGIN_FAIL_THRESHOLD ?? 5,
  );
  private readonly defaultCapabilities: Required<PluginCapabilities> = {
    canReadMarketData: true,
    canEmitSignals: true,
    canExecuteOrders: true,
    canAccessCapitalEngine: true,
    canRegisterEndpoints: true,
  };

  register(plugins: PluginInterface[], key = 'global') {
    if (!this.registry.has(key)) {
      this.registry.set(key, []);
    }
    const bucket = this.registry.get(key)!;
    for (const plugin of plugins) {
      const entry = this.createRuntimeEntry(key, plugin);
      this.clearDisabledPlugin(key, entry.id);
      this.ensurePluginHealthNode(key, entry.id);
      bucket.push(entry);
      if (typeof (plugin as any).onAttach === 'function') {
        void this.runHookWithTimeout({
          stage: 'onAttach',
          pluginId: entry.id,
          key,
          action: () => (plugin as any).onAttach(entry.context),
        }).catch((error) => {
          this.logger.error(
            `[plugin-driver] onAttach failed key=${key} plugin=${
              entry.id
            }: ${this.errorToString(error)}`,
          );
        });
      }
    }
    this.logger.debug(
      `[plugin-driver] register key=${key} count=${plugins.length} total=${bucket.length}`,
    );
  }

  /**
   * Backward-compatible accessor used by detector lifecycle.
   * Returns a shallow copy to protect internal registry integrity.
   */
  getAllPlugins(key = 'global'): PluginInterface[] {
    const entries = this.registry.get(key) ?? [];
    this.logger.debug(
      `[plugin-driver] getAllPlugins key=${key} count=${entries.length}`,
    );
    return entries.map((entry) => entry.plugin);
  }

  /**
   * Alias for callers that expect getPlugins naming.
   */
  getPlugins(key = 'global'): PluginInterface[] {
    return this.getAllPlugins(key);
  }

  /** Новый метод: регистрация класса (сервиса), а не готового инстанса */
  createAndRegister<T extends PluginInterface>(
    Cls: new (...args: any[]) => T,
    key = 'global',
  ): T {
    const instance = new Cls(); // ⚠️ только если без зависимостей!
    this.register([instance], key);
    return instance;
  }

  /**
   * Универсальный поиск плагина:
   * - по имени класса (constructor.name)
   * - по свойству .name (если есть)
   * - по meta.studioGuid
   * - или прямо по классу (findPlugin(MyPluginClass))
   */
  findPlugin<T extends PluginInterface>(
    key: string | (new (...args: any[]) => T),
    registryKey = 'global',
  ): T | undefined {
    return this.getAllPlugins(registryKey).find((p: any) => {
      if (typeof key === 'string') {
        return (
          p.constructor?.name === key ||
          p.name === key ||
          p.meta?.studioGuid === key
        );
      } else {
        return p instanceof key;
      }
    }) as T | undefined;
  }

  /** Вызов хука у всех плагинов */
  async asyncReduce(hook: string, context: any, payload?: any, key = 'global') {
    const entries = [...(this.registry.get(key) ?? [])];
    for (const entry of entries) {
      const plugin = entry.plugin as any;
      if (typeof plugin[hook] !== 'function') continue;
      if (this.isCircuitOpen(key, entry.id)) continue;
      try {
        await plugin[hook](context, payload);
      } catch (error) {
        await this.handlePluginFailure({
          key,
          pluginId: entry.id,
          hook,
          error,
        });
      }
    }
  }

  async unregister(
    key: string,
    pluginId: string,
    options?: { cause?: 'manual' | 'circuit' },
  ): Promise<void> {
    const bucket = this.registry.get(key);
    if (!bucket || bucket.length === 0) return;

    const idx = [...bucket]
      .reverse()
      .findIndex((entry) => entry.id === pluginId);
    if (idx === -1) return;
    const actualIndex = bucket.length - 1 - idx;
    const [entry] = bucket.splice(actualIndex, 1);
    if (!entry) return;

    await this.detachEntry(entry, key, {
      detached: [],
      failed: [],
      durationMs: 0,
    });
    if (bucket.length === 0) {
      this.registry.delete(key);
    }

    const cause = options?.cause ?? 'manual';
    if (cause === 'circuit') {
      const state = this.ensurePluginHealthNode(key, pluginId);
      state.circuitOpen = true;
      state.reason = 'circuit_open';
      this.markDisabledPlugin(key, pluginId, 'circuit_open');
      this.logger.warn(
        `[plugin-health] detached_due_to_circuit key=${key} plugin=${pluginId}`,
      );
      return;
    }
    this.markDisabledPlugin(key, pluginId, 'manual_disabled');
    this.pluginHealth.delete(this.buildPluginNodeKey(key, pluginId));
  }

  async unregisterAll(key: string): Promise<UnregisterReport> {
    const startedAt = Date.now();
    const report: UnregisterReport = {
      detached: [],
      failed: [],
      durationMs: 0,
    };

    const bucket = this.registry.get(key);
    if (!bucket || bucket.length === 0) {
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    while (bucket.length > 0) {
      const entry = bucket.pop();
      if (!entry) continue;
      await this.detachEntry(entry, key, report);
    }

    this.registry.delete(key);
    for (const detachedPluginId of [...report.detached, ...report.failed]) {
      this.pluginHealth.delete(this.buildPluginNodeKey(key, detachedPluginId));
    }
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  getPluginHealthNodes(): Array<{ key: string; severity: 'soft' }> {
    return Array.from(this.pluginHealth.values()).map((state) => ({
      key: state.nodeKey,
      severity: 'soft' as const,
    }));
  }

  getPluginHealthNodeState(
    nodeKey: string,
  ): { healthy: boolean; reason?: string } | undefined {
    const state = this.pluginHealth.get(nodeKey);
    if (!state) return undefined;
    const now = Date.now();
    state.failureTimestamps = state.failureTimestamps.filter(
      (ts) => now - ts <= this.failWindowMs,
    );
    state.forbiddenCapabilityTimestamps =
      state.forbiddenCapabilityTimestamps.filter(
        (ts) => now - ts <= this.failWindowMs,
      );
    if (state.circuitOpen) {
      return { healthy: false, reason: 'circuit_open' };
    }
    if (state.forbiddenCapabilityTimestamps.length > 0) {
      return {
        healthy: false,
        reason:
          state.forbiddenReason ??
          `forbidden_capability_${state.forbiddenCapabilityTimestamps.length}`,
      };
    }
    if (state.failureTimestamps.length > 0) {
      return {
        healthy: false,
        reason: `failure_count_${state.failureTimestamps.length}`,
      };
    }
    return { healthy: true };
  }

  getRuntimeStateSnapshot(): {
    evaluatedAt: number;
    detectors: Record<
      string,
      {
        activePlugins: Array<{
          pluginId: string;
          meta?: {
            studioGuid?: string;
            title?: string;
            version?: string;
            author?: string;
            visibility?: string;
            pluginApi?: string;
            tags?: string[];
          };
          capabilities: Required<PluginCapabilities>;
          health: { healthy: boolean; reason?: string };
          circuitOpen: boolean;
          lastEvents?: { failureCount: number; forbiddenCount: number };
        }>;
        disabledPlugins: Array<{
          pluginId: string;
          reason: string;
          disabledAt: number;
        }>;
      }
    >;
  } {
    const evaluatedAt = Date.now();
    const detectorKeys = new Set<string>([
      ...this.registry.keys(),
      ...this.disabledRegistry.keys(),
    ]);
    const detectors: Record<
      string,
      {
        activePlugins: Array<{
          pluginId: string;
          meta?: {
            studioGuid?: string;
            title?: string;
            version?: string;
            author?: string;
            visibility?: string;
            pluginApi?: string;
            tags?: string[];
          };
          capabilities: Required<PluginCapabilities>;
          health: { healthy: boolean; reason?: string };
          circuitOpen: boolean;
          lastEvents?: { failureCount: number; forbiddenCount: number };
        }>;
        disabledPlugins: Array<{
          pluginId: string;
          reason: string;
          disabledAt: number;
        }>;
      }
    > = {};

    for (const detectorKey of detectorKeys) {
      const entries = this.registry.get(detectorKey) ?? [];
      const activePlugins = entries.map((entry) => {
        const nodeKey = this.buildPluginNodeKey(detectorKey, entry.id);
        const health = this.getPluginHealthNodeState(nodeKey) ?? {
          healthy: true,
        };
        const state = this.pluginHealth.get(nodeKey);
        return {
          pluginId: entry.id,
          meta: this.sanitizePluginMeta(entry.plugin),
          capabilities: { ...entry.capabilities },
          health,
          circuitOpen: state?.circuitOpen === true,
          lastEvents: state
            ? {
                failureCount: state.failureTimestamps.length,
                forbiddenCount: state.forbiddenCapabilityTimestamps.length,
              }
            : undefined,
        };
      });

      const disabledPlugins = Array.from(
        this.disabledRegistry.get(detectorKey)?.values() ?? [],
      ).map((state) => ({
        pluginId: state.pluginId,
        reason: state.reason,
        disabledAt: state.disabledAt,
      }));

      detectors[detectorKey] = {
        activePlugins,
        disabledPlugins,
      };
    }

    return { evaluatedAt, detectors };
  }

  private createRuntimeEntry(
    key: string,
    plugin: PluginInterface,
  ): PluginRuntimeEntry {
    const cleanupTasks = new Set<() => void>();
    const pluginId = this.resolvePluginId(plugin);
    const pluginLogger = new Logger(
      `${PluginDriverService.name}:${key}:${pluginId}`,
    );
    const capabilities = this.resolvePluginCapabilities(plugin);
    const denyCapability = (
      capability: keyof PluginCapabilities,
      action: string,
    ): void => {
      this.markForbiddenCapabilityAttempt({
        key,
        pluginId,
        capability,
        action,
      });
    };
    const context: any = {
      key,
      logger: {
        log: (...args: unknown[]) =>
          pluginLogger.log(args.map(String).join(' ')),
        error: (...args: unknown[]) =>
          pluginLogger.error(args.map(String).join(' ')),
        warn: (...args: unknown[]) =>
          pluginLogger.warn(args.map(String).join(' ')),
        debug: (...args: unknown[]) =>
          pluginLogger.debug(args.map(String).join(' ')),
        verbose: (...args: unknown[]) =>
          pluginLogger.verbose(args.map(String).join(' ')),
      },
      config: (plugin as any).options ?? {},
      trackInterval: <T>(factory: () => T): T => {
        const handle = factory();
        cleanupTasks.add(() => clearInterval(handle as any));
        return handle;
      },
      trackTimeout: <T>(factory: () => T): T => {
        const handle = factory();
        cleanupTasks.add(() => clearTimeout(handle as any));
        return handle;
      },
      trackSubscription: <T>(subscription: T): T => {
        cleanupTasks.add(() => {
          const target = subscription as any;
          if (typeof target?.unsubscribe === 'function') target.unsubscribe();
          else if (typeof target?.dispose === 'function') target.dispose();
          else if (typeof target?.close === 'function') target.close();
          else if (typeof target?.destroy === 'function') target.destroy();
        });
        return subscription;
      },
      trackListener: <
        T extends {
          on?: (...args: unknown[]) => unknown;
          off?: (...args: unknown[]) => unknown;
          addListener?: (...args: unknown[]) => unknown;
          removeListener?: (...args: unknown[]) => unknown;
        },
      >(
        emitter: T,
        event: string | symbol,
        handler: (...args: unknown[]) => void,
      ): T => {
        if (typeof emitter.on === 'function') emitter.on(event, handler);
        else if (typeof emitter.addListener === 'function')
          emitter.addListener(event, handler);

        cleanupTasks.add(() => {
          if (typeof emitter.off === 'function') emitter.off(event, handler);
          else if (typeof emitter.removeListener === 'function') {
            emitter.removeListener(event, handler);
          }
        });
        return emitter;
      },
      findPlugin: <T extends PluginInterface>(name: string): T =>
        this.findPlugin<T>(name, key) as T,
      detectorContext: {
        name: 'plugin-driver',
        options: {} as any,
        account: {} as any,
        candles: {},
        orders: [],
      },
      emitSignal: (_signal: unknown) => {
        if (!capabilities.canEmitSignals) {
          denyCapability('canEmitSignals', 'emit_signal');
          return;
        }
      },
      executeOrder: async (_order: unknown) => {
        if (!capabilities.canExecuteOrders) {
          denyCapability('canExecuteOrders', 'execute_order');
          return null;
        }
        return null;
      },
      accessCapitalEngine: () => {
        if (!capabilities.canAccessCapitalEngine) {
          denyCapability('canAccessCapitalEngine', 'access_capital_engine');
          return null;
        }
        return null;
      },
      registerEndpoint: (_definition: unknown) => {
        if (!capabilities.canRegisterEndpoints) {
          denyCapability('canRegisterEndpoints', 'register_endpoint');
          return false;
        }
        return true;
      },
      tradingOperation: {
        closeAll: async () => [],
      },
    };
    context.tradingOperation.closeAll = async () => {
      if (!capabilities.canExecuteOrders) {
        denyCapability('canExecuteOrders', 'close_all_orders');
        return [];
      }
      return [];
    };

    return {
      id: pluginId,
      plugin,
      context,
      capabilities,
      cleanupTasks,
    };
  }

  private async detachEntry(
    entry: PluginRuntimeEntry,
    key: string,
    report: UnregisterReport,
  ): Promise<void> {
    try {
      if (typeof (entry.plugin as any).onDetach === 'function') {
        await this.runHookWithTimeout({
          stage: 'onDetach',
          pluginId: entry.id,
          key,
          action: () => (entry.plugin as any).onDetach(entry.context),
        });
      }
      report.detached.push(entry.id);
    } catch (error) {
      report.failed.push(entry.id);
      this.logger.error(
        `[plugin-driver] onDetach failed key=${key} plugin=${
          entry.id
        }: ${this.errorToString(error)}`,
      );
    } finally {
      for (const cleanup of entry.cleanupTasks) {
        try {
          cleanup();
        } catch (cleanupError) {
          this.logger.warn(
            `[plugin-driver] cleanup failed key=${key} plugin=${
              entry.id
            }: ${this.errorToString(cleanupError)}`,
          );
        }
      }
      entry.cleanupTasks.clear();
    }
  }

  private buildPluginNodeKey(key: string, pluginId: string): string {
    return `plugin:${key}:${pluginId}`;
  }

  private ensurePluginHealthNode(
    key: string,
    pluginId: string,
  ): PluginHealthState {
    const nodeKey = this.buildPluginNodeKey(key, pluginId);
    const existing = this.pluginHealth.get(nodeKey);
    if (existing) return existing;
    const created: PluginHealthState = {
      detectorKey: key,
      pluginId,
      nodeKey,
      failureTimestamps: [],
      forbiddenCapabilityTimestamps: [],
      forbiddenReason: undefined,
      circuitOpen: false,
      reason: undefined,
      lastLoggedFailureCount: 0,
    };
    this.pluginHealth.set(nodeKey, created);
    return created;
  }

  private markDisabledPlugin(
    key: string,
    pluginId: string,
    reason: string,
  ): void {
    if (!this.disabledRegistry.has(key)) {
      this.disabledRegistry.set(key, new Map());
    }
    this.disabledRegistry.get(key)!.set(pluginId, {
      pluginId,
      reason,
      disabledAt: Date.now(),
    });
  }

  private clearDisabledPlugin(key: string, pluginId: string): void {
    const bucket = this.disabledRegistry.get(key);
    if (!bucket) return;
    bucket.delete(pluginId);
    if (bucket.size === 0) {
      this.disabledRegistry.delete(key);
    }
  }

  private isCircuitOpen(key: string, pluginId: string): boolean {
    const state = this.pluginHealth.get(this.buildPluginNodeKey(key, pluginId));
    return state?.circuitOpen === true;
  }

  private async handlePluginFailure(input: {
    key: string;
    pluginId: string;
    hook: string;
    error: unknown;
  }): Promise<void> {
    const { key, pluginId, hook, error } = input;
    const now = Date.now();
    const state = this.ensurePluginHealthNode(key, pluginId);
    state.failureTimestamps = state.failureTimestamps.filter(
      (ts) => now - ts <= this.failWindowMs,
    );
    const previousCount = state.failureTimestamps.length;
    state.failureTimestamps.push(now);
    const count = state.failureTimestamps.length;
    state.reason = `hook:${hook}`;

    if (
      count > previousCount &&
      (count === 1 || count === this.failThreshold)
    ) {
      state.lastLoggedFailureCount = count;
      this.logger.warn(
        `[plugin-health] failure key=${key} plugin=${pluginId} count=${count} hook=${hook} error=${this.errorToString(
          error,
        )}`,
      );
    }

    if (!state.circuitOpen && count >= this.failThreshold) {
      state.circuitOpen = true;
      state.reason = 'circuit_open';
      this.logger.error(
        `[plugin-health] circuit_open key=${key} plugin=${pluginId}`,
      );
      await this.unregister(key, pluginId, { cause: 'circuit' });
    }
  }

  private resolvePluginCapabilities(
    plugin: PluginInterface,
  ): Required<PluginCapabilities> {
    const requested = (plugin as any)?.meta?.capabilities as
      | PluginCapabilities
      | undefined;
    return {
      canReadMarketData:
        requested?.canReadMarketData ??
        this.defaultCapabilities.canReadMarketData,
      canEmitSignals:
        requested?.canEmitSignals ?? this.defaultCapabilities.canEmitSignals,
      canExecuteOrders:
        requested?.canExecuteOrders ??
        this.defaultCapabilities.canExecuteOrders,
      canAccessCapitalEngine:
        requested?.canAccessCapitalEngine ??
        this.defaultCapabilities.canAccessCapitalEngine,
      canRegisterEndpoints:
        requested?.canRegisterEndpoints ??
        this.defaultCapabilities.canRegisterEndpoints,
    };
  }

  private sanitizePluginMeta(plugin: PluginInterface):
    | {
        studioGuid?: string;
        title?: string;
        version?: string;
        author?: string;
        visibility?: string;
        pluginApi?: string;
        tags?: string[];
      }
    | undefined {
    const meta = (plugin as any)?.meta;
    if (!meta || typeof meta !== 'object') return undefined;
    return {
      studioGuid:
        typeof meta.studioGuid === 'string' ? meta.studioGuid : undefined,
      title: typeof meta.title === 'string' ? meta.title : undefined,
      version: typeof meta.version === 'string' ? meta.version : undefined,
      author: typeof meta.author === 'string' ? meta.author : undefined,
      visibility:
        typeof meta.visibility === 'string' ? meta.visibility : undefined,
      pluginApi:
        typeof meta.pluginApi === 'string' ? meta.pluginApi : undefined,
      tags: Array.isArray(meta.tags)
        ? meta.tags.filter((tag: unknown) => typeof tag === 'string')
        : undefined,
    };
  }

  private markForbiddenCapabilityAttempt(input: {
    key: string;
    pluginId: string;
    capability: keyof PluginCapabilities;
    action: string;
  }): void {
    const { key, pluginId, capability, action } = input;
    const now = Date.now();
    const state = this.ensurePluginHealthNode(key, pluginId);
    state.forbiddenCapabilityTimestamps =
      state.forbiddenCapabilityTimestamps.filter(
        (ts) => now - ts <= this.failWindowMs,
      );
    state.forbiddenCapabilityTimestamps.push(now);
    state.forbiddenReason = `forbidden_capability:${String(capability)}`;
    this.logger.warn(
      `[plugin-capability] ${JSON.stringify({
        key,
        pluginId,
        action,
        capability,
        allowed: false,
      })}`,
    );
  }

  private resolvePluginId(plugin: PluginInterface): string {
    const candidate =
      (plugin as any).name ||
      (plugin as any)?.meta?.studioGuid ||
      plugin.constructor?.name;
    return String(candidate || 'unknown-plugin');
  }

  private async runHookWithTimeout(input: {
    stage: 'onAttach' | 'onDetach';
    pluginId: string;
    key: string;
    action: () => void | Promise<void>;
  }): Promise<void> {
    const { stage, pluginId, key, action } = input;
    await Promise.race([
      Promise.resolve(action()),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(
            new Error(
              `[plugin-driver] ${stage} timeout key=${key} plugin=${pluginId} timeoutMs=${this.hookTimeoutMs}`,
            ),
          );
        }, this.hookTimeoutMs),
      ),
    ]);
  }

  private errorToString(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
