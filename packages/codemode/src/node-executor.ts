/**
 * NodeExecutor — an Executor for Node.js hosts (CLI tools, MCP servers,
 * desktop agents) that runs LLM-generated code in a disposable child
 * process instead of a Cloudflare Worker.
 *
 * Isolation is capability-based: the sandbox gets a fresh `vm` context with
 * no `require`, `import`, `process` or filesystem, and can only reach the
 * provider functions it is given. This is not a security boundary against
 * adversarial code — treat it the way you treat a shell tool.
 *
 * Import via the dedicated entry point so Workers bundles never see the
 * Node built-ins:
 *
 * ```ts
 * import { NodeExecutor } from "@cloudflare/codemode/node";
 * ```
 */

import { spawn } from "node:child_process";
import type {
  ExecuteResult,
  Executor,
  ResolvedProvider
} from "./executor-types";
import { normalizeCode } from "./normalize";
import { sanitizeToolName } from "./utils";

export interface NodeExecutorOptions {
  /** Maximum execution time in milliseconds. Defaults to `30000`. */
  timeout?: number;
  /** Node binary used for the sandbox process. Defaults to `process.execPath`. */
  nodePath?: string;
  /** Extra environment variables for the sandbox process. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 30000;
const IDE_TIMEOUT = 10000;

/**
 * Source of the sandbox process. Kept as a string so the package does not
 * need to ship a second entry file; it is passed to `node -e`.
 */
const RUNNER_SOURCE = String.raw`
const vm = require("node:vm");

const logs = [];
function fmt(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}
function capture() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
  logs.push(parts.join(" "));
}

var seq = 0;
var pending = new Map();

function call(provider, fn) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      process.send({
        type: "call",
        id: id,
        provider: provider,
        fn: fn,
        args: args.length <= 1 ? args[0] : args
      });
    });
  };
}

function buildContext(providers) {
  var sandbox = {
    console: {
      log: capture, error: capture, warn: capture,
      info: capture, debug: capture
    },
    JSON: JSON, Math: Math, Date: Date, URL: URL,
    URLSearchParams: URLSearchParams, Buffer: Buffer,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    Promise: Promise, RegExp: RegExp, Map: Map, Set: Set,
    Array: Array, Object: Object, String: String, Number: Number,
    Boolean: Boolean, Error: Error, Symbol: Symbol, Intl: Intl,
    BigInt: BigInt, Proxy: Proxy, Reflect: Reflect,
    structuredClone: structuredClone,
    sleep: function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    },
    log: capture
  };
  for (var i = 0; i < providers.length; i++) {
    var provider = providers[i];
    var ns = {};
    for (var j = 0; j < provider.fns.length; j++) {
      ns[provider.fns[j]] = call(provider.name, provider.fns[j]);
    }
    sandbox[provider.name] = ns;
  }
  return vm.createContext(sandbox, { name: "codemode" });
}

process.on("message", function (message) {
  if (!message) return;

  if (message.type === "call:reply") {
    var entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.value);
    return;
  }

  if (message.type === "run") {
    var context = buildContext(message.providers || []);
    var fn;
    try {
      fn = vm.runInContext("(" + message.code + ")", context, {
        timeout: message.idleTimeout
      });
    } catch (e) {
      process.send({
        type: "result",
        error: (e && e.message) || String(e),
        logs: logs
      });
      return;
    }
    Promise.resolve()
      .then(function () { return fn(); })
      .then(function (result) {
        process.send({ type: "result", result: result, logs: logs });
      })
      .catch(function (e) {
        process.send({
          type: "result",
          error: (e && e.message) || String(e),
          logs: logs
        });
      });
  }
});

process.send({ type: "ready" });
`;

interface RunnerMessage {
  type?: string;
  id?: number;
  provider?: string;
  fn?: string;
  args?: unknown;
  code?: string;
  providers?: Array<{ name: string; fns: string[] }>;
  idleTimeout?: number;
  result?: unknown;
  error?: string;
  logs?: string[];
  value?: unknown;
}

/**
 * Executes LLM-generated code in a disposable Node child process.
 *
 * One process per execution: nothing survives between calls, and a hard
 * timeout kills the process (which also stops runaway async loops that
 * `vm` timeouts cannot interrupt).
 */
export class NodeExecutor implements Executor {
  #timeout: number;
  #nodePath: string;
  #env: Record<string, string>;

