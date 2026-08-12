# Switchboard

A personal agent bridge that lives on the Mac Mini. Two surfaces — iMessage and
a localhost dashboard — sit over one gateway that routes intents, delegates real
coding work to `claude -p`, and keeps a single append-only event log that both
surfaces read from.

Private, single-user. Not built to be deployed anywhere else.

## What it does

Text it. It works out whether you're chatting, asking a question, or asking for
real work; picks the project and the agent; runs `claude -p` unattended on its
own git branch; gates every dangerous action behind a reply-to-approve prompt;
and texts you back the parts worth interrupting you for. The dashboard shows the
same run in full detail, live.

```
you  ─┬─ iMessage (BlueBubbles) ─┐
      └─ dashboard (localhost)  ─┴─► gateway ─► intent router ─► run registry ─► claude -p
                                        │                            │
                                        └──────── event log ◄────────┘
```

## Quick start

```bash
npm install && npm run build
node dist/cli.js init          # writes ~/.switchboard/config.json
node dist/cli.js doctor        # checks every dependency before you trust it
node dist/cli.js start         # foreground; `swb service install` for launchd
```

Then open http://127.0.0.1:7788.

## The pieces

| Area | Where | What it owns |
| --- | --- | --- |
| Config | `src/config` | Schema, validation, `~`-expansion, defaults |
| Event log | `src/store` | sqlite (`node:sqlite`), append/replay/subscribe, runs, sessions, artifacts |
| Runner | `src/runner` | `claude -p` spawn + stream-json parse, caps, git branch-per-run, MCP sets, the PreToolUse hook |
| Policy | `src/policy` | Three-tier gating, irreversible-action list, confirm-by-reply |
| Router | `src/router` | chat / query / task lanes, project shortcuts, the message pipeline |
| Agents | `src/agents` | Definition format, registry, hot reload, handoff |
| Skills | `src/skills` | `SKILL.md` discovery, description-based selection, scaffold + test |
| Gateway | `src/gateway` | HTTP + WS + SSE, auth, hook endpoint, webhooks |
| Channels | `src/adapters` | BlueBubbles in/out, Telegram, downsample, notification rules |
| Scheduler | `src/scheduler` | 5-field cron, file/webhook/poll triggers |
| Computer use | `src/computer` | Chrome over CDP, macOS GUI + screenshots, headed session lock |
| Ops | `src/service`, `src/backup`, `src/doctor` | launchd, worker isolation, backup/restore, preflight |

## Talking to it

```
fix the failing auth test in @swb      run it, branch per run
what does the gateway bind to?         read-only lane, no writes
!ops restart the indexer               route to a specific agent
status / runs / cost / projects        control commands, no model call
kill r-8k2wq                           SIGTERM by id
tell r-8k2wq also update the readme    inject into a live run
ok 3f9x  /  no 3f9x                    answer a confirmation
```

## Safety model

Three tiers, enforced at the runner by a `PreToolUse` hook rather than by asking
the model nicely:

- **allow** — matched by the permission profile, runs immediately.
- **confirm** — parks the tool call and texts you. Timeout defaults to *abort*.
- **deny** — refused. A hard-deny list (sudo, `rm -rf /`, disk tools) and a
  write-scope check (nothing outside the run's workdir) sit above every profile,
  so no per-project config can open them up.

Irreversible shapes — push, publish, purchase, send, delete — always land in
`confirm` even when the profile would allow them. Every decision, every answer
and who gave it is written to the event log.

## Testing

```bash
npm test
```

`test/fake-claude.mjs` speaks the real stream-json protocol, so runner, gateway
and policy tests exercise the actual code paths without spending a cent. Drive
its behaviour with `SCENARIO:` markers in the prompt (`tool`, `write`, `hang`,
`fail`, `expensive`, `turns=N`).

## Operating it

```bash
swb service install        # launchd agent, restart on crash, caffeinate
swb backup ~/Backups       # sqlite VACUUM INTO + config + agents + skills
swb isolation script       # generates the non-admin worker-user setup
swb computer perms         # Screen Recording / Accessibility state
swb secret set bluebubbles # Keychain, never config.json
```

See [CLAUDE.md](CLAUDE.md) for the conventions this repo is written to.
