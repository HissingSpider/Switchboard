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
      ├─ dashboard (localhost)   ├─► gateway ─► intent router ─► run registry ─► claude -p
      └─ voice (phone browser)  ─┘      │                            │
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
| Voice | `src/voice` | WS audio transport, VAD + endpointing, whisper.cpp STT, Piper/`say` TTS, latency lanes, warm session, wake word |
| Self-authoring | `src/skills` | Gap detection, dedup, capability manifests, sandbox enforcement, self-tests, trust ladder |
| Phone | `src/gateway`, `public/` | Device pairing, Web Push (VAPID, no dev account), PWA + service worker, approval inbox |
| Investigation | `src/investigate` | Entity map, health manifests, read-only diagnosis loop with resumable findings |
| Queue | `src/queue` | Pulls cards off a DeerDawn board, claims them, writes outcomes back |
| Vault | `src/vault` | Obsidian as the narrative store, writes confined to one subfolder |
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

## Voice

Open `http://<mac-mini>:7788/voice.html` on a phone over Tailscale. Hold the
button, talk, let go.

Transport is a plain WebSocket carrying 16 kHz mono PCM16 — not WebRTC. On a
tailnet there is nothing for WebRTC to solve, and skipping it removes a
signalling server, a TURN dependency and a codec from the latency path.

Three latency lanes, because one budget cannot fit every question:

| lane | what it is | target | how |
| --- | --- | --- | --- |
| instant | status, cost, kill, stop, repeat | < 150 ms | answered from local state, no model at all |
| query | anything you'd ask out loud | < 1.5 s | a resident `claude -p` that never cold-starts |
| task | real work | ack < 300 ms | spawns a normal gated run, reports back by voice when it lands |

Everything else exists to cover the gap: sentence-streamed TTS so the first
sentence plays while the model writes the second, filler speech when a lane
overruns its budget, and barge-in that cuts playback mid-word.

Two rules that are not negotiable:

- **A voice utterance never approves a gated action.** Recognition mishears
  "no" as "go" often enough that it cannot be consent for something
  irreversible. Confirmations are escalated to a text channel and answered
  there.
- **A spoken task is a real run** — same branch, same caps, same audit trail as
  one you texted.

TTS works with zero installs via macOS `say`. STT needs whisper.cpp:

```bash
brew install whisper-cpp
mkdir -p ~/.switchboard/models && cd ~/.switchboard/models
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

`swb voice status` reports what's wired up; `swb voice install` prints every
optional upgrade (Piper voices, openWakeWord).

## Skills it writes for itself

When a run says it has no repeatable way to do something, that gap becomes a
skill: dedup against what already exists, spawn a run whose only job is to
author it, make that run write test cases and pass them against its own script,
register it, then retry what you originally asked for.

Every new skill declares a **capability manifest** in its frontmatter — the
hosts, paths, commands and MCP servers it needs — and the runner enforces
exactly that. Undeclared is denied, and the denial names the missing
declaration so widening it is a reviewable diff rather than a quiet drift.

```yaml
network: [api.github.com]
write-paths: [./out]
commands: [git, node]
```

Trust is earned in three steps, and the last one is not automatic:

| tier | may | how you get there |
| --- | --- | --- |
| sandboxed | read the workdir, nothing else | where every self-authored skill starts |
| restricted | what its manifest declares | 3 clean runs, automatically |
| trusted | *ask* for a tier-2 action | only you, from the Skills tab or `swb skills trust <name>` |

Widening a manifest resets the trust tier — the record was earned under the old
capabilities. Three failures in a row flags a skill for review rather than
retiring it; whether the skill is broken or the world moved is a judgement call.

## On your phone

Add the dashboard to the Home Screen and it behaves like an app: an approval
inbox with real buttons, push notifications that let you approve or deny from
the notification itself, and a layout built for a thumb.

```bash
swb reach          # how a phone can actually get here
swb device pair    # shows a code; type it into /pair.html on the phone
swb push test      # prove notifications arrive
```

Web Push is implemented in `src/gateway/push.ts` rather than pulled in — it
needs no Apple or Google developer account, just a self-generated VAPID keypair
and RFC 8291. Each device gets its own token, so a lost phone costs one
revocation instead of a rotation. On iOS push only works from a Home
Screen-installed PWA, which is why the manifest and service worker exist.

## Diagnosis, separately from repair

"Why are signups down?" is a different job from "fix signups", and running them
together is how an agent ends up changing things it does not understand. So they
are two lanes.

An investigation runs under the `investigate` permission profile: reads go
through without asking, and the **first proposed write stops the run** and makes
it report what it would change instead. It works in checkpoints —

```
FINDING observation: signups dropped to zero at 03:00 UTC.
FINDING ruled_out: the 02:40 deploy did not touch the signup path.
FINDING cause: the migration adding users.locale never ran in production.
ANSWER: signups have been failing since 03:00 because a migration never ran.
```

— so a run that hits a turn cap resumes from what is known rather than from the
question. Ask and walk away; the answer comes back on whichever channel asked.

Two things make the answers concrete rather than vague:

- **The entity map** (`swb entities seed`) turns what you say out loud into what
  the machine has to look at — "signup" becomes a PostHog event name, a repo
  path, a table, and what normal looks like. Without it every investigation
  re-derives the same twenty facts, badly.
- **Health manifests** record the five facts per project: where it runs, where
  errors show up, the three numbers that matter, where the code is, and what to
  check in what order. `swb health <project>` runs that sequence, cheapest check
  first, and stops at the first failure.

`swb fix <investigation-id>` turns an answer into a repair run — and that run is
held to the check that exposed the problem. Switchboard re-runs it itself
afterwards, because a run's claim that it fixed something is not evidence.

## Working a DeerDawn board

Point Switchboard at a queue project and it becomes a worker on it: claim a card
(board first, run second), turn its title into a prompt via `build_subagent_brief`,
run it, and write the outcome back with the branch and diff stat.

```jsonc
"deerdawn": {
  "enabled": true,
  "queueProjectId": "project_…",
  "labelFilter": ["[swb]"],      // only cards you have marked for it
  "notifyChannel": "imessage",   // so a confirm-by-reply has somewhere to land
  "notifyThreadId": "iMessage;-;+15550109999"
}
```

A card titled `[swb] fix the flaky auth test` routes to the project registered as
`swb`. A card naming a project that does not exist is moved to Blocked rather
than run somewhere arbitrary.

## The vault

DeerDawn holds structured memory. An Obsidian vault holds the story — why a
thing was built that way, what was tried and abandoned. Every substantive run
and every finished investigation gets a prose note, git-committed, and the
structured record gets a `vault:` pointer to it.

Writes are confined to one subfolder by path check, not by instruction. Reads
are pull, not scan: the vault is never searched for context, only read when a
record explicitly points into it.

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
swb voice status           # engines, mic mode, client URL
swb voice say "hello"      # hear the configured voice right now
swb investigate "why is X"  # read-only diagnosis, answer comes back later
swb health <project>       # run the check sequence
swb queue poll             # look for DeerDawn work now
swb secret set bluebubbles # Keychain, never config.json
```

See [CLAUDE.md](CLAUDE.md) for the conventions this repo is written to.
