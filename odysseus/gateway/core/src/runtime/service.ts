/**
 * Running the gateway as a background service, so it starts when you sign in
 * and agent sessions pick up again after a restart.
 *
 * The operating system only starts one small process at sign-in: the
 * supervisor (`odysseus service run`). The supervisor runs the gateway and
 * decides about restarts from its exit code — a temporary failure (75) or a
 * bug (70) is retried with backoff; a revoked device (77), a configuration
 * error (78) or a clean stop is not, because retrying those only buries the
 * cause in a crash loop.
 *
 *  - Windows: a Task Scheduler task at sign-in, launched through a tiny
 *    VBScript so no console window appears.
 *  - macOS: a launchd agent in ~/Library/LaunchAgents.
 *  - Linux: a systemd user unit (`loginctl enable-linger` starts it at boot
 *    without signing in).
 *
 * Everything here that decides what to write is pure; running the commands
 * is left to the caller.
 */
import { isRetryableExit } from './exit-codes';

export const SERVICE_NAME = 'Odysseus Gateway';
export const LAUNCHD_LABEL = 'dev.odysseus.gateway';
export const SYSTEMD_UNIT = 'odysseus-gateway.service';

export interface ServiceOptions {
  platform: 'win32' | 'darwin' | 'linux';
  home: string;
  /** Absolute path of the Node.js binary. */
  node: string;
  /** Absolute path of the `odysseus` CLI script. */
  cli: string;
  /** Extra arguments for `odysseus gateway`, e.g. project roots. */
  gatewayArgs?: string[];
  /** PATH to run with; service managers start with a minimal one. */
  path?: string;
  /** ODYSSEUS_* and CONTROL_PLANE_* variables to carry over. */
  env?: Record<string, string>;
  /** Windows: DOMAIN\user for the task. */
  windowsUser?: string;
  /** macOS: the user's uid for launchctl. */
  uid?: number;
}

export interface ServicePlan {
  /** Files to write before installing. */
  files: Array<{ path: string; content: string; encoding?: 'utf8' | 'utf16le' }>;
  install: string[][];
  uninstall: string[][];
  status: string[][];
  /** Files to remove when uninstalling. */
  remove: string[];
  notes: string[];
}

