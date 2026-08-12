/**
 * Tool-spec matching, shared by permission profiles and the PreToolUse hook.
 *
 * A spec is either a bare tool name (`Bash`, `Write`) or a tool name with a
 * glob over its "argument line" (`Bash(git push*)`, `Write(/etc/**)`).
 * The argument line is derived per tool in `argLine()` so one glob language
 * covers commands, paths and URLs.
 */

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export function argLine(call: ToolCall): string {
  const i = call.input ?? {};
  switch (call.tool) {
    case 'Bash':
      return String(i.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return String(i.file_path ?? i.notebook_path ?? '');
    case 'WebFetch':
      return String(i.url ?? '');
    case 'WebSearch':
      return String(i.query ?? '');
    case 'Glob':
    case 'Grep':
      return String(i.pattern ?? '');
    default: {
      // MCP tools and anything unknown: match against a compact JSON of the input.
      const s = JSON.stringify(i);
      return s.length > 2000 ? s.slice(0, 2000) : s;
    }
  }
}

function globToRegex(glob: string): RegExp {
  let out = '';
  for (let idx = 0; idx < glob.length; idx++) {
    const ch = glob[idx]!;
    if (ch === '*') {
      if (glob[idx + 1] === '*') {
        out += '.*';
        idx++;
      } else {
        out += '.*';
      }
    } else if (ch === '?') {
      out += '.';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

const cache = new Map<string, RegExp>();
function rx(glob: string): RegExp {
  let r = cache.get(glob);
  if (!r) {
    r = globToRegex(glob);
    cache.set(glob, r);
  }
  return r;
}

export function parseSpec(spec: string): { tool: string; arg?: string } {
  const m = /^([^(]+)\((.*)\)$/s.exec(spec.trim());
  return m ? { tool: m[1]!.trim(), arg: m[2] } : { tool: spec.trim() };
}

/** Does a single spec match this call? Bare tool names match any arguments. */
export function specMatches(spec: string, call: ToolCall): boolean {
  const { tool, arg } = parseSpec(spec);
  if (tool !== '*' && tool.toLowerCase() !== call.tool.toLowerCase()) {
    // `mcp__server__*` style prefix matching for MCP tools.
    if (!(tool.includes('*') && rx(tool).test(call.tool))) return false;
  }
  if (arg === undefined) return true;
  const line = argLine(call);
  if (rx(arg).test(line)) return true;
  // Also allow substring-anchored globs so `Bash(git push*)` catches
  // `cd x && git push` — shell chaining is the usual way around a prefix rule.
  if (!arg.startsWith('*') && rx(`*${arg}`).test(line)) return true;
  return false;
}

export function anyMatch(specs: readonly string[], call: ToolCall): string | undefined {
  return specs.find((s) => specMatches(s, call));
}
