import type {
  ActionDescriptor,
  ActionRiskAssessment,
  Capability,
  RiskAssessment,
  RiskClass,
} from '@odysseus/protocol';

/**
 * Scores what an agent is actually about to do: the command, the file it
 * touches, and whether it can be undone.
 *
 * The capability alone says little — `process.exec` covers both `ls` and
 * `curl … | sh`. Treating them alike means either approving `ls` forty times
 * an hour or waving through `curl | sh`, and people who approve everything
 * stop reading what they approve. So the score is built from what the
 * action touches, and every point of it comes with a reason a person can
 * read on a phone.
 *
 * Pure, synchronous and deterministic, like the rest of this package. It
 * decides nothing: the score becomes the risk class the policy engine
 * evaluates, and the deny floor still runs first.
 */

/** Score thresholds, shared with the task-level risk engine. */
export const RISK_THRESHOLDS = { medium: 0.25, high: 0.55, critical: 0.8 } as const;

export function riskLevel(score: number): RiskClass {
  if (score >= RISK_THRESHOLDS.critical) return 'critical';
  if (score >= RISK_THRESHOLDS.high) return 'high';
  if (score >= RISK_THRESHOLDS.medium) return 'medium';
  return 'low';
}

const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The higher of two risk classes. */
export function maxRiskClass(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function isRiskClass(value: unknown): value is RiskClass {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

/** Where each capability starts before anything about the action is known. */
const CAPABILITY_BASE: Record<Capability, number> = {
  'filesystem.read': 0.05,
  'filesystem.write': 0.2,
  'filesystem.delete': 0.35,
  'process.exec': 0.15,
  'network.access': 0.35,
  'package.install': 0.4,
  'git.commit': 0.3,
  'git.push': 0.6,
  'git.branch_create': 0.1,
  'git.pull_request_create': 0.3,
  'deployment.execute': 0.8,
  'secret.read': 0.6,
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CAPABILITY_BASE, value);
}

/** Added when nothing inside the project can take the action back. */
const IRREVERSIBLE_WEIGHT = 0.1;

interface Finding {
  name: string;
  weight: number;
  detail: string;
  irreversible?: boolean;
}

export function assessAction(action: ActionDescriptor): ActionRiskAssessment {
  const findings: Finding[] = [];
  const protectedBranches = new Set(['main', 'master', ...(action.protectedBranches ?? [])]);
  let recognised = true;

  switch (action.capability) {
    case 'process.exec': {
      const result = assessCommand(action.command ?? action.resource ?? '', {
        projectRoot: action.projectRoot,
        protectedBranches,
      });
      findings.push(...result.findings);
      recognised = result.recognised;
      break;
    }
    case 'filesystem.read':
    case 'filesystem.write':
    case 'filesystem.delete':
    case 'secret.read':
      if (action.resource) {
        const mode =
          action.capability === 'filesystem.write'
            ? 'write'
            : action.capability === 'filesystem.delete'
              ? 'delete'
              : 'read';
        findings.push(...assessPath(action.resource, mode, action.projectRoot));
      }
      if (action.capability === 'secret.read')
        findings.push({
          name: 'secret-exposure',
          weight: 0,
          detail: 'a secret, once read, cannot be unread',
          irreversible: true,
        });
      break;
    case 'git.push': {
      const branch = branchName(action.resource);
      findings.push({
        name: 'publishes-to-remote',
        weight: 0,
        detail: branch ? `publishes branch ${branch}` : 'publishes commits to a remote',
        irreversible: true,
      });
      if (branch && protectedBranches.has(branch))
        findings.push({
          name: 'protected-branch',
          weight: 0.3,
          detail: `pushes to protected branch ${branch}`,
        });
      if (action.force)
        findings.push({
          name: 'force-push',
          weight: 0.35,
          detail: 'force-push rewrites history others may have',
          irreversible: true,
        });
      break;
    }
    case 'git.branch_create': {
      const branch = branchName(action.resource);
      if (branch && protectedBranches.has(branch))
        findings.push({
          name: 'protected-branch',
          weight: 0.2,
          detail: `creates a branch named like protected branch ${branch}`,
        });
      break;
    }
    case 'deployment.execute':
      findings.push({
        name: 'deploys',
        weight: 0,
        detail: 'deploys to an environment others use',
        irreversible: true,
      });
      if (action.resource && PRODUCTION_MARKER.test(action.resource))
        findings.push({
          name: 'production-target',
          weight: 0.2,
          detail: `targets ${action.resource}`,
        });
      break;
    case 'network.access':
      findings.push(...assessHost(action.resource));
      break;
    case 'package.install':
    case 'git.commit':
    case 'git.pull_request_create':
      break;
  }

  const irreversible = findings.some((finding) => finding.irreversible) || !recognised;
  const factors: RiskAssessment['factors'] = [
    {
      name: `capability:${action.capability}`,
      weight: CAPABILITY_BASE[action.capability],
      contribution: CAPABILITY_BASE[action.capability],
      detail: CAPABILITY_WORDS[action.capability],
    },
  ];
  for (const finding of dedupe(findings)) {
    if (finding.weight === 0) continue;
    factors.push({
      name: finding.name,
      weight: finding.weight,
      contribution: finding.weight,
      detail: finding.detail,
    });
  }
  if (irreversible)
    factors.push({
      name: 'cannot-be-undone',
      weight: IRREVERSIBLE_WEIGHT,
      contribution: IRREVERSIBLE_WEIGHT,
      detail: recognised ? 'cannot be undone' : 'an unrecognised command may not be undoable',
    });

  const score = round(clamp(factors.reduce((sum, factor) => sum + factor.contribution, 0)));
  const level = riskLevel(score);
  return {
    score,
    level,
    factors,
    requiresApproval: score >= RISK_THRESHOLDS.high,
    reversible: !irreversible,
    summary: summarise(action, findings, !irreversible),
  };
}

// ------------------------------------------------------------ commands

interface CommandContext {
  projectRoot?: string | undefined;
  protectedBranches: Set<string>;
}

interface CommandResult {
  findings: Finding[];
  /** False when some part of the command matched nothing known. */
  recognised: boolean;
}

const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'rg',
  'ag',
  'fd',
  'wc',
  'pwd',
  'echo',
  'printf',
  'which',
  'where',
  'whereis',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'date',
  'uname',
  'whoami',
  'hostname',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'true',
  'false',
  'test',
  'jq',
  'yq',
  'awk',
  'sed',
  'nl',
  'column',
  'md5sum',
  'sha256sum',
  'shasum',
  'get-childitem',
  'get-content',
  'select-string',
  'get-location',
  'get-item',
  'test-path',
  'resolve-path',
  'measure-object',
  'write-output',
  'write-host',
  'cd',
  'set-location',
  'pushd',
  'popd',
  'sleep',
  'start-sleep',
  'clear',
  'cls',
  'history',
  'man',
  'help',
  'node',
  'python',
  'python3',
  'ruby',
  'java',
  'rustc',
  'deno',
]);

