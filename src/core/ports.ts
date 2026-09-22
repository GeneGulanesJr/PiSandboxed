import type { EventBus } from './events.js';

export type SandboxId = string;
export type SandboxMode = 'ephemeral' | 'pooled' | 'persistent';
export type SandboxState = 'creating' | 'running' | 'stopped' | 'error';

export interface MountSpec {
  host: string;
  guest: string;
  readWrite: boolean;
}

/** A profile after parsing/validation — what core is allowed to know. */
export interface ResolvedProfile {
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  ttlMs: number;
  net: boolean;
  allowHosts: string[];
  mounts: MountSpec[];
  sshAgent: boolean;
}

export interface CreateSandboxInput {
  profile: string;
  mode: SandboxMode;
  /** fills the profile's {project} mount placeholder; required iff profile has one */
  project?: string;
  /** may only SHORTEN the profile ttl */
  ttlMs?: number;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecInput {
  cmd: string[];
  env?: Record<string, string>;
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; data: string }) => void;
}

export interface SandboxInfo {
  id: SandboxId;
  profile: string;
  mode: SandboxMode;
  state: SandboxState;
  project: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface BootOptions {
  machineName: string;
  image: string;
  cpus: number;
  memoryMb: number;
  net: boolean;
  allowHosts: string[];
  mounts: MountSpec[];
  sshAgent: boolean;
}

/** Isolation seam. Phase 1 impl: adapters/smolvm (CLI). */
export interface IsolationBackend {
  boot(opts: BootOptions): Promise<BackendHandle>;
}

export interface BackendHandle {
  readonly machineName: string;
  exec(input: ExecInput): Promise<ExecOutput>;
  stop(): Promise<void>;
  remove(): Promise<void>;
}

/** Lifecycle seam. Phase 1 impl: modes/ephemeral. */
export interface ModeManager {
  readonly mode: SandboxMode;
  ids(): string[];
  create(input: CreateSandboxInput, profile: ResolvedProfile): Promise<SandboxInfo>;
  get(id: SandboxId): Promise<ManagedSandbox | undefined>;
  destroy(id: SandboxId, reason: string): Promise<void>;
  /** destroy every sandbox this mode owns (daemon shutdown) */
  destroyAll(reason: string): Promise<void>;
}

export interface ManagedSandbox {
  readonly id: SandboxId;
  readonly mode: SandboxMode;
  info(): SandboxInfo;
  exec(input: ExecInput): Promise<ExecOutput>;
  destroy(reason: string): Promise<void>;
}

/** Profile seam. Phase 1 impl: adapters/profiles (builtin TOML + profiles.user). */
export interface ProfileRegistry {
  get(name: string): Promise<ResolvedProfile | undefined>;
  list(): Promise<ResolvedProfile[]>;
}

export interface SandboxRow {
  id: SandboxId;
  profile: string;
  mode: SandboxMode;
  state: SandboxState;
  machineName: string;
  project: string | null;
  createdAt: string;
  expiresAt: string | null;
  stoppedAt: string | null;
}

/** Storage seams. Phase 1 impl: adapters/sqlite. */
export interface SandboxRepo {
  insert(row: SandboxRow): void;
  get(id: SandboxId): SandboxRow | undefined;
  listByState(state: SandboxState): SandboxRow[];
  listActive(): SandboxRow[];
  updateState(id: SandboxId, state: SandboxState, stoppedAt?: string): void;
}

export interface AuditEntry {
  ts: string;
  event: string;
  sandboxId: string | null;
  payload: Record<string, unknown>;
}

export interface AuditRepo {
  append(entry: AuditEntry): void;
  query(limit: number): AuditEntry[];
}

/** Promotion seam. Phase 1 impls: promote/ strategies. */
export interface PromoteContext {
  sandbox: ManagedSandbox;
  projectHostPath: string | null;
  params: Record<string, unknown>;
}

export interface PromoteResult {
  kind: string;
  detail: string;
}

export interface ArtifactExtractor {
  readonly kind: string;
  run(ctx: PromoteContext): Promise<PromoteResult>;
}

/** Canonical event names (consumed by audit sink now; metrics/webhooks later). */
export type SandboxEventMap = {
  'sandbox.created': { id: SandboxId; profile: string; mode: SandboxMode };
  'exec.completed': { id: SandboxId; cmd: string[]; exitCode: number; durationMs: number };
  'policy.denied': { reason: string; request: unknown };
  'promote.applied': { id: SandboxId; kind: string; detail: string };
  'sandbox.destroyed': { id: SandboxId; reason: string };
  'sandbox.reaped': { id: SandboxId; expiresAt: string };
}

export type SandboxBus = EventBus<SandboxEventMap>;
