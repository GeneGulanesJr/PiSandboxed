import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import type { MountSpec, ProfileRegistry, ResolvedProfile } from '../../core/ports.js';

// ---------------------------------------------------------------------------
// TOML schema (zod v4)
// ---------------------------------------------------------------------------

const MountSchema = z.object({
  host: z.string().startsWith('/'),
  guest: z.string().startsWith('/'),
  mode: z.enum(['ro', 'rw']),
});

const NetworkSchema = z.object({
  allow_hosts: z.array(z.string()).default([]),
});

const SecretsSchema = z.object({
  ssh_agent: z.boolean().default(false),
});

const ProfileTomlSchema = z.object({
  image: z.string().min(1),
  cpus: z.number().int().min(1).max(16),
  memory: z.number().int().min(256),
  ttl: z.string().regex(/^\d+[smh]$/),
  net: z.boolean().default(false),
  network: NetworkSchema.default({ allow_hosts: [] }),
  mounts: z.array(MountSchema).default([]),
  secrets: SecretsSchema.default({ ssh_agent: false }),
});

type ProfileToml = z.infer<typeof ProfileTomlSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TTL_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

function ttlToMs(ttl: string): number {
  const m = /^(\d+)([smh])$/.exec(ttl);
  if (!m) throw new Error(`invalid ttl '${ttl}' (expected e.g. "30s", "10m", "2h")`);
  const unit = m[2]!;
  return Number(m[1]) * TTL_UNIT_MS[unit]!;
}

function toResolved(name: string, raw: ProfileToml): ResolvedProfile {
  const mounts: MountSpec[] = raw.mounts.map((mnt) => ({
    host: mnt.host,
    guest: mnt.guest,
    readWrite: mnt.mode === 'rw',
  }));
  return {
    name,
    image: raw.image,
    cpus: raw.cpus,
    memoryMb: raw.memory,
    ttlMs: ttlToMs(raw.ttl),
    net: raw.net,
    allowHosts: raw.network.allow_hosts,
    mounts,
    sshAgent: raw.secrets.ssh_agent,
  };
}

function formatIssues(name: string, error: z.ZodError): string {
  const detail = error.issues
    .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
    .join('; ');
  return `invalid profile '${name}': ${detail}`;
}

/** A discovered profile file, not yet parsed (parse happens lazily in get()). */
interface ProfileEntry {
  path: string;
  isBuiltin: boolean;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/**
 * Loads TOML profile directories in order; builtins FIRST.
 *
 * - Constructor: scans dirs and detects name collisions ONLY (no parsing).
 *   A user-dir file whose name matches an earlier (builtin) profile throws
 *   loudly — fail closed, never let user files shadow builtins.
 * - get(): read + parse + validate + cache. Invalid content throws here, so
 *   a broken profile is a per-call rejection, not a broken registry.
 * - list(): resolves every entry; multiple dirs are additive for NEW names.
 */
export class ProfileRegistryImpl implements ProfileRegistry {
  readonly #entries = new Map<string, ProfileEntry>();
  readonly #cache = new Map<string, ResolvedProfile>();

  constructor(dirs: readonly string[]) {
    dirs.forEach((dir, i) => this.#scanDir(dir, i === 0));
  }

  #scanDir(dir: string, isBuiltin: boolean): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // missing dir = no profiles from this source
    }
    for (const file of names) {
      if (!file.endsWith('.toml')) continue;
      const name = file.slice(0, -'.toml'.length);
      if (this.#entries.has(name)) {
        throw new Error(
          `profile '${name}' in '${dir}' would shadow an existing profile of the same name — ` +
            `user profiles must not shadow builtins (rename the file)`,
        );
      }
      this.#entries.set(name, { path: join(dir, file), isBuiltin });
    }
  }

  async get(name: string): Promise<ResolvedProfile | undefined> {
    const cached = this.#cache.get(name);
    if (cached) return cached;

    const entry = this.#entries.get(name);
    if (!entry) return undefined;

    let text: string;
    try {
      text = await readFile(entry.path, 'utf8');
    } catch (cause) {
      throw new Error(`cannot read profile '${name}' at ${entry.path}: ${(cause as Error).message}`);
    }

    let raw: unknown;
    try {
      raw = parse(text);
    } catch (cause) {
      throw new Error(`cannot parse profile '${name}' (${entry.path}) as TOML: ${(cause as Error).message}`);
    }

    const parsed = ProfileTomlSchema.safeParse(raw);
    if (!parsed.success) throw new Error(formatIssues(name, parsed.error));

    const resolved = toResolved(name, parsed.data);
    this.#cache.set(name, resolved);
    return resolved;
  }

  async list(): Promise<ResolvedProfile[]> {
    const names = [...this.#entries.keys()].sort();
    const all = await Promise.all(names.map((n) => this.get(n)));
    return all.filter((p): p is ResolvedProfile => p !== undefined);
  }
}
