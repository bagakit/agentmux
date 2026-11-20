import type { BrowserOutcomeCriterion } from '@agentmux/browser/model'
import type { BrowserTaskVersion } from './browser-task-assets'

/** Fixed definition only. Main binds these declarations to the operation before dispatch. */
export function browserTaskProducerCriteria(version: BrowserTaskVersion, stepId: string): BrowserOutcomeCriterion[] {
  const anchor = version.completion?.criteria.find(item => item.kind === 'download-readable')?.stepId ??
    version.steps.find(step => step.kind !== 'checkpoint' && step.kind !== 'branch' && step.kind !== 'subflow')?.id
  return (version.completion?.criteria ?? []).flatMap<BrowserOutcomeCriterion>(item => {
    if (item.kind === 'field-equals') return item.stepId === stepId ? [{ kind: item.kind, key: item.key, expected: item.expected }] : []
    if (item.kind === 'download-readable') return item.stepId === stepId ? [{ kind: item.kind, path: item.path }] : []
    return anchor === stepId ? [{ kind: item.kind, checkpointId: item.checkpointId }] : []
  })
}
