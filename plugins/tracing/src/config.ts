import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

/**
 * Resolved tracer configuration.
 *
 * Resolution order (lowest → highest precedence):
 *   defaults  →  ~/.codex/langfuse.json  →  <cwd>/.codex/langfuse.json  →  env
 *
 * For each env var, the `LANGFUSE_CODEX_*` form takes precedence over the
 * matching standard `LANGFUSE_*` form so you can scope credentials to Codex
 * without disturbing other Langfuse tooling on the same machine.
 */
export const ConfigSchema = z.object({
  enabled: z.boolean(),
  public_key: z.string().optional(),
  secret_key: z.string().optional(),
  base_url: z.string(),
  environment: z.string().optional(),
  user_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  skill_tags: z.boolean(),
  trace_seed: z.string().optional(),
  debug: z.boolean(),
  fail_on_error: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

const PartialConfigSchema = ConfigSchema.partial();

const DEFAULTS: Pick<Config, "enabled" | "base_url" | "skill_tags" | "debug" | "fail_on_error"> = {
  enabled: false,
  base_url: "https://cloud.langfuse.com",
  skill_tags: true,
  debug: false,
  fail_on_error: false,
};

const CodexAuthSchema = z
  .object({
    tokens: z
      .object({
        id_token: z.string().optional(),
      })
      .optional(),
  })
  .loose();

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to comma-separated parsing
    }
  }
  return trimmed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseMetadata(value: unknown): Record<string, string> | undefined {
  let obj: unknown = value;
  if (typeof value === "string") {
    if (value.trim().length === 0) return undefined;
    try {
      obj = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function readConfigFile(file: string): Promise<Partial<Config> | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    // Normalize the few fields that need coercion before zod validation.
    return PartialConfigSchema.parse(
      stripUndefined({
        ...raw,
        enabled: raw.enabled != null ? parseBoolean(raw.enabled) : undefined,
        tags: raw.tags != null ? parseTags(raw.tags) : undefined,
        metadata: raw.metadata != null ? parseMetadata(raw.metadata) : undefined,
        skill_tags: raw.skill_tags != null ? parseBoolean(raw.skill_tags) : undefined,
        debug: raw.debug != null ? parseBoolean(raw.debug) : undefined,
        fail_on_error: raw.fail_on_error != null ? parseBoolean(raw.fail_on_error) : undefined,
      }),
    );
  } catch {
    return undefined;
  }
}

function readJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function readCodexUserEmail(authFile: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(authFile, "utf-8")) as unknown;
    const auth = CodexAuthSchema.parse(raw);
    const token = auth.tokens?.id_token;
    if (!token) return undefined;

    const email = readJwtPayload(token)?.email;
    if (typeof email !== "string") return undefined;

    const trimmed = email.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function getVar(suffix: string, env: Record<string, string | undefined>): string | undefined {
  return env[`LANGFUSE_CODEX_${suffix}`] ?? env[`LANGFUSE_${suffix}`];
}

function readEnvConfig(env: Record<string, string | undefined>): Partial<Config> {
  return PartialConfigSchema.parse(
    stripUndefined({
      enabled: parseBoolean(env.TRACE_TO_LANGFUSE),
      public_key: getVar("PUBLIC_KEY", env),
      secret_key: getVar("SECRET_KEY", env),
      base_url: getVar("BASE_URL", env),
      environment: env.LANGFUSE_CODEX_ENVIRONMENT ?? env.LANGFUSE_TRACING_ENVIRONMENT,
      user_id: env.LANGFUSE_CODEX_USER_ID,
      tags: parseTags(env.LANGFUSE_CODEX_TAGS),
      metadata: parseMetadata(env.LANGFUSE_CODEX_METADATA),
      skill_tags: parseBoolean(env.LANGFUSE_CODEX_SKILL_TAGS),
      trace_seed: env.LANGFUSE_CODEX_TRACE_SEED,
      debug: parseBoolean(env.LANGFUSE_CODEX_DEBUG),
      fail_on_error: parseBoolean(env.LANGFUSE_CODEX_FAIL_ON_ERROR),
    }),
  );
}

const getHomeDir = () => process.env.HOME ?? os.homedir();

function getCodexAuthFile(home: string, env: Record<string, string | undefined>): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome ? path.join(codexHome, "auth.json") : path.join(home, ".codex", "auth.json");
}

export async function getConfig(options?: {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<Config> {
  const home = options?.home ?? getHomeDir();
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;

  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(path.join(home, ".codex", "langfuse.json")),
    readConfigFile(path.join(cwd, ".codex", "langfuse.json")),
  ]);
  const envConfig = readEnvConfig(env);
  const explicitUserId = globalConfig?.user_id ?? localConfig?.user_id ?? envConfig.user_id;
  const codexUserId = explicitUserId
    ? undefined
    : await readCodexUserEmail(getCodexAuthFile(home, env));

  return ConfigSchema.parse({
    ...DEFAULTS,
    ...(codexUserId ? { user_id: codexUserId } : {}),
    ...globalConfig,
    ...localConfig,
    ...envConfig,
  });
}