/** Read-only programs whose operands are files worth checking. */
const FILE_READERS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'rg',
  'ag',
  'fd',
  'wc',
  'tree',
  'stat',
  'file',
  'du',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'jq',
  'yq',
  'awk',
  'sed',
  'nl',
  'md5sum',
  'sha256sum',
  'shasum',
  'get-childitem',
  'get-content',
  'select-string',
  'get-item',
  'find',
]);
const PATTERN_FIRST = new Set([
  'grep',
  'egrep',
  'rg',
  'ag',
  'awk',
  'sed',
  'jq',
  'yq',
  'select-string',
]);

/** Programs whose only writes are regenerable build output. */
const BUILD_OR_TEST_PROGRAMS = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'pytest',
  'tox',
  'nox',
  'tsc',
  'eslint',
  'prettier',
  'biome',
  'ruff',
  'black',
  'isort',
  'mypy',
  'pyright',
  'flake8',
  'pylint',
  'rubocop',
  'phpunit',
  'playwright',
  'cypress',
  'tsx',
  'ts-node',
  'turbo',
  'nx',
  'vite',
  'next',
  'webpack',
  'rollup',
  'esbuild',
  'swc',
  'babel',
  'gofmt',
  'golangci-lint',
  'clippy',
  'rustfmt',
]);

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const BUILD_OR_TEST_SCRIPTS =
  /^(test|tests|lint|build|typecheck|type-check|check|format|fmt|dev|start|preview|verify|coverage|e2e|test:.*|lint:.*|build:.*|format:.*|typecheck:.*|check:.*)$/i;

/** Output directories that a build or install recreates. Deleting them loses nothing. */
const REGENERABLE =
  /^(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|coverage|target|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.tox|tsconfig\.tsbuildinfo|.*\.tsbuildinfo|\.eslintcache)$/i;

const PRODUCTION_MARKER = /\b(prod|production|live)\b|--prod\b/i;

const REMOTE_CODE =
  /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby|php|iex|invoke-expression|powershell|pwsh)\b/i;
const OBFUSCATED =
  /\bbase64\s+(-d|--decode|-D)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b|\bfrombase64string\b/i;
