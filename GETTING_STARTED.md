# Getting started with Odysseus

Odysseus lets you watch and control the AI coding agents on your computer — Codex, Claude Code, OpenCode — from any browser or your phone. Start a task at your desk, walk away, and approve, steer or stop it from wherever you are.

It has two parts:

| Part | Where it runs | What it does |
| --- | --- | --- |
| **The website** | https://cross-vendor-afk-control-plane.vercel.app | Your dashboard. Open it on your phone or any browser. |
| **The gateway** | Your own computer | A small program that links your computer to the dashboard. Your code and your agent logins never leave your computer. |

This guide takes you from nothing to a computer that shows **Online** in your dashboard. It takes about ten minutes.

---

## What you need

- **A computer** running Windows 10/11, macOS or Linux.
- **Node.js 20 or newer.** To check, open a terminal and run:

  ```shell
  node --version
  ```

  If it prints `v20` or higher, you're set. Otherwise, install the **LTS** version from https://nodejs.org, then close and reopen your terminal.

- **At least one AI coding agent**, installed and signed in on that computer: [Codex](https://github.com/openai/codex), [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [OpenCode](https://opencode.ai). The gateway finds them automatically.
- **A Google account or an email address** for signing in to the dashboard.

> **Opening a terminal.** On Windows, press Start, type **PowerShell** and open it. On macOS, open **Terminal** from Applications → Utilities. On Linux, use your usual terminal.

---

## Step 1 — Create your account

1. Open https://cross-vendor-afk-control-plane.vercel.app
2. Choose **Sign in with Google**, or create an account with your email.
3. You'll land on your dashboard. It's empty for now — that's expected.

---

## Step 2 — Install the gateway

In your terminal, run:

```shell
npm install --global https://github.com/Harish-0412/cross-vendor-AFK-control-plane/releases/download/gateway-v0.1.1/harish-0412-odysseus-gateway-0.1.1.tgz
```

Then check it worked:

```shell
odysseus --version
```

It should print `0.1.1`.

<details>
<summary><strong>Windows: "running scripts is disabled on this system"</strong></summary>

PowerShell blocks the `odysseus` shortcut by default on some computers. Either type `odysseus.cmd` instead of `odysseus` in every command in this guide, or open **Command Prompt** instead of PowerShell and use the commands as written.
</details>

---

## Step 3 — Pair your computer with your account

Pairing proves to the dashboard that this computer belongs to you. You do it once per computer.

1. In your terminal, run:

   ```shell
   odysseus pair
   ```

2. The terminal shows an **eight-character code**, a **link**, and **ten security words**.
3. Open the link on your phone or in your browser, where you're signed in to the dashboard. The code fills itself in; if not, type it on the **Connect a workstation** page (Devices → Pair a device).
4. **Check that the ten words on the website match the ten words in your terminal, in the same order.** This is the security check — it proves the website is talking to *your* computer and not someone else's who saw your code.
5. Give the computer a name if you like, then approve.
6. The terminal confirms the pairing and returns to the prompt.

The code expires after five minutes. If it does, just run `odysseus pair` again.

---

## Step 4 — Start the gateway

Go to the folder of the project you want your agents to work in, then start the gateway:

**Windows (PowerShell):**

```powershell
cd "C:\path\to\your\project"
odysseus gateway
```

**macOS / Linux:**

```shell
cd /path/to/your/project
odysseus gateway
```

Agents can only work inside this folder. To allow several folders, name them instead of using `cd`:

```shell
odysseus gateway --project-root "C:\projects\app" --project-root "C:\projects\api"
```

You'll see the Odysseus logo, a card describing your computer, and a short checklist:

```
  ◆ Starting up
  ✔ Device identity loaded
  ✔ Found 3 coding agents on this PC
      ● Codex        0.149.1
      ● OpenCode     1.18.23
      ◐ Claude Code  2.1.280  limited — may need signing in
  ✔ Safety checks passed
  ✔ Connected — this PC is now Online in your dashboard

  ● Online  ·  linked to Odysseus  ·  no dashboard open  ·  up 12s     Ctrl+C to stop
```

**Leave this window open.** Your computer stays connected only while the gateway is running. You can minimise it.

### What the bottom line means

| You see | It means |
| --- | --- |
| `● Online` | Connected. Your dashboard can see and control this computer. |
| `Connecting to Odysseus · 20s` | Reaching the server. If nobody has used it for a while it is waking up — that can take up to a minute. Just wait. |
| `Reconnecting · attempt 3 · next try in 4s` | The connection dropped (Wi-Fi blip, laptop woke from sleep). It reconnects on its own. |
| `Stopping safely` | You pressed Ctrl+C. Running tasks are allowed to finish first. Press Ctrl+C again to stop immediately. |

### Agents in the checklist

| Mark | Meaning |
| --- | --- |
| `●` green | Ready to use. |
| `◐` amber, *limited* | Installed, but it may need you to sign in to it once in a normal terminal. |
| `○` grey, *not installed* | Not on this computer. Install it if you want to use it. |

---

## Step 5 — Check your dashboard

1. Open your dashboard and go to **Devices**. Your computer shows as **Online**.
2. Go to **Integrations** to let Odysseus read your past agent conversations and usage:
   1. Pick your computer at the top.
   2. On the agent you want (for example **OpenAI Codex**), tick the kinds of access to allow, then press **Connect**.
   3. The website shows a short **confirmation code**.
   4. Your gateway terminal asks for it: type the code there and press Enter. Approval always happens on your computer, so a stolen browser session can never grant itself access.
3. Go to **Sessions** to start an agent on your computer from the dashboard, and **Approvals** to answer anything it asks while you're away.

---

## Every day

- **To go AFK:** open a terminal in your project and run `odysseus gateway`. Then leave.
- **After restarting your computer,** the gateway isn't running. Start it again with `odysseus gateway`. You don't need to pair again.
- **To stop:** press **Ctrl+C** in the gateway window, or close it. The dashboard then shows the computer as offline.

---

## If something goes wrong

The gateway explains problems in plain words, in red, with what to do next. The common ones:

| Message | What to do |
| --- | --- |
| **The Odysseus server did not answer in time** | The server was asleep and is waking up. Wait — it retries on its own and usually connects within a minute. |
| **Cannot reach the internet** | Check your Wi-Fi, VPN or firewall. It keeps retrying. |
| **This PC is not paired with your account on this server** | Run `odysseus pair` again and approve it, then `odysseus gateway`. |
| **This PC was removed from your account** | It was removed from the dashboard. Run `odysseus pair`, then `odysseus gateway`. |
| **The secure connection could not be verified** | A proxy or antivirus is intercepting the connection. Try another network. |
| **No coding agents found** | Install Codex, Claude Code or OpenCode and sign in to it once, then restart the gateway. |

**Other issues**

- **`odysseus` is not recognised.** Close and reopen the terminal after installing. If it still fails, run the install command in Step 2 again.
- **The dashboard shows the computer offline, but the gateway says Online.** Refresh the dashboard. Make sure you're signed in with the same account you paired with.
- **Connect is greyed out on the Integrations page.** The selected computer is offline — start `odysseus gateway` on it.

Everything the gateway does is also written to a log file, which is useful if you report a problem:

- Windows: `C:\Users\<you>\.odysseus\logs\gateway.log`
- macOS / Linux: `~/.odysseus/logs/gateway.log`

---

## Updating

Run the install command from Step 2 with the newer version number. Your pairing is kept.

## Removing Odysseus from a computer

1. Stop the gateway (Ctrl+C).
2. In the dashboard, open **Devices**, choose the computer and press **Revoke Device**.
3. Uninstall the gateway:

   ```shell
   npm uninstall --global @harish-0412/odysseus-gateway
   ```

4. Optionally delete the `.odysseus` folder in your home folder. It holds this computer's private key, pairing and logs.

---

## Is it safe?

- **Your computer dials out; nothing dials in.** The gateway opens one encrypted connection to the Odysseus server. No ports are opened on your computer or router.
- **Your keys stay home.** Each computer creates its own private key in `~/.odysseus`. It never leaves the computer.
- **Your agent logins stay home.** Codex, Claude Code and OpenCode keep their own sign-ins on your computer. Odysseus never sees them.
- **You approve access on the computer, not the website.** Reading conversations or running sessions needs a code typed into the gateway terminal.
- **Agents are limited to the folders you give them** with `--project-root` (or the folder you started in).
- **On Windows there is no sandbox:** an agent runs with your own permissions. Keep approval mode on for anything that changes files.
