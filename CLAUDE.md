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
src/runner     claude -p, caps, git   src/policy     tiers, matching, confirm, standing
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
- A standing approval ("always allow", `src/policy/standing.ts`) is the one
  thing that widens, and it is allowed to because a person clicked it. It is
  applied only to a `confirm` — never to a deny from the profile, the
  write-scope check or the sandbox — so the most it can do is skip a question
  whose answer was going to be yes. `canStand()` is re-checked on *every* match,
  not just when the rule is granted: otherwise a rule made for `git status`
  drifts into covering `git push` the first time the model chains differently.
- A Bash standing rule covers one command, not a chain. `Bash(head *)` matching
  `head x && rm -rf y` would hand a glob a decision nobody made, so a command
  containing `&&`, `;`, `|`, a redirection or a substitution never matches a
  glob rule — it can only ever be granted, and matched, as an exact string.
- A push notification's approve/deny buttons post to
  `/api/confirmations/<id>`, so the push cannot be sent before the id exists.
  That is what `request({ onCreated })` is for. A notification whose buttons
  404 is worse than no notification, because it looks answered.
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
- The iMessage reader resumes from a persisted cursor, so a text sent while the
  daemon was down is not lost. That is only safe *because* of the staleness
  check: before it, `MAX(ROWID)` on every boot was the only thing standing
  between a restart and re-answering the entire history of someone's Messages
  database. A cursor past the end of the database is ignored — a restored
  backup would otherwise leave the reader deaf.
- Starting the iMessage reader at `MAX(ROWID)` stops a fresh install replaying
  history; it does not stop Apple *delivering* history. A message composed days
  ago arrives with a brand-new ROWID when another device finally syncs, and the
  echo check cannot catch it — that holds two minutes of text in memory, and by
  then the daemon that said it has restarted. The message's own date is the
  second check, and it is the one that works.
- Recall (`src/store/recall.ts`) is a *read* of the event log and must stay one.
  No index, no embeddings, no second table that can disagree with the first —
  anything it cannot answer from the log it does not answer.
- What recall hands the model is fenced and framed as background, never as
  instruction. A past `result` is text a model wrote, so replaying it unfenced
  into a later system prompt is one run giving orders to the next. It escalates
  nothing — every action is still gated at the runner — so the cost of getting
  it wrong is a wasted run, and the fence is what keeps it to that.
- Recall is only as good as the log, and the log has junk in it: notifications
  echoed back in as prompts, runs someone killed by hand, failures that never
  reached the model, and errors this codebase wrote about itself. Each is
  excluded for its own reason. A killed run is not a rejected approach, and
  "claude exited with code 1" is not a fact about the project.
- One shared word is a coincidence, not a match. Two terms is the bar unless the
  question only has one, and words match on a four-character prefix so "drift"
  finds "drifting" without anyone owning a stemmer.
- **Do not point a `coding`-profile run at the repo you are editing.** It
  branches and stashes, so your uncommitted work vanishes mid-edit and comes
  back when the run ends. The stash is the safety net working exactly as
  designed — but commit first, or use a read-only lane.
- A run commits an explicit pathspec, never `git add -A`. The stash at
  `startRun()` only closes the door at t=0; edits the operator makes *during*
  the run were swept into the run's commit, under a message about something
  else. The pathspec is built from the `Write`/`Edit`/`NotebookEdit` calls in
  the run's own stream, withdrawn again if the gate refuses one. A change made
  through a shell command names no path, so it stays uncommitted and is
  reported as `unclaimed` — leaving a real change in the working tree is
  recoverable, committing someone else's work is not.
- Paths are matched through `realpath` on both sides. A run reports absolute
  paths from its own cwd, which macOS hands back as `/private/var/...`, while
  the configured project path is the `/var/...` a person typed. Compare those
  with a plain prefix test and every file in the repo reads as outside it, so
  the run stages nothing and commits nothing — silently.
- A warm turn needs a ceiling. `WarmSession` resolves on `result` or `exit`, so
  a process that stays alive and says nothing never settles — and an unbounded
  wait strands the run in `queued`, where `sweep()` cannot cap it and `kill()`
  cannot reach it, while leaving the session marked busy. One wedge would
  otherwise turn warm chat off until the next restart, silently.
- A halting failure — no auth, no credit — is true for every queued run, not
  just the one that hit it. `registry.haltGate` refuses new work while it
  stands, because a daemon that knows it is broken must not keep spending slots
  proving it. Expired auth lifts its own halt by watching the stored
  credential's expiry move forward; exhausted credit has no local evidence, so
  it stays a human's decision rather than a guess dressed up as recovery. A
  present `ANTHROPIC_API_KEY` is *not* evidence of recovery — `process.env` is
  fixed for the life of the daemon, so a revoked key would clear its own halt on
  every sweep and re-fail, which is the waste the halt exists to stop.
- "A credential exists" is not "a credential works". Doctor's auth check stayed
  green through three failed scheduled runs. The access token renews itself; the
  *refresh* token expiring is what needs a person, so that is what is checked.
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
