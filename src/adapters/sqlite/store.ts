import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry, AuditRepo, SandboxRepo, SandboxRow, SandboxState } from '../../core/ports.js';

export interface Store { sandboxes: SandboxRepo; audit: AuditRepo; close(): void; }

export function openStore(dbPath: string): Store {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandboxes (
      id TEXT PRIMARY KEY, profile TEXT NOT NULL, mode TEXT NOT NULL,
      state TEXT NOT NULL, machine_name TEXT NOT NULL, project TEXT,
      created_at TEXT NOT NULL, expires_at TEXT, stopped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL,
      sandbox_id TEXT, payload TEXT NOT NULL
    );
  `);

  const sandboxes: SandboxRepo = {
    insert(row: SandboxRow): void {
      db.prepare(`INSERT INTO sandboxes
        (id, profile, mode, state, machine_name, project, created_at, expires_at, stopped_at)
        VALUES (@id, @profile, @mode, @state, @machineName, @project, @createdAt, @expiresAt, @stoppedAt)`).run(row);
    },
    get(id: string): SandboxRow | undefined {
      const r = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id) as RawRow | undefined;
      return r ? toRow(r) : undefined;
    },
    listByState(state: SandboxState): SandboxRow[] {
      return (db.prepare('SELECT * FROM sandboxes WHERE state = ? ORDER BY created_at').all(state) as RawRow[]).map(toRow);
    },
    listActive(): SandboxRow[] {
      return (db.prepare("SELECT * FROM sandboxes WHERE state IN ('running','creating') ORDER BY created_at").all() as RawRow[]).map(toRow);
    },
    updateState(id: string, state: SandboxState, stoppedAt?: string): void {
      db.prepare('UPDATE sandboxes SET state = ?, stopped_at = COALESCE(?, stopped_at) WHERE id = ?').run(state, stoppedAt ?? null, id);
    },
  };

  const audit: AuditRepo = {
    append(e: AuditEntry): void {
      db.prepare('INSERT INTO audit (ts, event, sandbox_id, payload) VALUES (?, ?, ?, ?)')
        .run(e.ts, e.event, e.sandboxId, JSON.stringify(e.payload));
    },
    query(limit: number): AuditEntry[] {
      return (db.prepare('SELECT ts, event, sandbox_id, payload FROM audit ORDER BY id DESC LIMIT ?').all(limit) as RawAudit[])
        .map((r) => ({ ts: r.ts, event: r.event, sandboxId: r.sandbox_id, payload: JSON.parse(r.payload) as Record<string, unknown> }));
    },
  };

  return { sandboxes, audit, close: () => db.close() };
}

interface RawRow { id: string; profile: string; mode: SandboxRow['mode']; state: SandboxRow['state']; machine_name: string; project: string | null; created_at: string; expires_at: string | null; stopped_at: string | null; }
function toRow(r: RawRow): SandboxRow {
  return { id: r.id, profile: r.profile, mode: r.mode, state: r.state, machineName: r.machine_name, project: r.project, createdAt: r.created_at, expiresAt: r.expires_at, stoppedAt: r.stopped_at };
}
interface RawAudit { ts: string; event: string; sandbox_id: string | null; payload: string; }
