import { customAlphabet } from 'nanoid';
import type {
  BackendHandle, CreateSandboxInput, ExecInput, ExecOutput, IsolationBackend,
  ManagedSandbox, ModeManager, ResolvedProfile, SandboxId, SandboxInfo, SandboxRepo,
} from '../core/ports.js';

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

interface Entry { handle: BackendHandle; info: SandboxInfo; }

export class EphemeralMode implements ModeManager {
  readonly mode = 'ephemeral' as const;
  #live = new Map<SandboxId, Entry>();

  constructor(
    private readonly backend: IsolationBackend,
    private readonly repo: SandboxRepo,
  ) {}

  /** Live sandbox ids — the TTL reaper (service) iterates this. */
  ids(): string[] { return [...this.#live.keys()]; }

  async create(input: CreateSandboxInput, profile: ResolvedProfile): Promise<SandboxInfo> {
    const id = `sb_${newId()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + profile.ttlMs).toISOString();
    this.repo.insert({
      id, profile: profile.name, mode: this.mode, state: 'creating', machineName: id,
      project: input.project ?? null, createdAt: now.toISOString(), expiresAt, stoppedAt: null,
    });
    const handle = await this.backend.boot({
      machineName: id,
      image: profile.image,
      cpus: profile.cpus,
      memoryMb: profile.memoryMb,
      net: profile.net,
      allowHosts: profile.allowHosts,
      ports: profile.ports,
      mounts: profile.mounts,
      sshAgent: profile.sshAgent,
    });
    const info: SandboxInfo = {
      id, profile: profile.name, mode: this.mode, state: 'running',
      project: input.project ?? null, createdAt: now.toISOString(), expiresAt,
    };
    this.#live.set(id, { handle, info });
    this.repo.updateState(id, 'running');
    return info;
  }

  async get(id: SandboxId): Promise<ManagedSandbox | undefined> {
    const entry = this.#live.get(id);
    if (!entry) return undefined;
    const self = this;
    return {
      id,
      mode: this.mode,
      info: () => ({ ...entry.info }),
      exec: (input: ExecInput): Promise<ExecOutput> => entry.handle.exec(input),
      destroy: (reason: string) => self.destroy(id, reason),
    };
  }

  async destroy(id: SandboxId, reason: string): Promise<void> {
    const entry = this.#live.get(id);
    if (!entry) return;
    this.#live.delete(id); // remove from live map first: ids() must not see a half-dead sandbox
    try { await entry.handle.stop(); } catch { /* already stopped */ }
    try { await entry.handle.remove(); } catch { /* best effort */ }
    this.repo.updateState(id, 'stopped', new Date().toISOString());
    void reason; // caller (service) owns event emission
  }

  async destroyAll(reason: string): Promise<void> {
    for (const id of [...this.#live.keys()]) await this.destroy(id, reason);
  }
}
