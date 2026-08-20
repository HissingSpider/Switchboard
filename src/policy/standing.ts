import type { Db } from '../store/db.js';
import type { EventLog } from '../store/eventlog.js';
import { shortId } from '../core/ids.js';
import { anyMatch, specMatches, type ToolCall } from './match.js';
import { HARD_DENY, IRREVERSIBLE_PATTERNS } from './policy.js';
import { dirname } from 'node:path';

/**
 * Standing approvals — the "always allow" button.
 *
 * The gate is right about *what* needs a decision and blind to how often you
 * have already made it. Answering "yes" to `npm test` for the ninth time is not
 * oversight, it is noise, and noise is what makes a person stop reading the
 * question. So a person can turn one answer into a rule.
 *
 * The whole design is that a standing rule can only ever do what you could have
 * done by sitting there and clicking approve:
 *
 *  - It only ever turns `confirm` into `allow`. A deny stays a deny — from the
 *    hard-deny list, from a profile, from the write-scope check, or from a
 *    skill sandbox.
 *  - It can never cover a shape that is gated by shape rather than by profile.
 *    Everything in HARD_DENY and IRREVERSIBLE_PATTERNS is off the table both
 *    when a rule is granted *and* every time one is matched — so a rule granted
 *    for `git status` cannot drift into covering `git push`.
 *  - A Bash rule covers one command, not a chain. `Bash(head *)` matching
 *    `head x && rm -rf y` would hand a glob a decision nobody made.
 *  - Every application is written to the event log with the rule id, so a
 *    standing approval is exactly as auditable as one you answered by hand.
 */
