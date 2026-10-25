import { currentCallerName } from "./linear-usage";

// Every daemon request the plugin makes, counted per caller and request kind. The Paseo API is
// metered once at the boundary, so a new loop cannot forget to account for its requests.
export type DaemonUsageWindow = {
  sinceMs: number;
  untilMs: number;
  total: number;
  byCaller: Record<string, Record<string, number>>;
};

export type DaemonUsageOptions = { now?: () => number };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function thenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

// A listing that asks for archived agents is its own request kind: it costs the daemon more and
// only all() paths send it.
function archivedListing(args: readonly unknown[]): boolean {
  const first = args[0];
  return object(first) && object(first.filter) && first.filter.includeArchived === true;
}

export class DaemonUsage {
  private readonly now: () => number;
  private since: number;
  private counts = new Map<string, Map<string, number>>();
  private readonly proxies = new WeakMap<object, object>();

  constructor(options: DaemonUsageOptions = {}) {
    this.now = options.now ?? Date.now;
    this.since = this.now();
  }

  meter<T extends object>(target: T): T {
    return this.metered(target, "") as T;
  }

  drain(): DaemonUsageWindow {
    const sinceMs = this.since;
    const untilMs = this.now();
    const byCaller: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const [caller, kinds] of this.counts) {
      const counts: Record<string, number> = {};
      for (const [kind, count] of kinds) {
        counts[kind] = count;
        total += count;
      }
      byCaller[caller] = counts;
    }
    this.counts = new Map();
    this.since = untilMs;
    return { sinceMs, untilMs, total, byCaller };
  }

  private metered(target: object, path: string): object {
    const cached = this.proxies.get(target);
    if (cached) return cached;
    const proxy = new Proxy(target, {
      get: (source, property) => {
        // Read through the target, not the proxy: getters and methods with #private fields must
        // see the class's own instance.
        const value = Reflect.get(source, property, source);
        if (typeof property !== "string") return value;
        // A proxy may not substitute a frozen property's value (Proxy invariant: TypeError).
        const own = Object.getOwnPropertyDescriptor(source, property);
        if (own && !own.configurable && !own.writable && "value" in own) return value;
        const name = path ? `${path}.${property}` : property;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const result: unknown = Reflect.apply(value, source, args);
            if (thenable(result)) {
              // A sent request is counted even if the daemon never answers it.
              this.count(archivedListing(args) ? `${name}[archived]` : name);
              return result;
            }
            return typeof result === "object" && result !== null ? this.metered(result, `${name}()`) : result;
          };
        }
        return typeof value === "object" && value !== null ? this.metered(value, name) : value;
      },
    });
    this.proxies.set(target, proxy);
    // Metering a metered object again (index.server.ts meters each hook's daemon, then attach()
    // meters it once more) returns it as is: a second layer would count every request twice and
    // make each hook look like a new daemon, which re-attaches the agent directory and drops its
    // archived index.
    this.proxies.set(proxy, proxy);
    return proxy;
  }

  private count(kind: string): void {
    const caller = currentCallerName() ?? "unattributed";
    const kinds = this.counts.get(caller) ?? new Map<string, number>();
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    this.counts.set(caller, kinds);
  }
}

// The hourly line: the window's total first, then the callers by count, each with its kinds.
export function daemonUsageLines(window: DaemonUsageWindow, top = 12): string[] {
  if (!window.total) return [];
  const range = `${new Date(window.sinceMs).toISOString()}..${new Date(window.untilMs).toISOString()}`;
  const callers = Object.entries(window.byCaller).map(([caller, kinds]) => ({
    caller,
    total: Object.values(kinds).reduce((sum, count) => sum + count, 0),
    kinds,
  })).sort((a, b) => b.total - a.total || a.caller.localeCompare(b.caller));
  return [
    `[linear-tickets] Daemon usage ${range}: total ${window.total} requests`,
    ...callers.slice(0, top).map(({ caller, total, kinds }) => {
      const detail = Object.entries(kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([kind, count]) => `${kind} ${count}`).join(", ");
      return `[linear-tickets] Daemon usage ${caller}: ${total} requests (${detail})`;
    }),
  ];
}

export const daemonUsage = new DaemonUsage();