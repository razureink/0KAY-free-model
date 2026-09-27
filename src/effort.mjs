/**
 * Reasoning-effort policy.
 *
 * Ported (MIT) from zouyuxuan122/dsh-our-free-model `src/effort.js`. On this
 * lane the only control the pooled account actually enforces is `max_tokens`
 * (reasoning volume tracks it directly); `reasoning_effort` et al. are accepted
 * and ignored. An "effort level" here is therefore a real generation ceiling.
 *
 * @module src/effort.mjs
 */

export const LEVELS = [
  { id: 'light', name: 'Light', ceiling: 2048 },
  { id: 'balanced', name: 'Balanced', ceiling: 8192 },
  { id: 'deep', name: 'Deep', ceiling: undefined },
]

export const DEFAULT_LEVEL = 'balanced'

/** Rungs of a model that must think are widened by this factor. */
export const ALWAYS_THINKING_FACTOR = 2

/** Below this the answer itself cannot land, so no level may go lower. */
export const MIN_BUDGET = 512

export function resolveLevel(level, model) {
  if (!model || model.reasoning !== true) return undefined
  return LEVELS.find(candidate => candidate.id === level) ?? LEVELS.find(candidate => candidate.id === DEFAULT_LEVEL)
}

function usableTokens(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/**
 * Resolve the generation ceiling for one level against one model.
 *
 * @param {string|undefined} level - effort id ('light'|'balanced'|'deep'), when given
 * @param {object} model - catalog entry supplying `maxOutput`
 * @param {number|undefined} requested - the caller's max_tokens, when set
 * @param {number|undefined} fallback - the plugin default ceiling
 */
export function budgetFor(level, model, requested, fallback) {
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    usableTokens(requested),
    usableTokens(fallback),
  )
  const rung = resolveLevel(level, model)
  let ceiling = rung?.ceiling
  if (ceiling !== undefined && model?.canDisableThinking === false) ceiling *= ALWAYS_THINKING_FACTOR
  if (ceiling === undefined) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  return Math.max(MIN_BUDGET, Math.trunc(Math.min(ceiling, capacity)))
}
