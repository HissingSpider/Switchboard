# Switchboard — working notes

Private single-user project. TypeScript, Node ≥22.5, zero runtime dependencies
except `ws`. `node:sqlite` is the database; `node:test` is the test runner.

## Build and test

```bash
npm run build       # tsc → dist/
npm test            # builds, then runs test/*.test.ts
npm run typecheck
node dist/cli.js doctor
```

Tests import from `dist/`, not `src/`, because Node's type stripping does not
resolve the `.js` specifiers TypeScript emits. `npm test` builds first for that
reason — don't "fix" the imports back to `src/`.

## Conventions

- **The event log is the only source of truth.** Anything the system does gets
  appended once. The dashboard, the iMessage downsample and the audit trail are
  all reads of that one table. Do not add a second place where state lives.
- **Gate at the runner, not in the prompt.** A system-prompt rule is a
  suggestion. `src/runner/hook.ts` + `src/policy` is the gate. New dangerous
  capabilities get a pattern in `IRREVERSIBLE_PATTERNS` or `HARD_DENY`.
- **Fail closed.** Timeouts on a confirmation abort. A missing gateway denies.
  Pending confirmations are expired on boot because no waiter survives a
  restart. Never let silence read as consent.
- **Short IDs are a UI.** Run ids (`r-8k2wq`) and confirm ids (`c-3f9x`) get
  texted and typed back. Keep them short, unambiguous, prefix-resolvable.
- **Prefer no dependency.** Cron, glob matching, frontmatter and the CLI flag
  parser are all hand-rolled and small. That is deliberate.
- Comments explain *why*, especially where the safe choice looks over-cautious.
  Don't narrate what the next line does.

## Layout

```
src/config     schema + loader        src/store      sqlite, event log, runs, artifacts
src/runner     claude -p, caps, git   src/policy     tiers, matching, confirm-by-reply
src/router     lanes + pipeline       src/agents     definitions, registry, handoff
src/skills     SKILL.md loader        src/gateway    HTTP/WS/SSE + hook endpoint
src/adapters   iMessage, Telegram     src/scheduler  cron + triggers
src/computer   CDP, GUI, screen lock  src/service    launchd, worker isolation
src/memory     non-project memory     src/backup     backup/restore
src/voice      audio in/out, lanes, warm session
src/net        reachability (tailnet vs LAN vs loopback)
src/investigate entity map, health manifests, diagnosis loop
src/queue      DeerDawn board worker      src/vault      Obsidian narrative store
public/        dashboard              skills/        starter skills
```

## Things that will bite you

- `claude -p` in `--input-format stream-json` keeps stdin open; the process will
  not exit until stdin closes. `finishInput()` on the `result` message is what
  ends a run — remove it and every run hangs until the wall-clock cap.
- Exit code 143 is our own SIGTERM, not a crash. `killedIntentionally` is what
  keeps a kill from being reported as a failure.
- The per-project lock is not an optimisation. Two agents on one repo at the
  same time produces a merge conflict inside a working tree with no merge.
- macOS Screen Recording and Accessibility grants are per-binary and cached per
  process. After granting either, the daemon must restart.
- `config.json` must live outside every project path. Startup refuses to boot if
  a worker could write to its own policy.
- The energy VAD's noise floor rises *glacially* and falls fast, on purpose. Any
  meaningful upward adaptation lets the opening of an utterance raise the floor
  above itself, and the rest of the sentence reads as silence.
- `/voice` uses its own `WebSocketServer`. The dashboard socket fans the whole
  event log out to every client; a voice socket that received that would be
  parsing JSON where it expects PCM.
- Voice never approves a gated action — confirmations escalate to text. Do not
  "improve" this by adding a spoken yes.
- A request that presents a credential is judged on that credential alone, even
  from loopback. Under `tailscale serve` every proxied request arrives from
  127.0.0.1, so loopback-implies-trusted would let a revoked device back in.
- The skill sandbox can only ever *narrow* a policy decision. It must never turn
  a `confirm` or a `deny` into an `allow`.
- `trusted` is the only trust tier a machine cannot grant itself, and that is
  the point. Nothing a skill does is evidence it should be allowed to send,
  publish, push or delete.
- `display: inline-block` beats the `hidden` attribute. Anything with an
  explicit display needs its own `[hidden] { display: none }`.
- Diagnosis and repair are separate lanes on purpose. The `investigate` profile
  sets `haltOnDeny`, so a read-only run stops on its first write attempt rather
  than quietly continuing without the step it needed.
- A fix is verified by re-running the originating check *here*, not by believing
  the run's own summary. `investigations.verifyFix` is what makes "fixed" mean
  something.
- The queue claims a card on the board *before* submitting the run. A crashed
  daemon must leave a card visibly stuck in progress, never silently back in the
  backlog for a second worker.
- The queue also refuses to re-claim a card it finished this session. If a
  `move` to done silently fails, the card stays in the backlog and would
  otherwise be run again on every poll, forever, at real cost.
- Vault refs are relative and must stay inside the write subfolder. An absolute
  path is refused rather than reinterpreted — a write landing somewhere other
  than where it was aimed is worse than one that fails.

## Board

Work is tracked in DeerDawn, not in this file.
