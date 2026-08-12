import type { SkillStore, SkillRecord } from '../store/skills.js';
import type { TrustTier } from './manifest.js';
import { TRUST_ORDER, widens, describeManifest, type CapabilityManifest } from './manifest.js';

/**
 * The promotion path: sandboxed → restricted → trusted.
 *
 * A skill the machine wrote for itself starts with nothing — no network, no
 * writes, no shell — and earns each step. The first two steps are automatic
 * because they are recoverable: a restricted skill can only touch what it
 * declared, inside the workdir, and still cannot take an irreversible action.
 *
 * The last step is not automatic and never will be. `trusted` is the tier that
 * can request a tier-2 action — sending, publishing, pushing, deleting — and
 * nothing the system observes about its own behaviour is evidence that it
 * should be allowed to do that. That is a decision with a person's name on it.
 */
export interface PromotionCriteria {
  /** Successful uses required before proposing the next tier. */
  minRuns: number;
  /** Success rate required, 0..1. */
  minSuccessRate: number;
  /** Days the skill must have existed. */
  minAgeDays: number;
}

export const CRITERIA: Record<'restricted' | 'trusted', PromotionCriteria> = {
  restricted: { minRuns: 3, minSuccessRate: 1, minAgeDays: 0 },
  // The numbers here are a floor, not a trigger — see `proposeTrusted`.
  trusted: { minRuns: 20, minSuccessRate: 0.95, minAgeDays: 7 },
};

export type PromotionOutcome =
  | { kind: 'promoted'; from: TrustTier; to: TrustTier; reason: string }
  | { kind: 'proposed'; to: TrustTier; reason: string }
  | { kind: 'held'; reason: string };

function ageDays(skill: SkillRecord): number {
  return (Date.now() - new Date(skill.createdAt).getTime()) / 86_400_000;
}

function meets(skill: SkillRecord, c: PromotionCriteria): { ok: boolean; why: string } {
  const rate = skill.runs ? skill.successes / skill.runs : 0;
  if (skill.runs < c.minRuns) return { ok: false, why: `${skill.runs}/${c.minRuns} successful uses` };
  if (rate < c.minSuccessRate) return { ok: false, why: `${Math.round(rate * 100)}% success rate, needs ${Math.round(c.minSuccessRate * 100)}%` };
  if (ageDays(skill) < c.minAgeDays) return { ok: false, why: `${ageDays(skill).toFixed(1)} days old, needs ${c.minAgeDays}` };
  return { ok: true, why: `${skill.successes}/${skill.runs} clean over ${ageDays(skill).toFixed(1)} days` };
}

/**
 * Consider a skill for promotion. Returns what it did — the caller decides
 * whether to surface it. Flagged or retired skills are never promoted.
 */
export function considerPromotion(store: SkillStore, name: string): PromotionOutcome {
  const skill = store.get(name);
  if (!skill) return { kind: 'held', reason: 'no such skill' };
  if (skill.retiredAt) return { kind: 'held', reason: 'retired' };
  if (skill.flagged) return { kind: 'held', reason: `flagged: ${skill.flagReason ?? 'unknown'}` };

  if (skill.trust === 'sandboxed') {
    const verdict = meets(skill, CRITERIA.restricted);
    if (!verdict.ok) return { kind: 'held', reason: verdict.why };
    store.setTrust(name, 'restricted', 'auto', verdict.why);
    return { kind: 'promoted', from: 'sandboxed', to: 'restricted', reason: verdict.why };
  }

  if (skill.trust === 'restricted') {
    const verdict = meets(skill, CRITERIA.trusted);
    if (!verdict.ok) return { kind: 'held', reason: verdict.why };
    // Deliberately a proposal, not a promotion.
    return { kind: 'proposed', to: 'trusted', reason: verdict.why };
  }

  return { kind: 'held', reason: 'already trusted' };
}

/** The text put in front of a human when a skill is up for `trusted`. */
export function proposeTrusted(skill: SkillRecord): string {
  return [
    `"${skill.name}" is asking to become a trusted skill.`,
    '',
    `Record: ${skill.successes}/${skill.runs} successful, ${ageDays(skill).toFixed(0)} days old.`,
    `Origin: ${skill.originTask ?? 'unknown'}`,
    `Written by: ${skill.authoredBy ?? 'a human'}`,
    `Capabilities: ${describeManifest(skill.manifest)}`,
    '',
    'Trusted means it may request actions that need your confirmation — sending,',
    'publishing, pushing, deleting. It still asks you each time; this only decides',
    'whether it may ask at all.',
  ].join('\n');
}

/** Only a human can grant `trusted`. `by` is recorded in the skill's history. */
export function grantTrusted(store: SkillStore, name: string, by: string): SkillRecord | undefined {
  const skill = store.get(name);
  if (!skill) return undefined;
  if (skill.trust !== 'restricted') return skill;
  return store.setTrust(name, 'trusted', by, 'granted by the owner');
}

export function demote(store: SkillStore, name: string, reason: string): SkillRecord | undefined {
  const skill = store.get(name);
  if (!skill) return undefined;
  const index = TRUST_ORDER.indexOf(skill.trust);
  const next = TRUST_ORDER[Math.max(0, index - 1)]!;
  return store.setTrust(name, next, 'auto', reason);
}

/**
 * A skill rewriting its own manifest is the interesting case: widening is
 * allowed, but it costs the skill its trust tier, because the record it earned
 * was earned under the old capabilities.
 */
export function onManifestChange(
  store: SkillStore,
  name: string,
  previous: CapabilityManifest,
  next: CapabilityManifest,
  runId: string | null,
): { widened: string[]; demotedTo?: TrustTier } {
  const added = widens(previous, next);
  if (!added.length) return { widened: [] };

  const skill = store.get(name);
  store.addHistory(name, 'edited', runId, `manifest widened — ${added.join('; ')}`);
  if (!skill || skill.trust === 'sandboxed') return { widened: added };

  store.setTrust(name, 'sandboxed', 'auto', `manifest widened (${added.join('; ')}), trust reset`);
  return { widened: added, demotedTo: 'sandboxed' };
}