export function servicePlan(options: ServiceOptions): ServicePlan {
  const join = (...parts: string[]) =>
    parts
      .join(options.platform === 'win32' ? '\\' : '/')
      .replace(/[\\/]+/g, options.platform === 'win32' ? '\\' : '/');
  const odysseusDir = join(options.home, '.odysseus');
  const run = [options.node, options.cli, 'service', 'run', ...serviceRunArgs(options.gatewayArgs)];

  if (options.platform === 'win32') {
    const vbs = join(odysseusDir, 'service', 'odysseus-gateway.vbs');
    const xml = join(odysseusDir, 'service', 'odysseus-gateway-task.xml');
    return {
      files: [
        { path: vbs, content: windowsLauncher(run, options.env ?? {}) },
        {
          path: xml,
          content: windowsTaskXml(options.windowsUser ?? 'USER', vbs),
          encoding: 'utf16le',
        },
      ],
      install: [
        ['schtasks', '/Create', '/TN', SERVICE_NAME, '/XML', xml, '/F'],
        ['schtasks', '/Run', '/TN', SERVICE_NAME],
      ],
      uninstall: [['schtasks', '/Delete', '/TN', SERVICE_NAME, '/F']],
      status: [['schtasks', '/Query', '/TN', SERVICE_NAME, '/V', '/FO', 'LIST']],
      remove: [vbs, xml],
      notes: ['The gateway starts 30 seconds after you sign in to Windows.'],
    };
  }

  if (options.platform === 'darwin') {
    const plist = join(options.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${options.uid ?? 501}`;
    return {
      files: [
        {
          path: plist,
          content: launchdPlist(
            run,
            {
              ...(options.env ?? {}),
              ...(options.path ? { PATH: options.path } : {}),
            },
            join(odysseusDir, 'logs'),
          ),
        },
      ],
      install: [
        ['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`],
        ['launchctl', 'bootstrap', domain, plist],
      ],
      uninstall: [['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]],
      status: [['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`]],
      remove: [plist],
      notes: ['The gateway starts when you sign in to macOS.'],
    };
  }

  const unit = join(options.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
  return {
    files: [
      {
        path: unit,
        content: systemdUnit(run, {
          ...(options.env ?? {}),
          ...(options.path ? { PATH: options.path } : {}),
        }),
      },
    ],
    install: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
    ],
    uninstall: [
      ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT],
      ['systemctl', '--user', 'daemon-reload'],
    ],
    status: [['systemctl', '--user', 'status', SYSTEMD_UNIT, '--no-pager']],
    remove: [unit],
    notes: [
      'The gateway starts when you sign in. To start it at boot without signing in, run: loginctl enable-linger $USER',
    ],
  };
}

/** Gateway arguments ride after `--`, so the supervisor passes them through untouched. */
function serviceRunArgs(gatewayArgs: string[] | undefined): string[] {
  return gatewayArgs?.length ? ['--', ...gatewayArgs] : [];
}

export function windowsLauncher(command: string[], env: Record<string, string>): string {
  const quoted = command.map((part) => `""${part.replace(/"/g, '')}""`).join(' ');
  const lines = [
    "' Starts the Odysseus gateway supervisor without a console window.",
    "' Written by `odysseus service install`; removed by `odysseus service uninstall`.",
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("Process")',
    ...Object.entries(env).map(
      ([name, value]) =>
        `env("${name.replace(/[^A-Za-z0-9_]/g, '')}") = "${value.replace(/"/g, '""')}"`,
    ),
    `shell.Run "${quoted}", 0, False`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function windowsTaskXml(user: string, launcher: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Starts the Odysseus gateway when you sign in, so agent sessions continue after a restart.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${escape(user)}</UserId>`,
    '      <Delay>PT30S</Delay>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escape(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>wscript.exe</Command>',
    `      <Arguments>"${escape(launcher)}"</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

export function launchdPlist(
  command: string[],
  env: Record<string, string>,
  logDirectory: string,
): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const strings = (values: string[], indent: string) =>
    values.map((value) => `${indent}<string>${escape(value)}</string>`).join('\n');
  const environment = Object.entries(env)
    .map(
      ([name, value]) =>
        `      <key>${escape(name)}</key>\n      <string>${escape(value)}</string>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${strings(command, '      ')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>StandardOutPath</key>
    <string>${escape(logDirectory)}/service.out.log</string>
    <key>StandardErrorPath</key>
    <string>${escape(logDirectory)}/service.err.log</string>
  </dict>
</plist>
`;
}

export function systemdUnit(command: string[], env: Record<string, string>): string {
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '[Unit]',
    'Description=Odysseus gateway (keeps agent sessions going after a restart)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command.map(quote).join(' ')}`,
    // The supervisor itself exits 0 when it should stay stopped.
    'Restart=on-failure',
    'RestartSec=10',
    ...Object.entries(env).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ------------------------------------------------------------ supervisor

export interface SupervisedRun {
  /** Resolves with the exit code, or null when killed by a signal. */
  exited: Promise<number | null>;
  stop(signal: 'SIGTERM' | 'SIGINT'): void;
}

export interface SupervisorOptions {
  start(): SupervisedRun;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  now?: () => number;
  /** First retry delay; doubles each time up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A run at least this long resets the backoff. */
  stableAfterMs?: number;
}

/**
 * Run the gateway until it exits for a reason a restart will not fix.
 * Returns the exit code the supervisor should itself exit with: 0 when the
 * gateway stopped on purpose or must stay stopped (so launchd and systemd do
 * not restart it either), 1 when it was killed.
 */
export class GatewaySupervisor {
  private current: SupervisedRun | undefined;
  private stopping = false;

  constructor(private readonly options: SupervisorOptions) {}

  async run(): Promise<number> {
    const now = this.options.now ?? (() => Date.now());
    const base = this.options.baseDelayMs ?? 2_000;
    const max = this.options.maxDelayMs ?? 5 * 60_000;
    const stableAfter = this.options.stableAfterMs ?? 10 * 60_000;
    let delay = base;
    for (;;) {
      const startedAt = now();
      this.current = this.options.start();
      const code = await this.current.exited;
      this.current = undefined;
      if (this.stopping) return 0;
      if (code === null) {
        this.options.log('The gateway was stopped by a signal; not restarting.');
        return 1;
      }
      if (!isRetryableExit(code)) {
        this.options.log(
          code === 0
            ? 'The gateway stopped.'
            : `The gateway exited with ${code}, which a restart will not fix (see its log); not restarting.`,
        );
        return 0;
      }
      if (now() - startedAt >= stableAfter) delay = base;
      this.options.log(
        `The gateway exited with ${code}; restarting in ${Math.round(delay / 1000)} s.`,
      );
      await this.options.sleep(delay);
      if (this.stopping) return 0;
      delay = Math.min(max, delay * 2);
    }
  }

  /** Stop on purpose: let the gateway finish its sessions, and do not restart it. */
  stop(signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM'): void {
    this.stopping = true;
    this.current?.stop(signal);
  }
}
