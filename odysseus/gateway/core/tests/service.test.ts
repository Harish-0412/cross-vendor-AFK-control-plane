import { describe, expect, it } from 'vitest';

import { GatewaySupervisor, servicePlan, type SupervisedRun } from '../src/runtime/service';

const base = {
  node: '/usr/local/bin/node',
  cli: '/opt/odysseus/bin/odysseus.mjs',
  gatewayArgs: ['--project-root', '/work/app'],
  path: '/usr/local/bin:/usr/bin',
  env: { ODYSSEUS_CONTROL_PLANE_URL: 'wss://cp.example/ws/tunnel' },
};

describe('service definitions', () => {
  it('Windows: a sign-in task that starts the supervisor with no console window', () => {
    const plan = servicePlan({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\ada',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      cli: 'C:\\odysseus\\bin\\odysseus.mjs',
      windowsUser: 'OFFICE\\ada & co',
    });
    const [vbs, xml] = plan.files;
    expect(vbs!.path).toBe('C:\\Users\\ada\\.odysseus\\service\\odysseus-gateway.vbs');
    expect(vbs!.content).toContain(
      'shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\odysseus\\bin\\odysseus.mjs"" ""service"" ""run"" ""--"" ""--project-root"" ""/work/app""", 0, False',
    );
    expect(vbs!.content).toContain(
      'env("ODYSSEUS_CONTROL_PLANE_URL") = "wss://cp.example/ws/tunnel"',
    );
    expect(xml!.encoding).toBe('utf16le');
    expect(xml!.content).toContain('<LogonTrigger>');
    expect(xml!.content).toContain('<UserId>OFFICE\\ada &amp; co</UserId>');
    expect(xml!.content).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml!.content).toContain('<Command>wscript.exe</Command>');
    expect(plan.install[0]).toEqual([
      'schtasks',
      '/Create',
      '/TN',
      'Odysseus Gateway',
      '/XML',
      xml!.path,
      '/F',
    ]);
    expect(plan.uninstall).toEqual([['schtasks', '/Delete', '/TN', 'Odysseus Gateway', '/F']]);
  });

  it('macOS: a launchd agent that is kept alive only after a failure', () => {
    const plan = servicePlan({ ...base, platform: 'darwin', home: '/Users/ada', uid: 502 });
    const [plist] = plan.files;
    expect(plist!.path).toBe('/Users/ada/Library/LaunchAgents/dev.odysseus.gateway.plist');
    expect(plist!.content).toContain('<string>/opt/odysseus/bin/odysseus.mjs</string>');
    expect(plist!.content).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist!.content).toMatch(
      /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin<\/string>/,
    );
    expect(plan.install).toEqual([
      ['launchctl', 'bootout', 'gui/502/dev.odysseus.gateway'],
      ['launchctl', 'bootstrap', 'gui/502', plist!.path],
    ]);
  });

  it('Linux: a systemd user unit that restarts only on failure', () => {
    const plan = servicePlan({ ...base, platform: 'linux', home: '/home/ada' });
    const [unit] = plan.files;
    expect(unit!.path).toBe('/home/ada/.config/systemd/user/odysseus-gateway.service');
    expect(unit!.content).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/odysseus/bin/odysseus.mjs" "service" "run" "--" "--project-root" "/work/app"',
    );
    expect(unit!.content).toContain('Restart=on-failure');
    expect(unit!.content).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(plan.install.at(-1)).toEqual([
      'systemctl',
      '--user',
      'enable',
      '--now',
      'odysseus-gateway.service',
    ]);
    expect(plan.notes.join(' ')).toContain('loginctl enable-linger');
  });
});

describe('gateway supervisor', () => {
  function harness(codes: Array<number | null>, durations: number[] = []) {
    let clock = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    let starts = 0;
    const supervisor = new GatewaySupervisor({
      start: (): SupervisedRun => {
        const index = starts++;
        clock += durations[index] ?? 1_000;
        return {
          exited: Promise.resolve(index < codes.length ? codes[index]! : 0),
          stop: () => undefined,
        };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      log: (message) => logs.push(message),
      now: () => clock,
      baseDelayMs: 2_000,
      maxDelayMs: 10_000,
      stableAfterMs: 60_000,
    });
    return { supervisor, sleeps, logs, starts: () => starts };
  }

  it('retries a temporary failure or a bug, backing off', async () => {
    const run = harness([75, 70, 75, 75, 0]);
    expect(await run.supervisor.run()).toBe(0);
    expect(run.sleeps).toEqual([2_000, 4_000, 8_000, 10_000]);
    expect(run.starts()).toBe(5);
  });

  it.each([
    [77, 'revoked device'],
    [78, 'configuration error'],
    [0, 'clean stop'],
  ])('does not restart after %s (%s)', async (code) => {
    const run = harness([code]);
    expect(await run.supervisor.run()).toBe(0);
    expect(run.starts()).toBe(1);
    expect(run.sleeps).toEqual([]);
  });

  it('starts the backoff again after a long healthy run', async () => {
    const run = harness([75, 75, 75, 0], [1_000, 1_000, 120_000, 1_000]);
    await run.supervisor.run();
    expect(run.sleeps).toEqual([2_000, 4_000, 2_000]);
  });

  it('exits non-zero when the gateway is killed by a signal', async () => {
    expect(await harness([null]).supervisor.run()).toBe(1);
  });

  it('does not restart once asked to stop', async () => {
    let finish: (code: number) => void = () => undefined;
    const supervisor = new GatewaySupervisor({
      start: () => ({
        exited: new Promise<number>((resolve) => (finish = resolve)),
        stop: () => finish(75),
      }),
      sleep: async () => undefined,
      log: () => undefined,
    });
    const running = supervisor.run();
    supervisor.stop();
    expect(await running).toBe(0);
  });
});