  constructor(options?: NodeExecutorOptions) {
    this.#timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.#nodePath = options?.nodePath ?? process.execPath;
    this.#env = options?.env ?? {};
  }

  async execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    let providers: ResolvedProvider[];
    if (!Array.isArray(providersOrFns)) {
      console.warn(
        "[@cloudflare/codemode] Passing raw fns to executor.execute() is deprecated. " +
          "Use ResolvedProvider[] instead. This will be removed in the next major version."
      );
      providers = [{ name: "codemode", fns: providersOrFns }];
    } else {
      providers = providersOrFns;
    }

    const reservedNames = new Set(["__dispatchers", "__logs"]);
    const validIdent = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const seenNames = new Set<string>();
    for (const provider of providers) {
      if (reservedNames.has(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is reserved`
        };
      }
      if (!validIdent.test(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is not a valid JavaScript identifier`
        };
      }
      if (seenNames.has(provider.name)) {
        return {
          result: undefined,
          error: `Duplicate provider name "${provider.name}"`
        };
      }
      seenNames.add(provider.name);
    }

    const resolvedProviders: ResolvedProvider[] = [];
    const providersByName = new Map<string, ResolvedProvider>();
    for (const provider of providers) {
      const sanitizedFns: Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      > = {};
      const sanitizedNames = new Map<string, string>();
      for (const [name, fn] of Object.entries(provider.fns)) {
        const sanitizedName = sanitizeToolName(name);
        const existingName = sanitizedNames.get(sanitizedName);
        if (existingName && existingName !== name) {
          return {
            result: undefined,
            error:
              `Tool names "${existingName}" and "${name}" both sanitize to ` +
              `"${sanitizedName}" in provider "${provider.name}"`
          };
        }
        sanitizedNames.set(sanitizedName, name);
        sanitizedFns[sanitizedName] = fn;
      }
      const resolved: ResolvedProvider = {
        name: provider.name,
        fns: sanitizedFns
      };
      resolvedProviders.push(resolved);
      providersByName.set(provider.name, resolved);
    }

    const manifest = resolvedProviders.map((provider) => ({
      name: provider.name,
      fns: Object.keys(provider.fns)
    }));

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn(this.#nodePath, ["-e", RUNNER_SOURCE], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, ...this.#env },
        windowsHide: true
      });

      let settled = false;

      const finish = (result: ExecuteResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners();
        child.kill("SIGKILL");
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ result: undefined, error: "Execution timed out", logs: [] });
      }, this.#timeout);

      child.on("error", (err: Error) => {
        finish({ result: undefined, error: err.message, logs: [] });
      });

      child.on("exit", (exitCode) => {
        finish({
          result: undefined,
          error: `Sandbox exited with code ${exitCode ?? "unknown"}`,
          logs: []
        });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (process.env.CODEMODE_DEBUG) {
          process.stderr.write(
            `[@cloudflare/codemode] sandbox: ${chunk.toString()}`
          );
        }
      });

      child.on("message", async (raw: unknown) => {
        const message = raw as RunnerMessage;
        if (!message || typeof message !== "object") return;

        if (message.type === "ready") {
          child.send({
            type: "run",
            code: normalizeCode(code),
            providers: manifest,
            idleTimeout: IDE_TIMEOUT
          });
          return;
        }

        if (message.type === "call") {
          const provider = providersByName.get(message.provider ?? "");
          const fn = provider?.fns[message.fn ?? ""];
          try {
            if (!fn) {
              throw new Error(
                `Tool "${message.fn}" not found in provider "${message.provider}"`
              );
            }
            const args = message.args;
            const positional = Array.isArray(args) ? args : [args];
            const value = await fn(...positional);
            if (child.connected) {
              child.send({
                type: "call:reply",
                id: message.id,
                value
              });
            }
          } catch (err) {
            if (child.connected) {
              child.send({
                type: "call:reply",
                id: message.id,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
          return;
        }

        if (message.type === "result") {
          finish({
            result: message.result,
            error: message.error,
            logs: message.logs ?? []
          });
        }
      });
    });
  }
}
