import { isAbsolute } from 'node:path';
import type {
  ArtifactExtractor, CreateSandboxInput, ExecInput, ExecOutput, ManagedSandbox,
  ModeManager, ProfileRegistry, PromoteResult, ResolvedProfile, SandboxBus,
  SandboxId, SandboxInfo,
} from './ports.js';

export interface SandboxServiceOptions {
  registry: ProfileRegistry;
  modes: Map<string, ModeManager>;
  bus: SandboxBus;
  now?: () => Date;
}

export class PolicyError extends Error {}

export class SandboxService {
  #registry: ProfileRegistry;
  #modes: Map<string, ModeManager>;
  #bus: SandboxBus;
  #now: () => Date;
  #reaper: ReturnType<typeof setInterval> | undefined;
  /** last expanded profile (exposed for tests) */
  lastResolved: ResolvedProfile | undefined;

  constructor(opts: SandboxServiceOptions) {
    this.#registry = opts.registry;
    this.#modes = opts.modes;
    this.#bus = opts.bus;
    this.#now = opts.now ?? (() => new Date());
  }

  async create(input: CreateSandboxInput): Promise<SandboxInfo> {
    const profile = await this.#registry.get(input.profile);
    if (!profile) this.#deny(`unknown profile "${input.profile}"`, input);
    const mode = this.#modes.get(input.mode);
    if (!mode) {
      this.#deny(`unsupported mode "${input.mode}" (registered: ${[...this.#modes.keys()].join(', ')})`, input);
    }
    if (input.ttlMs !== undefined && input.ttlMs > profile!.ttlMs) {
      this.#deny(`ttl ${input.ttlMs}ms exceeds profile "${profile!.name}" ttl ${profile!.ttlMs}ms`, input);
    }
    const needsProject = profile!.mounts.some((m) => m.host.includes('{project}'));
    if (needsProject && !input.project) {
      this.#deny(`profile "${profile!.name}" mounts {project} — "project" is required`, input);
    }

    // {project} expansion: relative paths substitute into the profile's template
    // prefix ("…/Documents/{project}" + "GulanesKorp/repo"); ABSOLUTE paths are
    // used verbatim — the template prefix is only a default root for relative
    // input, never something to splice an absolute path behind.
    const expandHost = (host: string): string =>
      isAbsolute(input.project!) ? input.project! : host.replace('{project}', input.project!);

    const resolved: ResolvedProfile = needsProject
      ? { ...profile!, mounts: profile!.mounts.map((m) => ({ ...m, host: expandHost(m.host) })) }
      : profile!;
    this.lastResolved = resolved;

    let info: SandboxInfo;
    try {
      info = await mode!.create(input, resolved);
    } catch (err) {
      this.#bus.emit('sandbox.failed', { error: (err as Error).message, request: input });
      throw err;
    }
    this.#bus.emit('sandbox.created', { id: info.id, profile: info.profile, mode: info.mode });
    return info;
  }

  async #managed(id: SandboxId): Promise<ManagedSandbox> {
    for (const mode of this.#modes.values()) {
      const sb = await mode.get(id).catch(() => undefined);
      if (sb) return sb;
    }
    throw new PolicyError(`sandbox "${id}" not found or not running`);
  }

  async get(id: SandboxId): Promise<SandboxInfo> {
    return (await this.#managed(id)).info();
  }

  async exec(id: SandboxId, input: ExecInput): Promise<ExecOutput> {
    const sb = await this.#managed(id);
    const started = Date.now();
    const out = await sb.exec(input);
    this.#bus.emit('exec.completed', { id, cmd: input.cmd, exitCode: out.exitCode, durationMs: Date.now() - started });
    return out;
  }

  async destroy(id: SandboxId, reason = 'requested'): Promise<void> {
    for (const mode of this.#modes.values()) {
      const sb = await mode.get(id).catch(() => undefined);
      if (!sb) continue;
      await mode.destroy(id, reason);
      this.#bus.emit('sandbox.destroyed', { id, reason });
      return;
    }
  }

  async promote(id: SandboxId, kind: string, params: Record<string, unknown>, extractors: ArtifactExtractor[]): Promise<PromoteResult> {
    const sb = await this.#managed(id);
    const extractor = extractors.find((e) => e.kind === kind);
    if (!extractor) throw new PolicyError(`unknown promote kind "${kind}" (known: ${extractors.map((e) => e.kind).join(', ')})`);
    const info = sb.info();
    const result = await extractor.run({ sandbox: sb, projectHostPath: info.project, params });
    this.#bus.emit('promote.applied', { id, kind: result.kind, detail: result.detail });
    return result;
  }

  startReaper(intervalMs = 60_000): void {
    this.#reaper = setInterval(() => { void this.reapOnce(); }, intervalMs);
    this.#reaper.unref();
  }

  stopReaper(): void { if (this.#reaper) clearInterval(this.#reaper); }

  async reapOnce(): Promise<void> {
    const now = this.#now().getTime();
    for (const mode of this.#modes.values()) {
      for (const id of mode.ids()) {
        const sb = await mode.get(id).catch(() => undefined);
        if (!sb) continue;
        const exp = sb.info().expiresAt;
        if (exp && new Date(exp).getTime() <= now) {
          await mode.destroy(id, 'ttl expired');
          this.#bus.emit('sandbox.reaped', { id, expiresAt: exp });
        }
      }
    }
  }

  async destroyAll(reason = 'daemon shutdown'): Promise<void> {
    for (const mode of this.#modes.values()) await mode.destroyAll(reason);
  }

  #deny(reason: string, request: unknown): never {
    this.#bus.emit('policy.denied', { reason, request });
    throw new PolicyError(reason);
  }
}
