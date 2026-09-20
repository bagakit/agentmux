import { BROWSER_PAGE_CAPABILITY_NAMES } from '@agentmux/core'
import type { BrowserReplayPlan, BrowserReplayStep } from '../shared/browser-operation.js'

const REPLAYABLE_METHODS: ReadonlySet<string> = new Set(BROWSER_PAGE_CAPABILITY_NAMES)

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString()
  } catch { return 'about:blank' }
}

/** One compiler for history replay and reviewed Client assets; no Runtime or operation identity. */
export function compileBrowserSteps(input: { url: string; steps: BrowserReplayStep[] }): string {
  const expectedUrl = JSON.stringify(safeUrl(input.url))
  const steps = input.steps.map(step => {
    if (step.blockedReason) return `throw new Error(${JSON.stringify(step.blockedReason)})`
    // The verb is the only unquoted source fragment. Derive its allowlist from the real page API.
    if (!REPLAYABLE_METHODS.has(step.method)) return `throw new Error(${JSON.stringify(
      `Recorded step "${step.method}" is not a replayable Browser page function; inspect the operation history before retrying.`
    )})`
    if (step.target) {
      const target = JSON.stringify(step.target)
      const args = JSON.stringify(step.args)
      return `{
        const page = await snapshot({ maxNodes: 1000 });
        const observed = page.observation;
        if (!observed || observed.scope.kind !== 'page' || observed.scope.document !== null ||
            observed.truncated || observed.omittedFrames.length || (page.missingFrames && page.missingFrames.length)) {
          throw new Error('Replay target observation is incomplete; inspect the page before retrying.');
        }
        const expected = ${target};
        const matches = page.nodes.filter((node) => node.role === expected.role && node.name === expected.name);
        const targetNode = matches[expected.ordinal - 1];
        if (!targetNode || matches.length !== expected.count) throw new Error('Replay target changed; inspect the page before retrying.');
        await ${step.method}(targetNode.ref${step.method === 'click' || step.method === 'hover' || step.method === 'scroll' ? '' : `, ...${args}`});
      }`
    }
    return `await ${step.method}(...${JSON.stringify(step.args)})`
  }).join('\n')
  return `const pageIdentity = await pageInfo();
  if (${expectedUrl} !== 'about:blank' && pageIdentity.url.split('?')[0].split('#')[0] !== ${expectedUrl}.split('?')[0].split('#')[0]) {
    throw new Error('Replay page identity changed; inspect the current page before retrying.');
  }
  ${steps}`
}

export function buildReplayScript(plan: BrowserReplayPlan): string {
  return `${compileBrowserSteps(plan)}\nreturn { replayOf: ${JSON.stringify(plan.operationId)}, steps: ${plan.steps.length} }`
}
