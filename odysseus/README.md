# Odysseus Gateway

The lightweight local half of the Odysseus AFK control plane. It keeps agent
credentials and conversation files on the workstation, establishes an
authenticated outbound tunnel to the hosted Control Plane, and exposes Codex,
Antigravity, Claude Code, and OpenCode through one device-scoped interface.

The package contains bundled JavaScript rather than a platform-specific native
executable or the monorepo toolchain. One small package therefore runs on
Windows, macOS, and Linux with Node.js and remains independently inspectable.

## Requirements

- Node.js 20 or newer
- At least one supported agent CLI installed and signed in
- Git, when workspace diff features are used

## Install without a GitHub Packages token

Every tagged version is attached to a public GitHub Release as an npm tarball:

```shell
npm install --global https://github.com/Harish-0412/cross-vendor-AFK-control-plane/releases/download/gateway-v0.1.0/harish-0412-odysseus-gateway-0.1.0.tgz
```

## Install from GitHub Packages

GitHub requires a classic personal access token with `read:packages`, even for
public npm packages. Authenticate once, then install the package:

```shell
npm login --scope=@harish-0412 --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @harish-0412/odysseus-gateway --registry=https://npm.pkg.github.com
```

## Pair and run

PowerShell:

```powershell
odysseus pair
odysseus gateway --project-root "C:\path\to\your\project"
```

macOS or Linux:

```shell
odysseus pair
odysseus gateway --project-root /path/to/your/project
```

The installed CLI defaults to the hosted Odysseus service. Set
`CONTROL_PLANE_URL`, `ODYSSEUS_WEB_URL`, or `ODYSSEUS_CONTROL_PLANE_URL` to
connect to a self-hosted deployment instead.

The pairing command opens the canonical web application and displays the same
ten verification words on both devices. The gateway creates its Ed25519 key
locally under `~/.odysseus`; the private key never leaves the computer.

Use `odysseus grants --help` for workstation-side access controls and
`odysseus --help` for the complete command list.