const DESTRUCTIVE_SQL =
  /\b(drop\s+(table|database|schema|index|view)|truncate\s+(table\s+)?\w|delete\s+from\s+\w+\s*(;|$|"|'))/i;

export function assessCommand(command: string, context: CommandContext): CommandResult {
  const trimmed = command.trim();
  if (!trimmed) return { findings: [], recognised: false };
  const findings: Finding[] = [];
  let recognised = true;

  if (REMOTE_CODE.test(trimmed))
    findings.push({
      name: 'remote-code-execution',
      weight: 0.75,
      detail: 'downloads a script and runs it unseen',
      irreversible: true,
    });
  if (OBFUSCATED.test(trimmed))
    findings.push({
      name: 'obfuscated-execution',
      weight: 0.5,
      detail: 'decodes hidden content and runs it',
      irreversible: true,
    });
  if (DESTRUCTIVE_SQL.test(trimmed))
    findings.push({
      name: 'destructive-sql',
      weight: 0.5,
      detail: 'drops or empties database data',
      irreversible: true,
    });

  const segments = splitSegments(trimmed);
  let allReadOnly = segments.length > 0;
  for (const segment of segments) {
    const result = assessSegment(segment, context);
    findings.push(...result.findings);
    if (!result.recognised) recognised = false;
    if (!result.readOnly) allReadOnly = false;
  }

  if (allReadOnly && findings.every((finding) => finding.weight <= 0))
    findings.push({ name: 'read-only-command', weight: -0.1, detail: 'only reads' });
  return { findings, recognised };
}

interface SegmentResult {
  findings: Finding[];
  recognised: boolean;
  readOnly: boolean;
}

function assessSegment(segment: string, context: CommandContext): SegmentResult {
  const findings: Finding[] = [];
  let tokens = tokenize(segment);

  // Output redirected into a file is a write to that file.
  for (const target of redirectTargets(segment))
    findings.push(...assessPath(target, 'write', context.projectRoot));

  // Leading `VAR=value` assignments set the environment of what follows.
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);

  // Elevation wraps another command; judge that one too.
  if (tokens[0] && /^(sudo|doas|runas|su)$/i.test(program(tokens[0]))) {
    findings.push({
      name: 'elevated-privileges',
      weight: 0.35,
      detail: `runs as another user (${program(tokens[0])})`,
    });
    tokens = tokens.slice(1);
    while (tokens[0]?.startsWith('-')) tokens = tokens.slice(1);
  }
  if (tokens.length === 0) return { findings, recognised: true, readOnly: findings.length === 0 };

  const name = program(tokens[0]!);
  const args = tokens.slice(1);
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  const add = (finding: Finding) => findings.push(finding);

  // A nested shell: judge the command it is handed.
  if (/^(sh|bash|zsh|dash|cmd|powershell|pwsh)$/.test(name)) {
    const flag = lowerArgs.findIndex((arg) => arg === '-c' || arg === '/c' || arg === '-command');
    const inner = flag >= 0 ? args.slice(flag + 1).join(' ') : '';
    if (inner) {
      const nested = assessCommand(inner, context);
      return {
        findings: [...findings, ...nested.findings],
        recognised: nested.recognised,
        readOnly: false,
      };
    }
    if (args.length > 0) {
      add({ name: 'runs-script', weight: 0.15, detail: `runs script ${args[0]}` });
      return { findings, recognised: true, readOnly: false };
    }
  }

  if (name === 'git') return withGit(findings, args, context);
  if (SCRIPT_RUNNERS.has(name) || name === 'npx' || name === 'pnpx' || name === 'bunx')
    return withPackageManager(findings, name, args);
  if (/^(pip|pip3|uv|poetry|pipx|conda|gem|cargo|go|composer|dotnet|mvn|gradle|make)$/.test(name))
    return withToolchain(findings, name, lowerArgs);

  if (/^(rm|rmdir|rd|del|erase|remove-item|unlink|shred)$/.test(name))
    return withDelete(findings, name, args, context);

  if (/^(mv|cp|move|copy|move-item|copy-item|rename|ren|xcopy|robocopy|ln|mklink)$/.test(name)) {
    const target = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('/')).at(-1);
    if (target) findings.push(...assessPath(target, 'write', context.projectRoot));
    add({ name: 'moves-files', weight: 0.1, detail: `${name} ${args.join(' ')}`.trim() });
    return { findings, recognised: true, readOnly: false };
  }

  if (/^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|http|httpie|xh)$/.test(name))
    return withHttp(findings, name, args, lowerArgs);

  if (/^(ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp)$/.test(name)) {
    add({
      name: 'remote-connection',
      weight: 0.4,
      detail: `opens a connection to another machine (${name})`,
      irreversible: true,
    });
    return { findings, recognised: true, readOnly: false };
  }

  if (/^(env|printenv|set|get-childitem)$/.test(name) && isEnvironmentDump(name, lowerArgs)) {
    add({
      name: 'prints-environment',
      weight: 0.35,
      detail: 'prints environment variables, which often hold secrets',
      irreversible: true,
    });
    return { findings, recognised: true, readOnly: false };
  }
  // `env FOO=1 cmd` runs cmd; `set -e` only changes shell options.
  if (name === 'env') {
    const inner = args.filter(
      (arg) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && !arg.startsWith('-'),
    );
    const nested = assessSegment(inner.join(' '), context);
    return { ...nested, findings: [...findings, ...nested.findings] };
  }
  if (name === 'set') return { findings, recognised: true, readOnly: findings.length === 0 };

  if (/^(chmod|chown|chgrp|icacls|takeown|setfacl)$/.test(name)) {
    const broad = lowerArgs.some((arg) => arg === '-r' || arg === '--recursive' || /777/.test(arg));
    add({
      name: 'changes-permissions',
      weight: broad ? 0.25 : 0.1,
      detail: broad ? 'changes permissions broadly' : 'changes file permissions',
    });
    return { findings, recognised: true, readOnly: false };
  }

  if (/^(kill|pkill|killall|taskkill|stop-process)$/.test(name)) {
    add({ name: 'stops-processes', weight: 0.15, detail: 'stops running processes' });
    return { findings, recognised: true, readOnly: false };
  }
  if (/^(shutdown|reboot|halt|poweroff|restart-computer|stop-computer)$/.test(name)) {
    add({
      name: 'stops-machine',
      weight: 0.5,
      detail: 'shuts down or restarts the machine',
      irreversible: true,
    });
    return { findings, recognised: true, readOnly: false };
  }
  if (/^(setx|reg|set-executionpolicy|launchctl|systemctl|crontab|schtasks|defaults)$/.test(name)) {
    add({
      name: 'system-configuration',
      weight: 0.4,
      detail: `changes machine configuration (${name})`,
      irreversible: true,
    });
    return { findings, recognised: true, readOnly: false };
  }
  if (/^(apt|apt-get|yum|dnf|pacman|brew|choco|winget|scoop|snap|apk|port)$/.test(name)) {
    const mutating = lowerArgs.some((arg) =>
      /^(install|remove|uninstall|purge|upgrade|update|add|del)$/.test(arg),
    );
    if (mutating)
      add({
        name: 'system-package-install',
        weight: 0.25,
        detail: `changes system packages (${name} ${args[0] ?? ''})`.trim(),
      });
    return { findings, recognised: true, readOnly: !mutating };
  }

  if (/^(kubectl|helm|terraform|tofu|pulumi|cdk|serverless|sls)$/.test(name))
    return withInfrastructure(findings, name, lowerArgs);
  if (
    /^(vercel|netlify|fly|flyctl|firebase|heroku|railway|render|wrangler|gcloud|az|aws|eb)$/.test(
      name,
    )
  )
    return withDeploymentCli(findings, name, lowerArgs, segment);
  if (name === 'docker' || name === 'podman') return withContainer(findings, lowerArgs, segment);
  if (/^(psql|mysql|sqlite3|mongosh|mongo|redis-cli|sqlcmd|cockroach)$/.test(name)) {
    if (!findings.some((finding) => finding.name === 'destructive-sql'))
      add({ name: 'database-client', weight: 0.2, detail: `talks to a database (${name})` });
    return { findings, recognised: true, readOnly: false };
  }
  if (
    /^(prisma|rails|rake|alembic|knex|sequelize|typeorm|drizzle-kit|flyway|liquibase)$/.test(name)
  )
    return withMigration(findings, name, lowerArgs);

  if (BUILD_OR_TEST_PROGRAMS.has(name))
    return { findings, recognised: true, readOnly: findings.length === 0 };

  if (READ_ONLY_PROGRAMS.has(name)) {
    // Interpreters are only read-only with nothing to run; `node script.js` runs project code.
    if (/^(node|python|python3|ruby|java|rustc|deno)$/.test(name)) {
      if (lowerArgs.length === 0 || lowerArgs.every((arg) => /^--?(v|version|h|help)$/.test(arg)))
        return { findings, recognised: true, readOnly: findings.length === 0 };
      const moduleFlag = lowerArgs.indexOf('-m');
      if (moduleFlag >= 0 && lowerArgs[moduleFlag + 1]) {
        const module = lowerArgs[moduleFlag + 1]!;
        if (module === 'pip')
          return withToolchain(findings, 'pip', lowerArgs.slice(moduleFlag + 2));
        if (
          /^(pytest|unittest|mypy|ruff|black|flake8|pylint|isort|tox|nox|coverage|compileall)$/.test(
            module,
          )
        )
          return { findings, recognised: true, readOnly: false };
      }
      const inline = lowerArgs.some((arg) => arg === '-c' || arg === '-e' || arg === '--eval');
      add({
        name: inline ? 'inline-code' : 'runs-project-code',
        weight: inline ? 0.2 : 0.15,
        detail: inline ? `runs inline ${name} code` : `runs ${args[0] ?? name}`,
      });
      return { findings, recognised: true, readOnly: false };
    }
    if (name === 'sed' && lowerArgs.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
      const target = args.filter((arg) => !arg.startsWith('-')).at(-1);
      if (target) findings.push(...assessPath(target, 'write', context.projectRoot));
      add({ name: 'edits-file', weight: 0.05, detail: 'edits a file in place' });
      return { findings, recognised: true, readOnly: false };
    }
    if (name === 'find' && lowerArgs.some((arg) => arg === '-delete' || arg === '-exec')) {
      add({
        name: 'find-and-act',
        weight: 0.35,
        detail: 'finds files and deletes or runs commands on them',
        irreversible: true,
      });
      return { findings, recognised: true, readOnly: false };
    }
    if (FILE_READERS.has(name)) {
      const operands = args.filter((item) => !item.startsWith('-'));
      // grep-like tools take a pattern before their files.
      for (const arg of PATTERN_FIRST.has(name) ? operands.slice(1) : operands)
        findings.push(
          ...assessPath(arg, 'read', context.projectRoot).filter((item) => item.weight > 0),
        );
    }
    return { findings, recognised: true, readOnly: findings.length === 0 };
  }

  if (/^(tee|touch|mkdir|md|new-item|set-content|add-content|out-file|truncate)$/.test(name)) {
    const targets = args.filter((arg) => !arg.startsWith('-'));
    for (const target of targets)
      findings.push(...assessPath(target, 'write', context.projectRoot));
    return { findings, recognised: true, readOnly: false };
  }

  add({
    name: 'unrecognised-command',
    weight: 0.2,
    detail: `runs ${name}, which Odysseus does not recognise`,
  });
  if (/deploy|release|publish|prod/i.test(name))
    add({ name: 'deploy-script', weight: 0.3, detail: `${name} looks like a deployment script` });
  return { findings, recognised: false, readOnly: false };
}