export interface StandingRule {
  id: string;
  createdAt: string;
  createdBy: string;
  tool: string;
  spec: string;
  mode: 'glob' | 'exact';
  origin: string | null;
  sample: string | null;
  uses: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface Row {
  id: string;
  created_at: string;
  created_by: string;
  tool: string;
  spec: string;
  mode: string;
  origin: string | null;
  sample: string | null;
  uses: number;
  last_used_at: string | null;
  revoked_at: string | null;
}

const toRule = (r: Row): StandingRule => ({
  id: r.id,
  createdAt: r.created_at,
  createdBy: r.created_by,
  tool: r.tool,
  spec: r.spec,
  mode: r.mode === 'exact' ? 'exact' : 'glob',
  origin: r.origin,
  sample: r.sample,
  uses: r.uses,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

/** A suggested rule, and the words to put on the button that grants it. */
export interface Suggestion {
  spec: string;
  mode: 'glob' | 'exact';
  /** Why this shape and not a broader one — shown under the button. */
  covers: string;
}

/**
 * Shell metacharacters that make one command line into more than one command.
 * A redirection counts: `head -20 x > ~/.zshrc` is not a read.
 */
const CHAINED = /(\|\||&&|[;|<>]|\$\(|`|\n)/;

/**
 * Commands whose first word says nothing on its own — the subcommand is the
 * thing being approved. `git` is not a permission; `git status` is.
 */
const MULTIPLEXERS = new Set([
  'git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'node', 'docker', 'kubectl',
  'cargo', 'go', 'brew', 'pip', 'pip3', 'python', 'python3', 'uv', 'make', 'tsc', 'systemctl',
  'launchctl', 'defaults', 'xcrun', 'swift', 'dotnet', 'terraform',
]);

/** Anything that would make a glob mean more than it appears to. */
const GLOBBY = /[*?[\]{}()'"$\\]/;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** Is this call one a person is allowed to hand to a rule at all? */
export function canStand(call: ToolCall): boolean {
  if (anyMatch(HARD_DENY.map((h) => h.spec), call)) return false;
  if (anyMatch(IRREVERSIBLE_PATTERNS.map((p) => p.spec), call)) return false;
  return true;
}

/**
 * The first meaningful words of a shell command: `npm run build --silent` →
 * `npm run`. Returns undefined when the head cannot be trusted to mean what it
 * looks like, which is the fail-closed answer.
 */
export function commandHead(command: string): string | undefined {
  const cmd = command.trim();
  if (!cmd || CHAINED.test(cmd)) return undefined;
  const words = cmd.split(/\s+/).filter((w) => !/^\w+=/.test(w)); // drop leading FOO=bar
  const first = words[0];
  if (!first || GLOBBY.test(first)) return undefined;
  if (!MULTIPLEXERS.has(first)) return first;
  const second = words[1];
  if (!second || second.startsWith('-') || GLOBBY.test(second)) return first;
  return `${first} ${second}`;
}

/**
 * What "always allow this" should mean for a given call — deliberately the
 * narrowest thing that is still worth having. Returns undefined when nothing
 * narrow enough exists, and the button is simply not offered.
 */
export function suggest(call: ToolCall, workdir?: string): Suggestion | undefined {
  if (!canStand(call)) return undefined;

  if (call.tool === 'Bash') {
    const command = String(call.input?.command ?? '').trim();
    if (!command) return undefined;
    const head = commandHead(command);
    if (head) return { spec: `Bash(${head}*)`, mode: 'glob', covers: `any \`${head}\` command` };
    // A chain or a redirection gets no glob — but repeating the exact same line
    // is still a decision you have already made, so offer that and nothing more.
    return command.length <= 400 ? { spec: `Bash(${command})`, mode: 'exact', covers: 'this exact command, character for character' } : undefined;
  }

  if (call.tool.startsWith('mcp__')) {
    return { spec: call.tool, mode: 'glob', covers: 'any call to this MCP tool' };
  }

  if (WRITE_TOOLS.has(call.tool)) {
    const target = String(call.input?.file_path ?? call.input?.notebook_path ?? '');
    if (!target || GLOBBY.test(target)) return undefined;
    const dir = dirname(target);
    return { spec: `${call.tool}(${dir}/**)`, mode: 'glob', covers: `${call.tool} anywhere under ${dir}` };
  }

  return { spec: call.tool, mode: 'glob', covers: `any ${call.tool} call` };
}

export class StandingRules {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
  ) {}

  list(includeRevoked = false): StandingRule[] {
    const rows = (
      includeRevoked
        ? this.db.prepare('SELECT * FROM standing_rules ORDER BY created_at DESC').all()
        : this.db.prepare('SELECT * FROM standing_rules WHERE revoked_at IS NULL ORDER BY created_at DESC').all()
    ) as unknown as Row[];
    return rows.map(toRule);
  }

  get(id: string): StandingRule | undefined {
    const row = this.db.prepare('SELECT * FROM standing_rules WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? toRule(row) : undefined;
  }

  /**
   * Grant a rule. `spec` is trusted to have come from `suggest()` — it is
   * re-checked here anyway, because the one caller that forgets is the one that
   * matters.
   */
  grant(input: { spec: string; mode: 'glob' | 'exact'; tool: string; by: string; origin?: string; sample?: string }): StandingRule | undefined {
    const spec = input.spec.trim();
    if (!spec) return undefined;
    // A rule is only as safe as the calls it can match, and the shape lists are
    // checked again at match time. Refuse obvious nonsense here so a bad rule
    // never reaches the list a person reads.
    if (spec === '*' || spec === input.tool + '(*)') return undefined;

    const existing = this.list().find((r) => r.spec === spec);
    if (existing) return existing;

    const id = `s-${shortId(4)}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO standing_rules (id, created_at, created_by, tool, spec, mode, origin, sample)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, createdAt, input.by, input.tool, spec, input.mode, input.origin ?? null, input.sample ?? null);

    this.log.append({
      runId: null,
      kind: 'policy.standing_granted',
      source: 'policy',
      summary: `${input.by} granted a standing approval: ${spec} (${id})`,
      data: { id, spec, mode: input.mode, tool: input.tool, origin: input.origin ?? null, sample: input.sample ?? null },
    });
    return this.get(id);
  }

  revoke(id: string, by: string): StandingRule | undefined {
    const rule = this.get(id);
    if (!rule || rule.revokedAt) return rule;
    this.db.prepare('UPDATE standing_rules SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    this.log.append({
      runId: null,
      kind: 'policy.standing_revoked',
      source: 'policy',
      summary: `${by} revoked the standing approval ${rule.spec} (${id})`,
      data: { id, spec: rule.spec },
    });
    return this.get(id);
  }

  /**
   * Does a live rule cover this call? Every guard that applied when the rule was
   * granted is applied again here, because the call is new and the rule is old.
   */
  match(call: ToolCall): StandingRule | undefined {
    if (!canStand(call)) return undefined;
    const rule = this.list().find((r) => this.covers(r, call));
    if (!rule) return undefined;
    this.db
      .prepare('UPDATE standing_rules SET uses = uses + 1, last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), rule.id);
    return rule;
  }

  private covers(rule: StandingRule, call: ToolCall): boolean {
    if (rule.tool.toLowerCase() !== call.tool.toLowerCase()) return false;
    if (call.tool === 'Bash') {
      const command = String(call.input?.command ?? '').trim();
      if (rule.mode === 'exact') {
        // Exact means exact. specMatches' substring fallback would let a rule
        // for `foo` cover `rm -rf /; foo`, which is the opposite of exact.
        const inner = /^Bash\((.*)\)$/s.exec(rule.spec)?.[1];
        return inner !== undefined && inner === command;
      }
      // A glob rule covers one command. Anything that chains or redirects is a
      // different decision than the one that was made.
      if (CHAINED.test(command)) return false;
    }
    return specMatches(rule.spec, call);
  }
}
