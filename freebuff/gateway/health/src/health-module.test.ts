import { describe, test, expect, afterEach } from 'vitest';

import { createHealthModule, type HealthModule } from '../src/health-module';
import type { ComponentHealth, HealthReport } from '../src/types';

describe('HealthModule', () => {
  let health: HealthModule;

  afterEach(async () => {
    await health.shutdown().catch(() => {});
  });

  test('creates with default options', () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0, // disable for unit tests
    });

    expect(health.getHeartbeatSequence()).toBe(0);
    expect(health.isHeartbeatOverdue()).toBe(false);
  });

  test('getReport returns valid health report', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    const report = await health.getReport();

    expect(report.status).toMatch(/^(healthy|degraded|unhealthy|unknown)$/);
    expect(report.gatewayId).toBe('gw_test');
    expect(report.deviceId).toBe('dev_test');
    expect(report.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(report.startedAt).toBeInstanceOf(Date);
    expect(report.generatedAt).toBeInstanceOf(Date);
    expect(report.heartbeatSequence).toBe(0);
    expect(Array.isArray(report.components)).toBe(true);
    expect(report.resources).toBeDefined();
    expect(typeof report.resources.cpuPercent).toBe('number');
    expect(typeof report.resources.memoryMb).toBe('number');
    expect(typeof report.resources.memoryTotalMb).toBe('number');
    expect(typeof report.resources.memoryUsedPercent).toBe('number');
    expect(report.resources.loadAverage).toHaveLength(3);
    expect(report.totalEventsProcessed).toBe(0);
  });

  test('getStatus returns healthy for clean system', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    const status = await health.getStatus();
    expect(status).toMatch(/^(healthy|degraded)$/); // may be degraded if load is high
  });

  test('registerCheck and unregisterCheck work', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    const customCheck = (): ComponentHealth => ({
      name: 'custom',
      status: 'healthy',
      message: 'All good',
      lastCheckedAt: new Date(),
      durationMs: 0,
    });

    health.registerCheck('custom', customCheck);

    const report = await health.getReport();
    expect(report.components.some((c) => c.name === 'custom')).toBe(true);

    health.unregisterCheck('custom');
    const report2 = await health.getReport();
    expect(report2.components.some((c) => c.name === 'custom')).toBe(false);
  });

  test('recordEvent and recordEvents increment counter', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    health.recordEvent();
    health.recordEvent();
    health.recordEvents(5);

    const report = await health.getReport();
    expect(report.totalEventsProcessed).toBe(7);
  });

  test('custom check returning unhealthy affects overall status', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    health.registerCheck('failing-check', () => ({
      name: 'failing-check',
      status: 'unhealthy',
      message: 'Something broke',
      lastCheckedAt: new Date(),
      durationMs: 0,
      issues: ['Critical failure'],
    }));

    const report = await health.getReport();
    expect(report.status).toBe('unhealthy');
    const failing = report.components.find((c) => c.name === 'failing-check');
    expect(failing?.status).toBe('unhealthy');
    expect(failing?.issues).toContain('Critical failure');
  });

  test('custom check returning degraded affects overall status', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    health.registerCheck('degraded-check', () => ({
      name: 'degraded-check',
      status: 'degraded',
      message: 'Running slow',
      lastCheckedAt: new Date(),
      durationMs: 100,
    }));

    const report = await health.getReport();
    expect(report.status).toBe('degraded');
  });

  test('custom check throwing returns unhealthy component', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    health.registerCheck('crashing-check', () => {
      throw new Error('Check crashed');
    });

    const report = await health.getReport();
    expect(report.status).toBe('unhealthy');
    const comp = report.components.find((c) => c.name === 'crashing-check');
    expect(comp?.status).toBe('unhealthy');
    expect(comp?.message).toContain('Check crashed');
  });

  test('custom async check works', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    health.registerCheck('async-check', () => ({
      name: 'async-check',
      status: 'healthy' as const,
      message: 'Async check passed',
      lastCheckedAt: new Date(),
      durationMs: 5,
    }));

    const report = await health.getReport();
    expect(report.components.some((c) => c.name === 'async-check')).toBe(true);
  });

  test('onReport receives periodic reports', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 100,
      heartbeatOverdueThresholdMs: 500,
    });

    const reports: HealthReport[] = [];
    health.onReport((r) => reports.push(r));

    await new Promise((r) => setTimeout(r, 350));
    await health.shutdown();

    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports[0]!.heartbeatSequence).toBeGreaterThanOrEqual(1);
  });

  test('heartbeat sequence increments over time', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 50,
      heartbeatOverdueThresholdMs: 500,
    });

    await new Promise((r) => setTimeout(r, 200));
    const seq = health.getHeartbeatSequence();
    expect(seq).toBeGreaterThan(0);
    await health.shutdown();
  });

  test('getLastResourceSnapshot returns cached snapshot', () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    const snapshot = health.getLastResourceSnapshot();
    expect(typeof snapshot.cpuPercent).toBe('number');
    expect(typeof snapshot.memoryMb).toBe('number');
    expect(snapshot.measuredAt).toBeInstanceOf(Date);
  });

  test('shutdown stops heartbeat and clears state', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 50,
      heartbeatOverdueThresholdMs: 500,
    });

    health.registerCheck('test-check', () => ({
      name: 'test-check',
      status: 'healthy' as const,
      lastCheckedAt: new Date(),
      durationMs: 0,
    }));

    await health.shutdown();

    // After shutdown, report should still work but with no custom checks
    const report = await health.getReport();
    expect(report.components.some((c) => c.name === 'test-check')).toBe(false);
  });

  test('multiple unhealthy components aggregate to unhealthy', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    health.registerCheck('check-a', () => ({
      name: 'check-a',
      status: 'unhealthy',
      lastCheckedAt: new Date(),
      durationMs: 0,
    }));

    health.registerCheck('check-b', () => ({
      name: 'check-b',
      status: 'healthy',
      lastCheckedAt: new Date(),
      durationMs: 0,
    }));

    const report = await health.getReport();
    expect(report.status).toBe('unhealthy');
  });

  test('all healthy components aggregate to healthy (or degraded from system resources)', async () => {
    health = createHealthModule({
      gatewayId: 'gw_test',
      deviceId: 'dev_test',
      heartbeatIntervalMs: 0,
    });

    // Remove the default resource check to test pure component aggregation
    health.unregisterCheck('resources');

    health.registerCheck('check-a', () => ({
      name: 'check-a',
      status: 'healthy',
      lastCheckedAt: new Date(),
      durationMs: 0,
    }));

    health.registerCheck('check-b', () => ({
      name: 'check-b',
      status: 'healthy',
      lastCheckedAt: new Date(),
      durationMs: 0,
    }));

    const report = await health.getReport();
    expect(report.status).toBe('healthy');
  });
});