function withGit(findings: Finding[], args: string[], context: CommandContext): SegmentResult {
  // `git -C dir status`: skip global options to find the subcommand.
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) {
    index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
  }
  const sub = (args[index] ?? '').toLowerCase();
  const rest = args.slice(index + 1);
  const lower = rest.map((arg) => arg.toLowerCase());
  const has = (...flags: string[]) => lower.some((arg) => flags.includes(arg));
  const add = (finding: Finding) => findings.push(finding);
  const done = (readOnly = false): SegmentResult => ({ findings, recognised: true, readOnly });

  switch (sub) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'rev-parse':
    case 'ls-files':
    case 'blame':
    case 'describe':
    case 'shortlog':
    case 'grep':
    case 'reflog':
    case 'fetch':
    case 'remote':
    case 'config':
      if (sub === 'config' && has('--global', '--system'))
        add({
          name: 'global-git-config',
          weight: 0.2,
          detail: 'changes git configuration for every repository',
        });
      else if (
        sub === 'remote' &&
        lower.some((arg) => /^(add|remove|rm|set-url|rename)$/.test(arg))
      )
        add({
          name: 'changes-remote',
          weight: 0.2,
          detail: 'changes where this repository pushes',
        });
      else if (sub === 'config' && rest.filter((arg) => !arg.startsWith('-')).length >= 2)
        add({
          name: 'changes-git-config',
          weight: 0.1,
          detail: 'changes repository git configuration',
        });
      return done(findings.length === 0);
    case 'branch':
      if (has('-d', '--delete'))
        add({
          name: 'deletes-branch',
          weight: 0.2,
          detail: 'deletes a local branch (recoverable from the reflog)',
        });
      else if (rest.some((arg) => !arg.startsWith('-')))
        add({ name: 'creates-branch', weight: 0.05, detail: 'creates a branch' });
      return done(findings.length === 0);
    case 'stash':
      if (has('drop', 'clear'))
        add({
          name: 'drops-stash',
          weight: 0.2,
          detail: 'throws away stashed work',
          irreversible: true,
        });
      else add({ name: 'git-stash', weight: 0.05, detail: 'git stash' });
      return done();
    case 'add':
    case 'switch':
    case 'tag':
    case 'worktree':
    case 'mv':
    case 'init':
    case 'clone':
    case 'pull':
    case 'cherry-pick':
    case 'revert':
      add({ name: `git-${sub}`, weight: 0.05, detail: `git ${sub}` });
      return done();
    case 'commit':
      add({ name: 'git-commit', weight: 0.15, detail: 'records a local commit' });
      return done();
    case 'merge':
    case 'rebase':
    case 'am':
    case 'apply':
      add({ name: `git-${sub}`, weight: 0.15, detail: `git ${sub} (recoverable from the reflog)` });
      return done();
    case 'checkout':
    case 'restore': {
      // `git restore <path>` and `git checkout -- <path>` overwrite working-tree edits.
      const discards =
        sub === 'restore'
          ? !has('--staged') || has('--worktree', '-w')
          : rest.includes('--') ||
            lower.some((arg) => arg === '.' || arg === ':/') ||
            has('-f', '--force');
      if (discards)
        add({
          name: 'discards-changes',
          weight: 0.4,
          detail: 'discards uncommitted changes',
          irreversible: true,
        });
      else add({ name: `git-${sub}`, weight: 0.05, detail: `git ${sub}` });
      return done();
    }
    case 'reset':
      if (has('--hard', '--merge', '--keep'))
        add({
          name: 'discards-changes',
          weight: 0.4,
          detail: 'git reset --hard discards uncommitted changes',
          irreversible: true,
        });
      else
        add({
          name: 'git-reset',
          weight: 0.1,
          detail: 'moves the branch pointer (recoverable from the reflog)',
        });
      return done();
    case 'clean':
      if (lower.some((arg) => /^-[a-z]*f/.test(arg) || arg === '--force'))
        add({
          name: 'deletes-untracked',
          weight: 0.4,
          detail: 'deletes untracked files',
          irreversible: true,
        });
      return done(findings.length === 0);
    case 'push': {
      add({
        name: 'publishes-to-remote',
        weight: 0.45,
        detail: 'publishes commits to a remote',
        irreversible: true,
      });
      if (
        has('--force', '-f', '--force-with-lease', '--mirror') ||
        rest.some((arg) => arg.startsWith('+'))
      )
        add({
          name: 'force-push',
          weight: 0.35,
          detail: 'force-push rewrites history others may have',
          irreversible: true,
        });
      if (has('--delete', '-d') || rest.some((arg) => /^:[^/]/.test(arg)))
        add({
          name: 'deletes-remote-branch',
          weight: 0.3,
          detail: 'deletes a branch on the remote',
          irreversible: true,
        });
      const targets = rest
        .filter((arg) => !arg.startsWith('-'))
        .flatMap((arg) => arg.replace(/^\+/, '').split(':'))
        .map((ref) => ref.replace(/^refs\/heads\//, ''));
      const hit = targets.find((ref) => context.protectedBranches.has(ref));
      if (hit)
        add({ name: 'protected-branch', weight: 0.3, detail: `pushes to protected branch ${hit}` });
      return done();
    }
    case 'filter-branch':
    case 'filter-repo':
      add({
        name: 'rewrites-history',
        weight: 0.5,
        detail: 'rewrites the whole repository history',
        irreversible: true,
      });
      return done();
    case 'gc':
    case 'prune':
      add({
        name: 'prunes-objects',
        weight: 0.2,
        detail: 'permanently removes unreachable commits',
        irreversible: true,
      });
      return done();
    default:
      add({ name: 'git-other', weight: 0.15, detail: `git ${sub || '(no subcommand)'}` });
      return done();
  }
}

