import type { AppConfig } from '../../../shared/contracts'

/**
 * Turning what the user typed into a fan-out request — or saying why it is not one yet.
 *
 * This is the surface's half of the decision and it is deliberately pure: the concrete branch names and
 * worktree paths are NOT decided here (main derives them from the single planning source), so the only
 * questions left are whether the request is well-formed and which executors it should spread across.
 *
 * `single` is not an error. One lane is not a bake-off, so the caller takes the ordinary launch path
 * instead of paying for orchestration to compare a result with nothing.
 */
export type FanOutRequestDraft =
  | { kind: 'fanout'; count: number; baseName: string; prompt: string; executorIds: string[] }
  | { kind: 'single'; prompt: string; executorId: string }
  | { kind: 'invalid'; reason: string }

/** Beyond this a bake-off stops being reviewable by a person, and N agents on one machine stop being a
 *  fair comparison. The same ceiling main enforces — stated here so the surface can refuse early with a
 *  readable reason instead of round-tripping to be rejected. */
export const MAX_FANOUT_LANES = 8

/**
 * Derive the branch-name stem from the prompt. The stem is what identifies the group afterwards, so it
 * comes from what the user asked for rather than a timestamp or counter — a fan-out named `run-3` tells
 * nobody what it was trying to do.
 */
export function fanOutStemFromPrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/gu, '')
}

export function buildFanOutRequest(input: {
  prompt: string
  count: number
  config: AppConfig | null
  /** Executor ids the user picked, in order. Empty means "use every configured executor". */
  executorIds?: readonly string[]
}): FanOutRequestDraft {
  const prompt = input.prompt.trim()
  if (!prompt) return { kind: 'invalid', reason: 'A fan-out needs a prompt.' }

  const configured = Object.keys(input.config?.executors ?? {})
  const chosen = (input.executorIds ?? []).filter((id) => configured.includes(id))
  const executorIds = chosen.length > 0 ? chosen : configured
  if (executorIds.length === 0) {
    return { kind: 'invalid', reason: 'Configure an Agent executor first.' }
  }

  const count = Math.trunc(input.count)
  if (!Number.isFinite(count) || count < 1) {
    return { kind: 'invalid', reason: 'A fan-out needs at least one lane.' }
  }
  if (count > MAX_FANOUT_LANES) {
    return { kind: 'invalid', reason: `A fan-out is limited to ${MAX_FANOUT_LANES} lanes.` }
  }
  if (count === 1) return { kind: 'single', prompt, executorId: executorIds[0]! }

  const baseName = fanOutStemFromPrompt(prompt)
  // A prompt of only punctuation slugifies to nothing, and an empty stem would make every lane collide
  // on the same name. Refuse rather than invent a placeholder the user never chose.
  if (!baseName) return { kind: 'invalid', reason: 'Add a few words the branch names can be built from.' }

  return { kind: 'fanout', count, baseName, prompt, executorIds: [...executorIds] }
}
