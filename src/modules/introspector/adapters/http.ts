import type {
  ModuleError,
  SystemAdapter,
  SystemMetadata,
  SystemOutput,
  TargetConfig,
  TestInput,
} from "@apt/lib/types";

export class HttpAdapter implements SystemAdapter {
  id = "http";
  type = "http" as const;
  private config: TargetConfig | null = null;
  private baseUrl = "";

  /** Connect to the target. Expands ${ENV} vars, tests connectivity */
  async connect(config: TargetConfig): Promise<void> {
    this.config = { ...config, url: expandEnvVars(config.url) };
    if (this.config.auth?.token) {
      this.config.auth = {
        ...this.config.auth,
        token: expandEnvVars(this.config.auth.token),
      };
    }
    this.baseUrl = this.config.url;

    // Test connectivity
    const timeout = this.config.timeout_ms ?? 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeout, 5000));

    try {
      await fetch(this.baseUrl, {
        method: "HEAD",
        signal: controller.signal,
        headers: this.buildHeaders(),
      });
      // We accept any response -- just need to know the server is reachable
    } catch (error) {
      const err = error as Error;
      throw createAdapterError(
        "INTRO_CONN_001",
        `Connection failed to ${this.baseUrl}: ${err.message}`,
        true,
        "Check if the target URL is correct and the server is running",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send input to the target with retry on 429/5xx */
  async send(input: TestInput): Promise<SystemOutput> {
    if (!this.config) throw createAdapterError("INTRO_CONN_001", "Not connected", false);

    const timeout = this.config.timeout_ms ?? 30000;
    const body = buildRequestBody(input, this.config.model);
    const maxRetries = 3;
    const baseDelay = 1000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(baseDelay * 2 ** (attempt - 1) + Math.random() * 100, 10000);
        await sleep(delay);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const start = performance.now();

      try {
        const response = await fetch(this.baseUrl, {
          method: "POST",
          signal: controller.signal,
          headers: {
            ...this.buildHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const latency = performance.now() - start;

        // Retry on 429 or 5xx
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }

        // Don't retry on 4xx (except 429)
        if (!response.ok) {
          throw createAdapterError(
            "INTRO_SEND_001",
            `HTTP ${response.status}: ${response.statusText}`,
            response.status === 429 || response.status >= 500,
          );
        }

        let content: string;
        let format: "text" | "json" | "markdown" = "text";
        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("application/json")) {
          let json: Record<string, unknown>;
          try {
            json = await response.json();
          } catch {
            throw createAdapterError(
              "INTRO_PARSE_001",
              "Failed to parse JSON response body",
              false,
              "Check the target API response format",
            );
          }
          // OpenAI-compatible format
          if (
            (json as Record<string, unknown>).choices &&
            Array.isArray((json as Record<string, unknown>).choices)
          ) {
            const choices = (json as Record<string, unknown>).choices as Array<
              Record<string, unknown>
            >;
            const msg = choices[0]?.message as Record<string, unknown> | undefined;
            if (msg?.content) {
              content = msg.content as string;
            } else {
              content = JSON.stringify(json);
            }
          } else if (json.content) {
            content =
              typeof json.content === "string" ? json.content : JSON.stringify(json.content);
          } else {
            content = JSON.stringify(json);
          }
          format = "json";
        } else {
          content = await response.text();
        }

        return {
          content,
          format,
          latency_ms: Math.round(latency),
          metadata: {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          },
        };
      } catch (error) {
        clearTimeout(timer);
        const err = error as Error;
        if (err.name === "AbortError") {
          throw createAdapterError(
            "INTRO_TIMEOUT_001",
            `Request timed out after ${timeout}ms`,
            true,
            "Increase timeout_ms in config",
          );
        }
        if (isAdapterError(err)) throw err;
        lastError = err;
        if (attempt >= maxRetries) break;
      } finally {
        clearTimeout(timer);
      }
    }

    throw createAdapterError(
      "INTRO_SEND_002",
      `All ${maxRetries} retries failed: ${lastError?.message}`,
      true,
      "Check if the target server is healthy",
    );
  }

  /** Inspect the target for metadata */
  async inspect(): Promise<SystemMetadata> {
    if (!this.config) throw createAdapterError("INTRO_CONN_001", "Not connected", false);

    const metadata: SystemMetadata = { reachable: true };

    // Try OpenAI /models endpoint
    try {
      const modelsUrl = new URL("/models", this.baseUrl).toString();
      const response = await fetch(modelsUrl, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const json = await response.json();
        if (json.data || json.models) {
          metadata.detected_provider = "openai-compatible";
          metadata.response_format = "openai";
        }
      }
    } catch {
      // Not OpenAI-compatible
    }

    // Try OPTIONS to detect capabilities
    try {
      const response = await fetch(this.baseUrl, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(5000),
      });
      metadata.headers = Object.fromEntries(response.headers.entries());
    } catch {
      // Ignore
    }

    return metadata;
  }

  async disconnect(): Promise<void> {
    this.config = null;
    this.baseUrl = "";
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.config?.auth) {
      const { type, token, header } = this.config.auth;
      if (type === "bearer" && token) {
        headers.Authorization = `Bearer ${token}`;
      } else if (type === "api-key" && token) {
        headers[header ?? "X-API-Key"] = token;
      } else if (type === "basic" && token) {
        headers.Authorization = `Basic ${token}`;
      }
    }

    if (this.config?.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }
}

// === Helpers ===

function expandEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return Bun.env[varName] ?? "";
  });
}

function buildRequestBody(input: TestInput, model?: string): Record<string, unknown> {
  // OpenAI-compatible format
  return {
    ...(model ? { model } : {}),
    messages: [
      ...(input.context?.conversation_history ?? []),
      { role: "user", content: input.content },
    ],
    ...(input.context?.system_prompt ? { system: input.context.system_prompt } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AdapterError extends Error {
  __adapterError: true;
  moduleError: ModuleError;
}

function createAdapterError(
  code: string,
  message: string,
  recoverable: boolean,
  fallback?: string,
): AdapterError {
  const error = new Error(message) as AdapterError;
  error.__adapterError = true;
  error.moduleError = {
    module: "introspector.adapter.http",
    severity: recoverable ? "error" : "fatal",
    code,
    message,
    recoverable,
    fallback,
  };
  return error;
}

function isAdapterError(err: unknown): err is AdapterError {
  return typeof err === "object" && err !== null && "__adapterError" in err;
}