function withPackageManager(findings: Finding[], name: string, args: string[]): SegmentResult {
  const lower = args.map((arg) => arg.toLowerCase());
  const add = (finding: Finding) => findings.push(finding);
  const done = (readOnly = false): SegmentResult => ({ findings, recognised: true, readOnly });

  if (
    name === 'npx' ||
    name === 'pnpx' ||
    name === 'bunx' ||
    lower[0] === 'dlx' ||
    lower[0] === 'exec'
  ) {
    const tool = (name === 'npx' || name === 'pnpx' || name === 'bunx' ? args : args.slice(1)).find(
      (arg) => !arg.startsWith('-'),
    );
    if (tool && BUILD_OR_TEST_PROGRAMS.has(program(tool).replace(/@.*$/, ''))) return done();
    add({
      name: 'runs-registry-package',
      weight: 0.25,
      detail: `downloads and runs ${tool ?? 'a package'} from the registry`,
    });
    return done();
  }

  // Skip options before the subcommand: `pnpm -r test`, `pnpm --filter web build`.
  const positional: string[] = [];
  for (let index = 0; index < lower.length; index++) {
    const arg = lower[index]!;
    if (arg.startsWith('-')) {
      if (/^(--filter|-f|--dir|-c|--prefix|--workspace|-w|--cwd)$/.test(arg) && !arg.includes('='))
        index++;
      continue;
    }
    positional.push(arg);
  }
  const sub = positional[0] ?? '';
  const rest = positional.slice(1);
  const global = lower.includes('-g') || lower.includes('--global');

  if (/^(publish|pack|release|deprecate|unpublish|dist-tag)$/.test(sub)) {
    add({
      name: 'publishes-package',
      weight: 0.6,
      detail: `${name} ${sub} publishes to a public registry`,
      irreversible: true,
    });
    return done();
  }
  if (
    /^(install|i|add|ci|update|upgrade|up|remove|rm|uninstall|un)$/.test(sub) ||
    (sub === '' && name !== 'npm')
  ) {
    if (global)
      add({
        name: 'global-install',
        weight: 0.2,
        detail: `${name} installs globally, outside the project`,
      });
    if (rest.length > 0 && /^(install|i|add)$/.test(sub))
      add({
        name: 'adds-dependency',
        weight: 0.3,
        detail: `adds ${rest.slice(0, 3).join(', ')}, which run install scripts`,
      });
    else
      add({
        name: 'installs-dependencies',
        weight: 0.15,
        detail: `${name} ${sub || 'install'} runs dependency install scripts`,
      });
    return done();
  }
  const script = sub === 'run' || sub === 'run-script' ? (rest[0] ?? '') : sub;
  if (BUILD_OR_TEST_SCRIPTS.test(script)) return done();
  if (/^(audit|outdated|ls|list|why|view|info|config|help|--version|-v|whoami|cache)$/.test(sub))
    return done(true);
  add({
    name: 'runs-project-script',
    weight: 0.15,
    detail: `runs the project's ${script || sub} script`,
  });
  return done();
}

function withToolchain(findings: Finding[], name: string, lower: string[]): SegmentResult {
  const sub = lower.find((arg) => !arg.startsWith('-')) ?? '';
  const add = (finding: Finding) => findings.push(finding);
  const done = (readOnly = false): SegmentResult => ({ findings, recognised: true, readOnly });
  if (
    /^(publish|push|upload|release|deploy)$/.test(sub) ||
    (name === 'dotnet' && sub === 'nuget')
  ) {
    add({
      name: 'publishes-package',
      weight: 0.6,
      detail: `${name} ${sub} publishes to a registry`,
      irreversible: true,
    });
    return done();
  }
  if (
    /^(test|build|check|vet|fmt|lint|clippy|compile|verify|package|run)$/.test(sub) ||
    (name === 'make' && sub === '')
  ) {
    if (sub === 'run')
      add({ name: 'runs-project-code', weight: 0.15, detail: `${name} run executes project code` });
    return done();
  }
  if (/^(install|add|get|sync|update|upgrade|require|restore|lock)$/.test(sub)) {
    const named = lower.filter((arg) => !arg.startsWith('-')).slice(1);
    const fromFile = lower.includes('-r') || lower.includes('--requirement') || named.length === 0;
    add(
      fromFile
        ? {
            name: 'installs-dependencies',
            weight: 0.15,
            detail: `${name} ${sub} installs dependencies`,
          }
        : {
            name: 'adds-dependency',
            weight: 0.3,
            detail: `adds ${named.slice(0, 3).join(', ')}, which may run install scripts`,
          },
    );
    return done();
  }
  if (name === 'make') {
    add({ name: 'runs-project-script', weight: 0.15, detail: `runs make target ${sub}` });
    return done();
  }
  add({ name: 'toolchain-command', weight: 0.15, detail: `${name} ${sub}`.trim() });
  return done();
}

function withDelete(
  findings: Finding[],
  name: string,
  args: string[],
  context: CommandContext,
): SegmentResult {
  const lower = args.map((arg) => arg.toLowerCase());
  const recursive =
    name === 'rmdir' ||
    name === 'rd' ||
    (name === 'remove-item'
      ? lower.some((arg) => arg === '-recurse' || arg === '-r')
      : name === 'del' || name === 'erase'
        ? lower.includes('/s')
        : args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg)) || lower.includes('--recursive'));
  const targets = args.filter((arg) => !/^(-|\/[a-z]$)/i.test(arg));
  const regenerable =
    targets.length > 0 && targets.every((target) => REGENERABLE.test(lastSegment(target)));

  for (const target of targets) findings.push(...assessPath(target, 'delete', context.projectRoot));
  if (regenerable) {
    findings.push({
      name: 'regenerable-output',
      weight: 0.05,
      detail: `deletes ${targets.map(lastSegment).join(', ')}, which a build or install recreates`,
    });
  } else if (recursive) {
    findings.push({
      name: 'recursive-delete',
      weight: 0.45,
      detail: `deletes ${targets.join(', ') || 'a directory'} and everything in it`,
      irreversible: true,
    });
  } else {
    findings.push({
      name: 'deletes-files',
      weight: 0.2,
      detail: `deletes ${targets.join(', ') || 'files'}`,
      irreversible: true,
    });
  }
  return { findings, recognised: true, readOnly: false };
}

