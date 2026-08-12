/**
 * Five-field cron, evaluated locally. No dependency, no timezone surprises —
 * everything is in the machine's local time, which is the only time the person
 * reading the texts cares about.
 *
 *   minute hour day-of-month month day-of-week
 *   *  any    5  exact    1-5 range    *\/15 step    1,3,5 list
 */
export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

const RANGES: Array<[keyof CronFields, number, number]> = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dom', 1, 31],
  ['month', 1, 12],
  ['dow', 0, 6],
];

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

function parseField(spec: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo = min;
    let hi = max;
    if (range && range !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`bad range "${range}"`);
      lo = Number(m[1]);
      hi = m[2] ? Number(m[2]) : lo;
      if (!stepRaw && !m[2]) hi = lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
  const normalized = ALIASES[expr.trim()] ?? expr.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const fields = {} as CronFields;
  RANGES.forEach(([key, min, max], i) => {
    fields[key] = parseField(parts[i]!, min, max);
  });
  return fields;
}

export function cronMatches(fields: CronFields, date: Date): boolean {
  const domRestricted = fields.dom.length !== 31;
  const dowRestricted = fields.dow.length !== 7;
  const dayOk =
    domRestricted && dowRestricted
      ? // Standard cron quirk: with both restricted it's an OR, not an AND.
        fields.dom.includes(date.getDate()) || fields.dow.includes(date.getDay())
      : fields.dom.includes(date.getDate()) && fields.dow.includes(date.getDay());

  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    fields.month.includes(date.getMonth() + 1) &&
    dayOk
  );
}

/** Next firing time strictly after `from`, or undefined if none within a year. */
export function nextRun(fields: CronFields, from = new Date()): Date | undefined {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(fields, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}

export function describeCron(expr: string): string {
  try {
    const next = nextRun(parseCron(expr));
    return next ? `next ${next.toLocaleString()}` : 'never fires';
  } catch (err) {
    return `invalid: ${(err as Error).message}`;
  }
}
