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
- **The lane picks the model.** `config.models` maps chat/query/task (and the
  DeerDawn `bridge`) onto `claude --model`. `task` is deliberately unset so real
  work stays on the CLI's own default — the cheap tier is for the lanes where an
  answer isn't worth much, not for the one that writes code.
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
  same time produces a merge conflict inside a working tree with no merge. It
  is taken at the very top of `launch()`, before the first `await`: any
  suspension point ahead of it is long enough for the next `drain()` to start a
  second run in the same project.
- Only the chat lane may be served from the resident session, and the reason is
  the gate rather than the model: `hook.ts` reads `SWB_RUN_ID` from its own
  process environment, so a process shared between runs would attribute every
  gated call to whichever run started it. A shared process is safe only where
  nothing is gated at all, which is what `allowedTools: []` buys. Adding a tool
  to `ChatResponder` silently corrupts the audit trail.
- `total_cost_usd` on a `result` is the running total for the whole session, not
  the turn that just ended. `WarmSession` bills the delta; charging the field
  directly makes a resident process re-bill everything it has ever said, on
  every turn, and empties the monthly budget at a multiple of the real rate.
- A chat turn that answers `NEEDS_TOOLS` is promoted to the query lane *and its
  model* before being spawned. Escalating the tools without the model leaves a
  tool-using question on the cheapest tier, which is how a small model ends up
  looping on a tool call.
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
- An obviously read-only call is allowed instead of falling through to
  `confirm` — asking a human whether a schema lookup may proceed buys nothing
  but a 600s timer, and a read cannot leak on its own: getting data *out* needs
  an outbound action, and those are caught above every profile. It applies
  **only when the profile's fallback is `confirm`**. `fallback: deny` means no
  and stays no; a built-in must never widen a profile that closed itself.
- An MCP tool's name is the only evidence of what it does, so `isObviouslyReadOnly`
  matches whole words, not prefixes: the name must start with a read verb and
  contain no mutating one. `get_settings` is a read (`set` is inside a word);
  `search_and_replace` is not. A name that says nothing — `start_session` —
  stays gated, and belongs in a profile's `allow` list where the server-specific
  knowledge lives.
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
- `tailscale serve` terminates TLS and proxies to 127.0.0.1, so every tailnet
  request *looks* like loopback. `isLoopback` therefore rejects anything
  carrying a forwarding header — otherwise exposing the gateway to the tailnet
  would expose it with no authentication at all.
- macOS attributes a TCC grant to the *responsible* process, which for anything
  launched from a shell is the shell's app — not node. So a CLI check of Full
  Disk Access reports "denied" while the launchd-spawned daemon has it. Ask the
  daemon (`/api/imessage`), never the CLI's own process.
- iMessage dates are nanoseconds since 2001 — past Number.MAX_SAFE_INTEGER for
  anything recent, and node:sqlite throws rather than rounding. Cast to TEXT.
- node:sqlite returns blobs as Uint8Array, whose `indexOf` cannot take a string.
  Recent macOS puts the message body in `attributedBody`, so getting this wrong
  makes every message arrive empty rather than failing loudly.
- The VAPID `sub` is checked by the push providers, not just carried. Apple
  returns `BadJwtToken` for an implausible contact — which points at the
  signature, not at the one field that is actually wrong. `mailto:*@localhost`
  fails; a real address or an https URL works. Never ship a placeholder here.
- A browser cannot put a bearer token on a top-level navigation, so a token in
  localStorage authenticates `fetch` and nothing else. The device cookie set at
  claim time is what actually lets a paired phone load a page — do not remove it
  in favour of "just use the token".
- An unauthenticated request that looks like a browser navigation gets a 302 to
  /pair.html rather than a JSON 401. A person who sees `{"error":"missing or
  invalid token"}` has been told nothing they can act on.
- `/pair.html` and `POST /api/devices/claim` are the one unauthenticated hole,
  and it has to exist: a new phone has no token yet. It is safe because claiming
  needs a single-use code that expires in five minutes and is only ever shown on
  an already-trusted screen. Do not widen it.
- Vault refs are relative and must stay inside the write subfolder. An absolute
  path is refused rather than reinterpreted — a write landing somewhere other
  than where it was aimed is worse than one that fails.

## Board

Work is tracked in DeerDawn, not in this file.
