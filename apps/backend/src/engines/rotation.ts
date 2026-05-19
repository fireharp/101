import type { DrillItem, Mode, UserSkillState } from "../types.js";
import { attempts, drills, skillState } from "../db/repo.js";

/**
 * Rotation engine. Implements the scoring formula from LOCAL.md §8.
 *
 *   score = 0.35*due + 0.25*weakness + 0.15*novelty + 0.10*difficultyFit
 *         + 0.10*topicBalance + 0.05*trapDiversity
 *         - 0.50*recentRepeatPenalty - 0.30*exactRepeatPenalty
 *
 * After scoring, weighted-random over the top-5 to avoid being predictable.
 */

interface ScoredDrill {
  drill: DrillItem;
  score: number;
  components: Record<string, number>;
}

export interface RotationOptions {
  user_id: string;
  session_id: string;
  mode: Mode;
  exclude_recent_count?: number;
}

export function selectNextDrill(opts: RotationOptions): DrillItem | null {
  const recentLimit = opts.exclude_recent_count ?? 10;
  const recent = attempts.recentDrillIds(opts.user_id, 20);
  const recentInSession = attempts
    .listForSession(opts.session_id)
    .map((a) => a.drill_id);

  const stateRows = skillState.getAll(opts.user_id);
  const stateIndex = new Map<string, UserSkillState>(
    stateRows.map((r) => [`${r.topic}:${r.subtopic}`, r]),
  );

  const pool = drills.list({ mode: opts.mode, active: true });
  if (pool.length === 0) return null;

  // Mode-specific filtering on top of the topic mapping done in drills.list.
  let filtered = pool;
  if (opts.mode === "weak_topics") {
    const weakKeys = new Set(
      stateRows
        .filter((s) => s.weakness_score >= 0.5)
        .map((s) => `${s.topic}:${s.subtopic}`),
    );
    if (weakKeys.size > 0) {
      filtered = pool.filter((d) => weakKeys.has(`${d.topic}:${d.subtopic}`));
      if (filtered.length === 0) filtered = pool;
    }
  } else if (opts.mode === "mock_interview") {
    // Mock interview policy:
    //  - Floor at difficulty 3 (cut warm-ups) when enough candidates exist.
    //  - Prefer drills the user has never attempted at all, if any remain.
    //  - Spread topics aggressively across the session.
    const hard = pool.filter((d) => d.difficulty >= 3);
    if (hard.length >= 5) filtered = hard;
    const seen = new Set(recent);
    const unseen = filtered.filter((d) => !seen.has(d.id));
    if (unseen.length >= 3) filtered = unseen;
  }

  const now = Date.now();
  const scored: ScoredDrill[] = filtered.map((drill) => {
    const key = `${drill.topic}:${drill.subtopic}`;
    const skill = stateIndex.get(key);

    const components = {
      due: dueWeight(skill, now),
      weakness: weaknessWeight(skill),
      novelty: noveltyWeight(drill, recent),
      difficulty: difficultyFit(drill, skill),
      topicBalance: topicBalance(drill, recentInSession, filtered),
      trapDiversity: trapDiversity(drill, recentInSession, filtered),
      recentRepeatPenalty: recentRepeatPenalty(drill, recent, recentLimit),
      exactRepeatPenalty: exactRepeatPenalty(drill, recentInSession),
    };

    // Mock interview re-weights toward variety and high difficulty,
    // away from due/weakness which assume an ongoing study loop.
    const isMock = opts.mode === "mock_interview";
    const score = isMock
      ? 0.4 * components.novelty +
        0.2 * components.topicBalance +
        0.2 * components.difficulty +
        0.1 * components.weakness +
        0.05 * components.due +
        0.05 * components.trapDiversity -
        0.6 * components.recentRepeatPenalty -
        0.4 * components.exactRepeatPenalty
      : 0.35 * components.due +
        0.25 * components.weakness +
        0.15 * components.novelty +
        0.1 * components.difficulty +
        0.1 * components.topicBalance +
        0.05 * components.trapDiversity -
        0.5 * components.recentRepeatPenalty -
        0.3 * components.exactRepeatPenalty;

    return { drill, score, components };
  });

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (top.length === 0) {
    // Fallback: pick a random non-recent drill so the user is never stuck.
    const fallback = filtered.filter(
      (d) => !recentInSession.includes(d.id),
    );
    const pickFrom = fallback.length > 0 ? fallback : filtered;
    return pickFrom[Math.floor(Math.random() * pickFrom.length)] ?? null;
  }

  return weightedRandom(top).drill;
}

function dueWeight(skill: UserSkillState | undefined, now: number): number {
  if (!skill) return 0.6; // never seen → moderately due
  if (!skill.next_due_at) return 0.5;
  const due = Date.parse(skill.next_due_at);
  const diffDays = (now - due) / (1000 * 60 * 60 * 24);
  if (diffDays >= 0) return Math.min(1, 0.6 + 0.1 * diffDays);
  return Math.max(0, 0.5 + 0.1 * diffDays);
}

function weaknessWeight(skill: UserSkillState | undefined): number {
  if (!skill) return 0.5;
  return skill.weakness_score;
}

function noveltyWeight(drill: DrillItem, recentIds: string[]): number {
  const idx = recentIds.indexOf(drill.id);
  if (idx === -1) return 1;
  return Math.min(1, idx / recentIds.length);
}

function difficultyFit(
  drill: DrillItem,
  skill: UserSkillState | undefined,
): number {
  // Target difficulty grows with mastery (1 - weakness).
  const mastery = skill ? 1 - skill.weakness_score : 0.4;
  const target = 1 + Math.round(mastery * 4);
  const distance = Math.abs(drill.difficulty - target);
  return Math.max(0, 1 - distance * 0.25);
}

function topicBalance(
  drill: DrillItem,
  recentInSession: string[],
  pool: DrillItem[],
): number {
  const byId = new Map(pool.map((d) => [d.id, d] as const));
  const recentTopics = recentInSession
    .map((id) => byId.get(id)?.topic)
    .filter((t): t is string => Boolean(t));
  if (recentTopics.length === 0) return 0.5;
  const share =
    recentTopics.filter((t) => t === drill.topic).length /
    recentTopics.length;
  return 1 - share;
}

function trapDiversity(
  drill: DrillItem,
  recentInSession: string[],
  pool: DrillItem[],
): number {
  if (!drill.trap_type) return 0.5;
  const byId = new Map(pool.map((d) => [d.id, d] as const));
  const recentTraps = recentInSession
    .map((id) => byId.get(id)?.trap_type)
    .filter((t): t is string => Boolean(t));
  if (recentTraps.length === 0) return 1;
  const share =
    recentTraps.filter((t) => t === drill.trap_type).length /
    recentTraps.length;
  return 1 - share;
}

function recentRepeatPenalty(
  drill: DrillItem,
  recentIds: string[],
  withinLast: number,
): number {
  const window = recentIds.slice(0, withinLast);
  return window.includes(drill.id) ? 1 : 0;
}

function exactRepeatPenalty(
  drill: DrillItem,
  recentInSession: string[],
): number {
  return recentInSession.includes(drill.id) ? 1 : 0;
}

function weightedRandom<T extends { score: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.score, 0);
  if (total <= 0) {
    const first = items[0];
    if (!first) throw new Error("weightedRandom: empty input");
    return first;
  }
  let r = Math.random() * total;
  for (const i of items) {
    r -= i.score;
    if (r <= 0) return i;
  }
  const last = items[items.length - 1];
  if (!last) throw new Error("weightedRandom: empty input");
  return last;
}
