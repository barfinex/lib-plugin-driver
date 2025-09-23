import { Injectable, Logger } from '@nestjs/common';
import type { PluginInterface } from '@barfinex/types';

@Injectable()
export class PluginDriverService {
  private readonly logger = new Logger(PluginDriverService.name);
  private plugins: PluginInterface[] = [];

  register(plugins: PluginInterface[]) {
    this.logger.log(`Registering ${plugins.length} plugins`);
    this.plugins.push(...plugins);
  }

  /** Новый метод: регистрация класса (сервиса), а не готового инстанса */
  createAndRegister<T extends PluginInterface>(Cls: new (...args: any[]) => T): T {
    const instance = new Cls(); // ⚠️ только если без зависимостей!
    this.register([instance]);
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
  ): T | undefined {
    return this.plugins.find((p: any) => {
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
  async asyncReduce(hook: string, context: any, payload?: any) {
    for (const plugin of this.plugins) {
      if (typeof (plugin as any)[hook] === 'function') {
        await (plugin as any)[hook](context, payload);
      }
    }
  }
}