function withHttp(
  findings: Finding[],
  name: string,
  args: string[],
  lower: string[],
): SegmentResult {
  // Short flags are case-sensitive: curl's -f is --fail, -F is a form upload.
  const uploads =
    args.some((arg) => /^-[dFT]/.test(arg)) ||
    lower.some((arg) =>
      /^(--data|--form|--upload-file|--json|--post-data|--post-file|-infile|-body)/.test(arg),
    ) ||
    lower.some(
      (arg, index) =>
        (arg === '-x' || arg === '--request' || arg === '-method') &&
        /^(post|put|patch)$/.test(lower[index + 1] ?? ''),
    ) ||
    ((name === 'http' || name === 'httpie' || name === 'xh') &&
      /^(post|put|patch)$/.test(lower[0] ?? ''));
  const url = args.find((arg) => /^https?:\/\//i.test(arg));
  // `-d @file`, `-F part=@file` and `-T file` send a file's contents.
  const sent = args.flatMap((arg, index) => {
    const inline = /^@(.+)$/.exec(arg) ?? /=@([^;]+)/.exec(arg);
    if (inline) return [inline[1]!];
    if (/^(-T|--upload-file|-InFile)$/i.test(arg) && args[index + 1]) return [args[index + 1]!];
    return [];
  });
  for (const file of sent) findings.push(...assessPath(file, 'read', undefined));
  if (uploads) {
    findings.push({
      name: 'uploads-data',
      weight: 0.45,
      detail: `sends data to ${url ? hostOf(url) : 'another server'}`,
      irreversible: true,
    });
  } else {
    findings.push({
      name: 'network-download',
      weight: 0.15,
      detail: `downloads from ${url ? hostOf(url) : 'the network'}`,
    });
  }
  return { findings, recognised: true, readOnly: false };
}

function withInfrastructure(findings: Finding[], name: string, lower: string[]): SegmentResult {
  const sub = lower.find((arg) => !arg.startsWith('-')) ?? '';
  const add = (finding: Finding) => findings.push(finding);
  const done = (readOnly = false): SegmentResult => ({ findings, recognised: true, readOnly });
  if (
    /^(get|describe|logs|plan|validate|fmt|show|output|version|diff|preview|lint|template|status|top|explain)$/.test(
      sub,
    )
  )
    return done(true);
  const destroys = /^(delete|destroy|uninstall|drain|cordon)$/.test(sub);
  add({
    name: destroys ? 'destroys-infrastructure' : 'changes-infrastructure',
    weight: destroys ? 0.65 : 0.5,
    detail: `${name} ${sub} changes live infrastructure`,
    irreversible: true,
  });
  if (lower.some((arg) => PRODUCTION_MARKER.test(arg)))
    add({ name: 'production-target', weight: 0.2, detail: 'targets production' });
  return done();
}

function withDeploymentCli(
  findings: Finding[],
  name: string,
  lower: string[],
  segment: string,
): SegmentResult {
  const readOnly =
    lower.some((arg) =>
      /^(ls|list|logs|whoami|login|status|info|describe|get|version|--version|help|env)$/.test(arg),
    ) &&
    !lower.some((arg) =>
      /^(deploy|delete|destroy|rm|remove|publish|up|release|promote)$/.test(arg),
    );
  if (readOnly) return { findings, recognised: true, readOnly: true };
  const destroys = lower.some((arg) =>
    /^(delete|destroy|rm|remove|terminate-instances|delete-bucket)$/.test(arg),
  );
  findings.push({
    name: destroys ? 'destroys-infrastructure' : 'deploys',
    weight: destroys ? 0.65 : 0.5,
    detail: `${name} ${destroys ? 'deletes cloud resources' : 'deploys or changes cloud resources'}`,
    irreversible: true,
  });
  if (PRODUCTION_MARKER.test(segment))
    findings.push({ name: 'production-target', weight: 0.2, detail: 'targets production' });
  return { findings, recognised: true, readOnly: false };
}

function withContainer(findings: Finding[], lower: string[], segment: string): SegmentResult {
  const sub = lower.find((arg) => !arg.startsWith('-')) ?? '';
  if (
    /^(ps|images|logs|inspect|version|info|build|pull|compose)$/.test(sub) &&
    !/\bcompose\b.*\b(down\s+-v|rm)\b/.test(segment)
  )
    return {
      findings,
      recognised: true,
      readOnly: sub !== 'build' && sub !== 'pull' && sub !== 'compose',
    };
  if (sub === 'push') {
    findings.push({
      name: 'publishes-package',
      weight: 0.6,
      detail: 'pushes an image to a registry',
      irreversible: true,
    });
  } else if (sub === 'run' || sub === 'exec') {
    const privileged = /--privileged|-v\s+\/:|--volume[= ]\/:|--pid[= ]host|--network[= ]host/.test(
      segment,
    );
    findings.push({
      name: privileged ? 'privileged-container' : 'runs-container',
      weight: privileged ? 0.45 : 0.15,
      detail: privileged ? 'runs a container with access to the host' : 'runs a container',
    });
  } else {
    findings.push({
      name: 'changes-containers',
      weight: 0.15,
      detail: `docker ${sub} removes or changes containers`,
      irreversible: /^(rm|rmi|prune|system|volume)$/.test(sub),
    });
  }
  return { findings, recognised: true, readOnly: false };
}

function withMigration(findings: Finding[], name: string, lower: string[]): SegmentResult {
  const text = lower.join(' ');
  if (/\b(reset|drop|force-reset|db:drop|db:reset|downgrade|rollback|undo)\b/.test(text))
    findings.push({
      name: 'destroys-database',
      weight: 0.5,
      detail: `${name} ${text} drops or resets database data`,
      irreversible: true,
    });
  else if (/\b(migrate|push|deploy|db:migrate|upgrade|up)\b/.test(text))
    findings.push({
      name: 'migrates-database',
      weight: 0.2,
      detail: `${name} changes the database schema`,
    });
  else findings.push({ name: 'database-tool', weight: 0.1, detail: `${name} ${text}`.trim() });
  return { findings, recognised: true, readOnly: false };
}

// ------------------------------------------------------------ paths

type PathMode = 'read' | 'write' | 'delete';

const SECRET_FILE =
  /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|[^/]*\.(pem|key|p12|pfx|jks|keystore|ppk)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account[^/]*\.json|kubeconfig|\.git-credentials)$|(^|\/)\.(ssh|aws|gnupg|kube|docker)\//i;
const AGENT_CONFIG =
  /(^|\/)(\.claude\/|\.cursor\/|\.codex\/|\.opencode\/|\.gemini\/|\.windsurf\/|\.continue\/|\.aider[^/]*$|\.mcp\.json$|mcp\.json$|opencode\.jsonc?$|AGENTS\.md$|CLAUDE\.md$|GEMINI\.md$|\.cursorrules$|\.windsurfrules$|\.clinerules|\.vscode\/(settings|tasks|launch)\.json$|\.git\/hooks\/|\.git\/config$|\.husky\/|\.gitmodules$|\.odysseus\/)/i;
