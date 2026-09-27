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

## Install

One command. No GitHub account, access token or administrator rights.

Windows (PowerShell):

```powershell
irm https://cross-vendor-afk-control-plane.vercel.app/install.ps1 | iex
```

macOS or Linux:

```shell
curl -fsSL https://cross-vendor-afk-control-plane.vercel.app/install.sh | sh
```

The installer checks for Node.js 20+ (and offers to install it), installs the
latest release, makes the `odysseus` command work in PowerShell, and offers to
pair the computer. Step-by-step instructions:
https://cross-vendor-afk-control-plane.vercel.app/install

To install with npm yourself instead, use the public release, which always
points at the newest version:

```shell
npm install --global https://github.com/Harish-0412/cross-vendor-AFK-control-plane/releases/latest/download/odysseus-gateway.tgz
```

Do not use `npm login` or the GitHub Packages registry to install: GitHub
requires a personal access token there even for public packages, and a normal
password is rejected with `403 Forbidden`.

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
