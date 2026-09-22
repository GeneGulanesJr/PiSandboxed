import { describe, expect, it } from 'vitest';
import type { IsolationBackend, ModeManager, ProfileRegistry, SandboxRepo, AuditRepo, ArtifactExtractor } from '../src/core/ports.js';

describe('ports vocabulary', () => {
  it('exposes the six seams', () => {
    const probe = {
      backend: null as IsolationBackend | null,
      mode: null as ModeManager | null,
      registry: null as ProfileRegistry | null,
      sandboxes: null as SandboxRepo | null,
      audit: null as AuditRepo | null,
      extractor: null as ArtifactExtractor | null,
    };
    expect(Object.keys(probe).length).toBe(6);
  });
});
