import { PluginDriverService } from './plugin-driver.service';

function createPlugin(
  name: string,
  overrides?: Partial<Record<string, unknown>>,
): any {
  return {
    name,
    api: {},
    meta: {
      title: name,
      version: '1.0.0',
      visibility: 'private',
      ...(overrides?.meta as Record<string, unknown> | undefined),
    },
    ...overrides,
  };
}

describe('PluginDriverService runtime invariants', () => {
  const envBackup = {
    PLUGIN_FAIL_THRESHOLD: process.env.PLUGIN_FAIL_THRESHOLD,
    PLUGIN_FAIL_WINDOW_MS: process.env.PLUGIN_FAIL_WINDOW_MS,
  };

  afterEach(() => {
    if (envBackup.PLUGIN_FAIL_THRESHOLD === undefined) {
      delete process.env.PLUGIN_FAIL_THRESHOLD;
    } else {
      process.env.PLUGIN_FAIL_THRESHOLD = envBackup.PLUGIN_FAIL_THRESHOLD;
    }
    if (envBackup.PLUGIN_FAIL_WINDOW_MS === undefined) {
      delete process.env.PLUGIN_FAIL_WINDOW_MS;
    } else {
      process.env.PLUGIN_FAIL_WINDOW_MS = envBackup.PLUGIN_FAIL_WINDOW_MS;
    }
  });

  it('keeps keyed plugin registries isolated', () => {
    const service = new PluginDriverService();
    const pluginA = createPlugin('PluginA');
    const pluginB = createPlugin('PluginB');

    service.register([pluginA], 'A');
    service.register([pluginB], 'B');

    expect(
      service.getAllPlugins('A').map((plugin: any) => plugin.name),
    ).toEqual(['PluginA']);
    expect(
      service.getAllPlugins('B').map((plugin: any) => plugin.name),
    ).toEqual(['PluginB']);
  });

  it('detaches plugins in LIFO order on unregisterAll', async () => {
    const service = new PluginDriverService();
    const onDetachA = jest.fn(async () => undefined);
    const onDetachB = jest.fn(async () => undefined);
    const pluginA = createPlugin('PluginA', { onDetach: onDetachA });
    const pluginB = createPlugin('PluginB', { onDetach: onDetachB });

    service.register([pluginA, pluginB], 'detector:lifo');
    const report = await service.unregisterAll('detector:lifo');

    expect(report.detached).toEqual(['PluginB', 'PluginA']);
    expect(onDetachB).toHaveBeenCalledTimes(1);
    expect(onDetachA).toHaveBeenCalledTimes(1);
  });

  it('opens circuit and unregisters plugin after threshold failures', async () => {
    process.env.PLUGIN_FAIL_THRESHOLD = '3';
    process.env.PLUGIN_FAIL_WINDOW_MS = '60000';
    const service = new PluginDriverService();
    const failingPlugin = createPlugin('CircuitPlugin', {
      onCandleUpdate: jest.fn(async () => {
        throw new Error('boom');
      }),
    });

    service.register([failingPlugin], 'detector:circuit');
    for (let i = 0; i < 3; i += 1) {
      await service.asyncReduce(
        'onCandleUpdate',
        {},
        { symbol: { symbol: 'BTCUSDT' } },
        'detector:circuit',
      );
    }

    expect(service.getAllPlugins('detector:circuit')).toHaveLength(0);
    expect(
      service.getPluginHealthNodeState('plugin:detector:circuit:CircuitPlugin'),
    ).toEqual({
      healthy: false,
      reason: 'circuit_open',
    });
  });

  it('degrades plugin health on forbidden capability usage without throwing', async () => {
    const service = new PluginDriverService();
    const forbiddenPlugin = createPlugin('ForbiddenPlugin', {
      meta: {
        title: 'ForbiddenPlugin',
        version: '1.0.0',
        visibility: 'private',
        capabilities: { canExecuteOrders: false },
      },
      onAttach: jest.fn(async (ctx: any) => {
        await ctx.executeOrder?.({ symbol: 'BTCUSDT' });
      }),
    });

    service.register([forbiddenPlugin], 'detector:forbidden');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = service.getPluginHealthNodeState(
      'plugin:detector:forbidden:ForbiddenPlugin',
    );
    expect(state?.healthy).toBe(false);
    expect(state?.reason).toContain('forbidden_capability');
  });
});
