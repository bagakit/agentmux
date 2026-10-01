import type { BrowserTaskAssetRun, BrowserTaskStep } from './browser-task-assets.js'

export const BROWSER_TASK_MAX_BRANCHES = 16
export const BROWSER_TASK_MAX_OPERATIONS = 128
export const BROWSER_TASK_MAX_EXECUTED_MILLIS = 120_000

/** One ordered cursor. Explicit edges may only skip forward or finish; there is no loop owner. */
export function browserTaskNextIndex(steps: BrowserTaskStep[], index: number, destination?: string | null): number {
  if (destination === null) return steps.length
  if (destination === undefined) return index + 1
  const next = steps.findIndex(step => step.id === destination)
  if (next <= index) throw new Error('Task paths must point to an existing later step; back edges are not allowed.')
  return next
}

export function validateBrowserTaskPath(steps: BrowserTaskStep[]): void {
  if (steps.length > 128 || steps.filter(step => step.kind === 'branch').length > BROWSER_TASK_MAX_BRANCHES) throw new Error('Task path budget exceeded.')
  const reachable = new Set<number>(steps.length ? [0] : [])
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    const edges = step.kind === 'branch'
      ? [step.branch?.onTrue, step.branch?.onFalse]
      : [step.nextStepId]
    if (step.kind === 'branch' && (!step.branch || edges.some(edge => edge === undefined))) throw new Error('Declare both condition paths before running.')
    if (step.kind === 'checkpoint' && step.nextStepId !== undefined) throw new Error('Human checkpoints retain their ordered continuation.')
    for (const edge of edges) {
      const next = browserTaskNextIndex(steps, index, edge)
      if (reachable.has(index) && next < steps.length) reachable.add(next)
    }
  }
  if (reachable.size !== steps.length) throw new Error('Task has unreachable steps. Connect or delete them before saving a runnable version.')
}

/** Parameters for the currently known path only; an undecided branch ends this segment. */
export function browserTaskSegment(steps: BrowserTaskStep[], nextStep: number): BrowserTaskStep[] {
  const segment: BrowserTaskStep[] = []
  for (let index = nextStep; index < steps.length;) {
    const step = steps[index]!
    if (step.kind === 'checkpoint' || step.kind === 'branch') break
    segment.push(step)
    index = browserTaskNextIndex(steps, index, step.nextStepId)
  }
  return segment
}

/** Derive visited checkpoints from original decisions/cursor; skipping a path does not approve it. */
export function browserTaskReachedCheckpoints(steps: BrowserTaskStep[], run: BrowserTaskAssetRun): Set<string> {
  const reached = new Set<string>()
  for (let index = 0; index < run.nextStep && index < steps.length;) {
    const step = steps[index]!
    if (step.kind === 'checkpoint') reached.add(step.id)
    if (step.kind === 'branch') {
      const decision = run.branchDecisions?.find(fact => fact.stepId === step.id)
      if (!decision || decision.result === 'unknown') break
      index = browserTaskNextIndex(steps, index, decision.nextStepId)
    } else index = browserTaskNextIndex(steps, index, step.nextStepId)
  }
  return reached
}