const CI_PIPELINE =
  /(^|\/)(\.github\/workflows\/|\.github\/actions\/|\.gitlab-ci\.yml$|\.circleci\/|Jenkinsfile$|azure-pipelines\.ya?ml$|\.buildkite\/|bitbucket-pipelines\.yml$|\.travis\.yml$|\.drone\.yml$)/i;
const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|pnpm-workspace\.yaml)$/i;
const DEPLOYMENT_CONFIG =
  /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|[^/]*\.tf|[^/]*\.tfvars|render\.yaml|vercel\.json|fly\.toml|netlify\.toml|app\.ya?ml|serverless\.ya?ml|Procfile|k8s\/[^/]+|helm\/[^/]+|charts\/[^/]+)$/i;

export function assessPath(rawPath: string, mode: PathMode, projectRoot?: string): Finding[] {
  const path = normalisePath(rawPath);
  if (!path || path === '/dev/null' || path.toLowerCase() === 'nul') return [];
  const findings: Finding[] = [];
  const verb = mode === 'read' ? 'reads' : mode === 'write' ? 'writes' : 'deletes';

  if (SECRET_FILE.test(path))
    findings.push({
      name: 'secret-file',
      weight: 0.45,
      detail: `${verb} ${path}, which holds secrets`,
      irreversible: mode !== 'write',
    });
  if (mode !== 'read') {
    if (AGENT_CONFIG.test(path))
      findings.push({
        name: 'agent-config',
        weight: 0.45,
        detail: `${verb} ${path}, which changes how agents or git behave next time`,
      });
    else if (CI_PIPELINE.test(path))
      findings.push({
        name: 'ci-pipeline',
        weight: 0.35,
        detail: `${verb} ${path}, which runs in CI with its secrets`,
      });
    else if (DEPLOYMENT_CONFIG.test(path))
      findings.push({
        name: 'deployment-config',
        weight: 0.2,
        detail: `${verb} deployment file ${path}`,
      });
    else if (DEPENDENCY_MANIFEST.test(path))
      findings.push({
        name: 'dependency-manifest',
        weight: 0.15,
        detail: `${verb} dependency file ${path}`,
      });
    if (/(^|\/)\.git(\/|$)/.test(path) && !AGENT_CONFIG.test(path))
      findings.push({
        name: 'git-internals',
        weight: 0.4,
        detail: `${verb} git's own data in ${path}`,
        irreversible: true,
      });
  }
  const outside = outsideProject(path, projectRoot);
  if (outside)
    findings.push({
      name: 'outside-project',
      weight: mode === 'read' ? 0.15 : 0.3,
      detail: `${verb} ${path}, outside the project`,
      irreversible: mode !== 'read',
    });
  return findings;
}

function outsideProject(path: string, projectRoot?: string): boolean {
  if (/^(~|\$home|\$env:userprofile|%userprofile%)(\/|$)/i.test(path)) return true;
  if (path === '/' || path === '/*' || /^[a-z]:\/?\*?$/i.test(path)) return true;
  const absolute = path.startsWith('/') || /^[a-z]:\//i.test(path);
  if (absolute) {
    if (!projectRoot)
      return (
        /^\/(etc|usr|bin|sbin|var|boot|sys|proc|root|opt|lib)(\/|$)/i.test(path) ||
        /^[a-z]:\/(windows|program files)/i.test(path)
      );
    const root = normalisePath(projectRoot).replace(/\/+$/, '');
    const caseless = /^[a-z]:\//i.test(root);
    const a = caseless ? path.toLowerCase() : path;
    const b = caseless ? root.toLowerCase() : root;
    return !(a === b || a.startsWith(`${b}/`));
  }
  // A relative path escapes when its `..` segments outnumber what came before them.
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment === '..') depth--;
    else if (segment && segment !== '.') depth++;
    if (depth < 0) return true;
  }
  return false;
}

function assessHost(resource?: string): Finding[] {
  if (!resource) return [];
  const host = hostOf(resource);
  if (
    /(^|\.)(registry\.npmjs\.org|npmjs\.com|pypi\.org|files\.pythonhosted\.org|crates\.io|proxy\.golang\.org|rubygems\.org|github\.com|githubusercontent\.com|repo\.maven\.apache\.org|nuget\.org)$/i.test(
      host,
    )
  )
    return [
      { name: 'known-registry', weight: -0.15, detail: `connects to ${host}, a package registry` },
    ];
  return [{ name: 'unknown-host', weight: 0.1, detail: `connects to ${host}` }];
}

// ------------------------------------------------------------ write targets

/** `git config` keys whose value git later runs as a command. */
const EXECUTING_GIT_CONFIG =
  /^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)|alias\..+|credential\..*helper|include\.path|includeif\..+|filter\..+\.(clean|smudge|process)|diff\..+\.textconv|sequence\.editor|uploadpack\.packobjectshook)$/i;

/**
 * The settings in a git config file that git would later execute, as
 * `section.subsection.key=value` lines. Two files with the same list can
 * differ only in harmless ways — an upstream branch set by `git push -u`, a
 * user name — so this is what "changed" means for `.git/config`.
 */
export function executingGitConfig(text: string): string[] {
  const found: string[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s[;#].*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (header) {
      const name = header[1]!.toLowerCase();
      section = header[2] !== undefined ? `${name}.${header[2]}` : name;
      continue;
    }
    const entry = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!entry || !section) continue;
    const key = `${section}.${entry[1]!.toLowerCase()}`;
    if (EXECUTING_GIT_CONFIG.test(key)) found.push(`${key}=${(entry[2] ?? 'true').trim()}`);
  }
  return found.sort();
}

/**
 * The files a shell command writes, as far as its text shows: redirections,
 * `tee`, `touch`, `cp`/`mv` destinations, `sed -i`, `curl -o`, `dd of=`, the
 * PowerShell equivalents, and `git config` keys that git later executes
 * (reported as `.git/config`, or `~/.gitconfig` with `--global`).
 *
 * Best effort: code in an inline interpreter (`python -c "open(...)"`) is
 * invisible here, which is why the risk score treats inline code as risky
 * and the gateway checks protected files after the fact as well.
 */
