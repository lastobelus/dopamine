import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface HubConfig {
  machine: string;
  hubId: string;
  port: number;
  dataRoot: string;
  tokenFile: string;
  viewingOrigin: string;
  dashboardDomain: string;
  sourceCommit?: string;
  peerCredentialFile?: string;
  peer?: { machine: string; hubId: string; origin: string; host: string };
  dashboardOrigins?: Record<string, string>;
  urlOverrides?: Record<string, string>;
  remotes?: Record<string, { host: string; dash: string; config?: string }>;
  adapter?: {
    home: string;
    environmentId: string;
    threadCommand?: string[];
    projectIconCommand?: string[];
  };
  threadEnvironments?: Record<string, ThreadEnvironment>;
  serviceHint?: string;
}

/** How the hub reaches one environment's thread CLI: locally, or on `host` over SSH. */
export interface ThreadEnvironment {
  threadCommand: string[];
  host?: string;
}

/** The thread CLI for an environment: configured, or the adapter's own for its environment. */
export function threadEnvironment(
  config: HubConfig,
  environmentId: string,
): ThreadEnvironment | null {
  const configured = config.threadEnvironments?.[environmentId];
  if (configured) return configured;
  const command = config.adapter?.threadCommand;
  return command?.[0] && config.adapter?.environmentId === environmentId
    ? { threadCommand: command }
    : null;
}

export function loopback(url: URL): boolean {
  return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

export function validateConfig(value: unknown): HubConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid private configuration");
  const cfg = value as HubConfig;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cfg.machine) || !cfg.hubId)
    throw new Error("Configuration needs a machine slug and hub ID");
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535)
    throw new Error("Configuration needs a valid port");
  for (const p of [cfg.dataRoot, cfg.tokenFile, cfg.peerCredentialFile].filter(Boolean))
    if (typeof p !== "string" || !isAbsolute(p))
      throw new Error("Configuration paths must be absolute");
  const viewing = new URL(cfg.viewingOrigin);
  if (
    viewing.protocol !== "http:" ||
    viewing.origin !== cfg.viewingOrigin ||
    viewing.username ||
    viewing.password
  )
    throw new Error("Viewing origin must be an HTTP origin");
  if (!/^[a-z0-9.-]+$/.test(cfg.dashboardDomain)) throw new Error("Invalid dashboard domain");
  if (cfg.peer) {
    const peer = new URL(cfg.peer.origin);
    const peerHost = new URL(`http://${cfg.peer.host}`);
    if (!["127.0.0.1", "[::1]"].includes(peerHost.hostname) || peerHost.host !== cfg.peer.host)
      throw new Error("Peer Host must be a literal loopback authority");
    if (
      !loopback(peer) ||
      peer.protocol !== "http:" ||
      peer.origin !== cfg.peer.origin ||
      !cfg.peerCredentialFile ||
      !cfg.peer.hubId
    )
      throw new Error("Peer must use a loopback HTTP origin and a private credential");
  }
  for (const origin of Object.values(cfg.dashboardOrigins ?? {})) {
    const u = new URL(origin);
    if (u.protocol !== "http:" || u.origin !== origin) throw new Error("Invalid dashboard origin");
  }
  for (const entry of Object.values(cfg.threadEnvironments ?? {})) {
    if (
      !Array.isArray(entry?.threadCommand) ||
      entry.threadCommand.length === 0 ||
      entry.threadCommand.some(
        (part) => typeof part !== "string" || !part || part.includes("\0"),
      ) ||
      entry.threadCommand[0]!.startsWith("-") ||
      (entry.host !== undefined &&
        (typeof entry.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9@._-]*$/.test(entry.host)))
    )
      throw new Error("Thread environments need a command array and an optional SSH host");
  }
  return cfg;
}

export async function readConfig(path = process.env.DOPAMINE_CONFIG): Promise<HubConfig> {
  if (!path)
    throw new Error("Set DOPAMINE_CONFIG or pass --config with a private configuration file");
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}

export async function readSecret(path: string): Promise<string> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error("Secret file must be readable only by its owner");
  const secret = (await readFile(path, "utf8")).trim();
  if (secret.length < 32) throw new Error("Secret must contain at least 32 characters");
  return secret;
}

export function dashboardOrigin(config: HubConfig, key: string): string {
  return (
    config.dashboardOrigins?.[key] ??
    `http://${key}.${config.dashboardDomain}${new URL(config.viewingOrigin).port ? `:${new URL(config.viewingOrigin).port}` : ""}`
  );
}

export function shellUrl(config: HubConfig, key: string): string {
  return `${config.viewingOrigin}/d/${encodeURIComponent(key)}`;
}
