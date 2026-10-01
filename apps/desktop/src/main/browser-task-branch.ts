import type { BrowserScriptRunReport } from '../shared/contracts.js'
import type { BrowserTaskStep, BrowserTaskStepExecution } from '../shared/browser-task-assets.js'

const SCHEMA = 'agentmux.browser-task-branch-fact.v1'
type BranchFact = BrowserTaskStepExecution & { schema: string; navigationId: string; result: 'true' | 'false' | 'unknown' }

/** Fixed read-only Browser SDK calls. Conditions cannot contain JavaScript or an Agent judgement. */
export function compileBrowserTaskBranchObservation(step: BrowserTaskStep, execution: BrowserTaskStepExecution): string {
  if (step.kind !== 'branch' || !step.branch || !step.reviewed) throw new Error('Review the condition and both paths before executing it.')
  return `const condition = ${JSON.stringify(step.branch.condition)};
    const fact = { ...${JSON.stringify(execution)}, schema: ${JSON.stringify(SCHEMA)}, navigationId: '', result: 'unknown' };
    const page = await pageInfo();
    if (!page || typeof page.navigationId !== 'string' || !page.navigationId) return fact;
    fact.navigationId = page.navigationId;
    const identity = (value) => { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return null; } };
    if (condition.kind === 'page-url-is') {
      const actual = identity(page.url);
      if (actual) fact.result = actual === condition.url ? 'true' : 'false';
    } else if (condition.kind === 'element-present') {
      if (identity(page.url) !== ${JSON.stringify(step.url)}) return fact;
      const snapshotResult = await snapshot({ maxNodes: 1000 });
      const observed = snapshotResult && snapshotResult.observation;
      if (!observed || observed.scope.kind !== 'page' || observed.scope.document !== null || observed.truncated ||
          !Number.isSafeInteger(observed.fullObserved) || observed.fullObserved < 1 ||
          !Array.isArray(observed.omittedFrames) || observed.omittedFrames.length ||
          !Array.isArray(snapshotResult.missingFrames) || snapshotResult.missingFrames.length || !Array.isArray(snapshotResult.nodes)) return fact;
      if (snapshotResult.nodes.length === 0 || observed.returned !== snapshotResult.nodes.length || observed.scoped !== observed.fullObserved ||
          observed.matched !== observed.scoped || observed.returned !== observed.matched) return fact;
      fact.result = snapshotResult.nodes.some(node => node.role === condition.target.role && node.name === condition.target.name) ? 'true' : 'false';
    }
    const after = await pageInfo();
    if (!after || after.navigationId !== page.navigationId || identity(after.url) !== identity(page.url)) fact.result = 'unknown';
    return fact;`
}

/** Consume the exact original observation after awaiting it; unknown is never the false branch. */
export function evaluateBrowserTaskBranch(input: {
  execution: BrowserTaskStepExecution
  report: BrowserScriptRunReport
  navigationId: string | null
  currentNavigationId: string | null
  current: boolean
}): { result: 'true' | 'false' | 'unknown'; navigationId: string } {
  const { execution, report, navigationId, currentNavigationId, current } = input
  const raw = report.result
  const unknown = { result: 'unknown' as const, navigationId: navigationId ?? '' }
  if (!current || !navigationId || currentNavigationId !== navigationId || report.outcome.kind !== 'completed' ||
      report.runOperation.browserId !== execution.browserId || !report.runOperation.id ||
      !raw || typeof raw !== 'object' || Array.isArray(raw)) return unknown
  try { if (Buffer.byteLength(JSON.stringify(raw)) > 2048) return unknown } catch { return unknown }
  const fact = raw as BranchFact
  if (fact.schema !== SCHEMA || fact.browserId !== execution.browserId || fact.runId !== execution.runId || fact.assetId !== execution.assetId ||
      fact.version !== execution.version || fact.stepId !== execution.stepId || fact.navigationId !== navigationId ||
      !['true', 'false', 'unknown'].includes(fact.result)) return unknown
  return { result: fact.result, navigationId }
}
