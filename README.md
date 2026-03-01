# @barfinex/plugin-driver

**Plugin runtime for the Barfinex ecosystem** — discover, register, and run plugins inside Detector (and other services) with a clear lifecycle and execution context.

Plugins extend detection strategies, analytics, and trade logic without changing core code. This library provides the **driver** that loads plugins, passes context (config, market data, signals), and hooks into NestJS.

---

## What it does

- **Plugin registration** — register plugin modules and their capabilities.
- **Lifecycle** — init, start, stop, and event hooks so plugins integrate with Detector lifecycle.
- **Execution context** — pass config, candles, account state, and signals into plugin code.
- **Extensibility** — used by detector plugins such as `@barfinex/detector-plugin-orderflow-trade-analytics` and `@barfinex/detector-plugin-trade-journal`.

---

## Installation

```sh
npm install @barfinex/plugin-driver
```

---

## What's included

| Export | Purpose |
|--------|--------|
| `PluginDriverModule` | NestJS module for plugin discovery and DI. |
| `PluginDriverService` | Register plugins, run lifecycle, provide execution context. |

---

## Documentation

- **Detector (plugin host)** — [Installation detector](https://barfinex.com/docs/installation-detector) — detector config and plugin list.
- **Barfinex overview** — [First Steps](https://barfinex.com/docs/first-steps), [Architecture](https://barfinex.com/docs/architecture), [Glossary](https://barfinex.com/docs/glossary).
- **Building & APIs** — [Building with the API](https://barfinex.com/docs/frontend-api), [Detector API reference](https://barfinex.com/docs/detector-api), [Typical problems and solutions](https://barfinex.com/docs/troubleshooting).

---

## Contributing

New plugin ideas and driver improvements welcome. Open an issue or PR. Community: [Telegram](https://t.me/barfinex) · [GitHub](https://github.com/barfinex).

---

## License

Licensed under the [Apache License 2.0](LICENSE) with additional terms. Attribution to **Barfin Network Limited** and a link to [https://barfinex.com](https://barfinex.com) are required. See [LICENSE](LICENSE) and the [Barfinex site](https://barfinex.com) for details.