export function commandWriteTargets(command: string): string[] {
  const targets = new Set<string>();
  for (const segment of splitSegments(command)) {
    for (const target of redirectTargets(segment)) targets.add(normalisePath(target));
    let tokens = tokenize(segment);
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    while (tokens[0] && /^(sudo|doas|env|nohup|time|exec)$/i.test(program(tokens[0]))) {
      tokens = tokens.slice(1);
      while (tokens[0] && (tokens[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[0])))
        tokens = tokens.slice(1);
    }
    if (tokens.length === 0) continue;
    const name = program(tokens[0]!);
    const args = tokens.slice(1);
    const operands = args.filter((arg) => !arg.startsWith('-'));
    const add = (path: string | undefined) => {
      if (path && !/^(\/dev\/(null|stdout|stderr)|nul)$/i.test(path))
        targets.add(normalisePath(path));
    };

    if (/^(sh|bash|zsh|dash|cmd|powershell|pwsh)$/.test(name)) {
      const flag = args.findIndex((arg) => /^(-c|\/c|-command)$/i.test(arg));
      if (flag >= 0)
        for (const inner of commandWriteTargets(args.slice(flag + 1).join(' '))) add(inner);
      continue;
    }
    if (/^(tee|touch|truncate|new-item|set-content|add-content|out-file)$/.test(name)) {
      const pathFlag = args.findIndex((arg) => /^-(path|filepath|literalpath)$/i.test(arg));
      if (pathFlag >= 0) add(args[pathFlag + 1]);
      else operands.forEach(add);
      continue;
    }
    if (/^(cp|mv|install|ln|copy|move|copy-item|move-item|rsync)$/.test(name)) {
      const destFlag = args.findIndex((arg) => /^-(destination|t|-target-directory)$/i.test(arg));
      const destination = destFlag >= 0 ? args[destFlag + 1] : operands.at(-1);
      const sources = destFlag >= 0 ? operands : operands.slice(0, -1);
      if (!destination) continue;
      add(destination);
      // `cp mcp.json .cursor/` writes `.cursor/mcp.json`.
      for (const source of sources)
        add(`${destination.replace(/[\\/]+$/, '')}/${lastSegment(source)}`);
      continue;
    }
    if (name === 'sed' && args.some((arg) => /^-i/.test(arg))) {
      add(operands.at(-1));
      continue;
    }
    if (/^(curl|wget|iwr|invoke-webrequest)$/.test(name)) {
      const out = args.findIndex((arg) =>
        /^(-o|--output|-O|--output-document|-outfile)$/.test(arg),
      );
      if (out >= 0) add(args[out + 1]);
      continue;
    }
    if (name === 'dd') {
      add(args.find((arg) => arg.startsWith('of='))?.slice(3));
      continue;
    }
    if (name === 'git' && args.includes('config')) {
      const rest = args.slice(args.indexOf('config') + 1);
      const key = rest.find((arg) => !arg.startsWith('-'));
      const setting =
        rest.filter((arg) => !arg.startsWith('-')).length >= 2 || rest.includes('--add');
      if (key && setting && EXECUTING_GIT_CONFIG.test(key))
        add(
          rest.includes('--global') || rest.includes('--system') ? '~/.gitconfig' : '.git/config',
        );
    }
  }
  return [...targets];
}

// ------------------------------------------------------------ helpers

/** Split on `&&`, `||`, `;`, `|` and newlines that are outside quotes. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === ';' ||
      char === '\n' ||
      char === '|' ||
      (char === '&' && command[index + 1] === '&')
    ) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((char === '&' || char === '|') && command[index + 1] === char) index++;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    if (char === '>' || char === '<') {
      // Redirections are read separately; drop them and their targets here.
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      tokens.push(char);
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) tokens.push(current);
  const cleaned: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '>' || token === '<') {
      // Skip the operator, any doubled operator, and the target that follows.
      while (tokens[index + 1] === '>' || tokens[index + 1] === '') index++;
      index++;
      continue;
    }
    if (/^\d$/.test(token) && (tokens[index + 1] === '>' || tokens[index + 1] === '<')) continue;
    cleaned.push(token);
  }
  return cleaned.filter((token) => token.length > 0);
}

function redirectTargets(segment: string): string[] {
  const targets: string[] = [];
  const pattern = /(?:^|[^\d&<>])(?:\d)?>{1,2}\s*("[^"]+"|'[^']+'|[^\s|;&]+)/g;
  for (const match of segment.matchAll(pattern)) {
    const target = match[1]!.replace(/^["']|["']$/g, '');
    if (target.startsWith('&') || /^(\/dev\/(null|stdout|stderr)|nul)$/i.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

function program(token: string): string {
  return lastSegment(normalisePath(token))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function lastSegment(path: string): string {
  const parts = normalisePath(path).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? path;
}

function normalisePath(path: string): string {
  return path
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/');
}

function branchName(resource?: string): string | undefined {
  if (!resource) return undefined;
  // Resources look like `feature/x`, `origin/main`, or `owner/repo:head->base`.
  const arrow = resource.split('->');
  const target = (arrow.length > 1 ? arrow[1] : resource)!.trim();
  return target.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

function hostOf(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? value;
  }
}

function isEnvironmentDump(name: string, lower: string[]): boolean {
  if (name === 'get-childitem') return lower.some((arg) => /^env:/.test(arg));
  if (name === 'set') return lower.length === 0;
  // `env FOO=1 cmd` runs a command; bare `env` / `printenv` print everything.
  return lower.every((arg) => arg.startsWith('-'));
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.name}\u0000${finding.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

const CAPABILITY_WORDS: Record<Capability, string> = {
  'filesystem.read': 'reads a file',
  'filesystem.write': 'writes a file',
  'filesystem.delete': 'deletes a file',
  'process.exec': 'runs a command',
  'network.access': 'connects to the network',
  'package.install': 'installs packages',
  'git.commit': 'records a commit',
  'git.push': 'pushes to a remote',
  'git.branch_create': 'creates a branch',
  'git.pull_request_create': 'opens a pull request',
  'deployment.execute': 'deploys',
  'secret.read': 'reads a secret',
};

function summarise(action: ActionDescriptor, findings: Finding[], reversible: boolean): string {
  const reasons = [...findings]
    .filter((finding) => finding.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((finding) => finding.detail);
  const undo = reversible ? 'Can be undone.' : 'Cannot be undone.';
  if (action.capability === 'process.exec' && action.command) {
    const why = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
    return `Runs \`${truncate(action.command.trim(), 80)}\`${why}. ${undo}`;
  }
  // The reasons already name the file or branch, so they stand on their own.
  if (reasons.length > 0) return `${capitalise(reasons.join('; '))}. ${undo}`;
  const target = action.resource ? ` ${truncate(action.resource, 80)}` : '';
  return `${capitalise(CAPABILITY_WORDS[action.capability])}${target}. ${undo}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
