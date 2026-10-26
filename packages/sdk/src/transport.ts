/**
 * Transport: how the SDK reaches the network.
 *
 * The SDK never opens sockets itself. It calls one `fetch`-shaped function,
 * the global fetch by default or the one the caller passes in. The SDK stays
 * free of network dependencies and works in browsers and in Node.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TransportKind = "clearnet";

export interface Transport {
  readonly kind: TransportKind;
  readonly fetch: FetchLike;
}

export interface TransportOptions {
  /** Abort a request after this many milliseconds. Default 30000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Wrap a fetch so each call aborts after `timeoutMs`. */
function withTimeout(fetchImpl: FetchLike, timeoutMs = DEFAULT_TIMEOUT_MS): FetchLike {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs);
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Direct connection. Leaks the caller's IP to the route operator. */
export function clearnetTransport(fetchImpl: FetchLike = defaultFetch(), options: TransportOptions = {}): Transport {
  return { kind: "clearnet", fetch: withTimeout(fetchImpl, options.timeoutMs) };
}

function defaultFetch(): FetchLike {
  const f = globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("no global fetch; pass a fetch implementation to the transport");
  }
  return (input, init) => f(input, init);
}
