import { mintObjectId } from '@agentmux/core/object-id'
import { useAppStore, setAuthoredWorkbench } from '../store'
import type { GoalPlanReviewInput } from '@agentmux/demand/goal-plan'

export type GoalEditField = 'title' | 'description' | 'tags'
export type GoalEditDraft = { value: string; revision: string; issue?: string }
export type GoalPlanReviewDraft = { command: string; result: string; evidence: string; note: string; request?: { goalId: string; review: GoalPlanReviewInput } }
export type GoalEditDrafts = Record<string, Partial<Record<GoalEditField, GoalEditDraft>> & { planReviews?: Record<string, GoalPlanReviewDraft> }>
const fields: readonly GoalEditField[] = ['title', 'description', 'tags']
export const goalPlanReviewDraftKey = (nodeId: string, delegationOperationId: string) => JSON.stringify([nodeId, delegationOperationId])

/** Retain human input and the exact request in the existing authored document;
 * in-flight UI state and owner confirmation are never persisted as facts. */
export function editGoalPlanReviewDraft(goalId: string, nodeId: string, delegationOperationId: string, value: GoalPlanReviewDraft): void {
  const { command, result, evidence, note, request } = value, draft = { command, result, evidence, note, ...(request ? { request } : {}) }
  const key = goalPlanReviewDraftKey(nodeId, delegationOperationId)
  setAuthoredWorkbench(state => {
    const original = state.goalEditDrafts[goalId] ?? {}
    if (JSON.stringify(original.planReviews?.[key]) === JSON.stringify(draft)) return state
    return { goalEditDrafts: { ...state.goalEditDrafts, [goalId]: { ...original, planReviews: { ...original.planReviews, [key]: draft } } } }
  })
}

/** A matching owner record replaces only this exact submitted UI draft. */
export function clearGoalPlanReviewDraft(goalId: string, nodeId: string, delegationOperationId: string, operationId: string): void {
  const key = goalPlanReviewDraftKey(nodeId, delegationOperationId)
  setAuthoredWorkbench(state => {
    const original = state.goalEditDrafts[goalId]
    if (original?.planReviews?.[key]?.request?.review.operationId !== operationId) return state
    const { [key]: _review, ...planReviews } = original.planReviews
    const { planReviews: _previous, ...edits } = original
    const next = { ...edits, ...(Object.keys(planReviews).length ? { planReviews } : {}) }, goalEditDrafts = { ...state.goalEditDrafts }
    if (Object.keys(next).length) goalEditDrafts[goalId] = next
    else delete goalEditDrafts[goalId]
    return { goalEditDrafts }
  })
}

/** Unsent text belongs to the existing Desktop user document, separately from owner facts. */
export function editGoalDraft(goalId: string, field: GoalEditField, value: string): void {
  setAuthoredWorkbench(state => {
    const original = state.goalEditDrafts[goalId] ?? {}
    if (original[field]?.value === value) return state
    return { goalEditDrafts: { ...state.goalEditDrafts, [goalId]: { ...original, [field]: { value, revision: mintObjectId() } } } }
  })
}

// These promises only serialize actual saves. Text and confirmation remain in the user document.
const saves = new Map<string, { jobs: Map<string, Promise<boolean>>; tail: Promise<boolean> }>()

/** Blur and Done share the same captured versions, including across detail unmounts. */
export function saveGoalDrafts(goalId: string, selected: readonly GoalEditField[] = fields): Promise<boolean> {
  const drafts = useAppStore.getState().goalEditDrafts[goalId]
  const captured = selected.flatMap(field => drafts?.[field] ? [[field, drafts[field]!] as const] : [])
  if (!captured.length) return Promise.resolve(true)
  const signature = JSON.stringify(captured.map(([field, draft]) => [field, draft.revision]))
  const flight = saves.get(goalId) ?? { jobs: new Map<string, Promise<boolean>>(), tail: Promise.resolve(true) }
  const held = flight.jobs.get(signature)
  if (held) return held
  const settle = (issue?: string) => useAppStore.setState(state => {
    const original = state.goalEditDrafts[goalId]
    if (!original) return state
    const next = { ...original }
    for (const [field, draft] of captured) if (next[field]?.revision === draft.revision) {
      if (issue === undefined) delete next[field]
      else next[field] = { ...draft, issue }
    }
    const goalEditDrafts = { ...state.goalEditDrafts }
    if (Object.keys(next).length) goalEditDrafts[goalId] = next
    else delete goalEditDrafts[goalId]
    return { goalEditDrafts }
  })
  const promise = flight.tail.then(async () => {
    const pending = captured.filter(([field, draft]) => useAppStore.getState().goalEditDrafts[goalId]?.[field]?.revision === draft.revision)
    if (!pending.length) return true
    const patch = Object.fromEntries(pending.map(([field, draft]) => [field,
      field === 'tags' ? draft.value.split(',').map(tag => tag.trim()).filter(Boolean) : draft.value]))
    try {
      await useAppStore.getState().updateDemand(goalId, patch, undefined, undefined)
      settle()
      return true
    } catch (error) {
      settle(error instanceof Error ? error.message : String(error))
      return false
    }
  }).finally(() => {
    flight.jobs.delete(signature)
    if (!flight.jobs.size && saves.get(goalId) === flight) saves.delete(goalId)
  })
  flight.jobs.set(signature, promise); flight.tail = promise; saves.set(goalId, flight)
  return promise
}
