import { describe, expect, it } from 'vitest';
import { inspectBenchmarkEnvironment, runIsolationBenchmarkHarness, type BenchmarkEnvironmentRecord } from './benchmarks/isolation-overhead.bench.js';

describe('installation environment inspection', () => {
  it('reports the real benchmark environment without fabricating samples', () => {
    const record: BenchmarkEnvironmentRecord = inspectBenchmarkEnvironment();
    expect(typeof record.platform).toBe('string');
    expect(typeof record.cpuCores).toBe('number');
    expect(record.cpuCores).toBeGreaterThan(0);
    expect(typeof record.totalMemoryBytes).toBe('number');
    expect(typeof record.hasKvm).toBe('boolean');
    expect(typeof record.hasDocker).toBe('boolean');
    expect(typeof record.hasFirecracker).toBe('boolean');
    expect(['benchmarks_pending_kvm_host', 'evidence_collected']).toContain(record.status);

    const harnessResult = runIsolationBenchmarkHarness();
    expect(harnessResult.environment).toBeDefined();
    expect(Array.isArray(harnessResult.samples)).toBe(true);
  });
});
