import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const mutations = {
  'ignore-saved-result': ['lib/session-takeover.ts', "const historyReceipt = source.kind === 'saved'", "const historyReceipt = false && source.kind === 'saved'"],
  'resume-default-missing': ['components/SessionTakeoverSurface.tsx', 'return exact.length === 1 ? exact[0]!.destination : undefined', 'return undefined'],
  'cartesian-destinations': ['components/SessionTakeoverSurface.tsx', 'agentNewTabDestinations(catalog, facts.layouts, undefined, placement)', 'agentNewTabDestinations(catalog, facts.layouts)'],
  'source-run-dropped': ['lib/session-takeover.ts', 'const expectedRun = source.kind === \'session\' ? source.expectedRun : snapshot?.kind === \'agent\' ? snapshot.control.run : undefined', 'const expectedRun = undefined'],
  'request-not-checkpointed': ['lib/session-takeover.ts', 'await checkpointAgentOperations()\n    const result = await api.spatial.openAgent(request)', 'const result = await api.spatial.openAgent(request)'],
  'check-creates-agent': ['lib/session-takeover.ts', 'const result = await api.spatial.inspectOperation({ target: { operationId: requestId } })', 'await api.spatial.openAgent(source.coreRequest); const result = await api.spatial.inspectOperation({ target: { operationId: requestId } })'],
  'prepared-stage-stays-locked': ['components/SessionTakeoverSurface.tsx', "setUnconfirmed(false)\n      setNotice('Club created.", "setUnconfirmed(true)\n      setNotice('Club created."],
  'prepared-core-reference-stale': ['lib/agent-operation-feedback.ts', 'return retained\n}', 'return operation\n}'],
  'club-binding-ignored': ['lib/session-takeover.ts', "if (!confirmed) throw new Error('The Club content is retained;", "if (false) throw new Error('The Club content is retained;"],
  'saved-club-avatar-ignored': ['components/SessionTakeoverSurface.tsx', 'manualIcon={icons[space.spaceId] ?? null}', 'manualIcon={null}'],
  'prepared-topic-reminted': ['store.ts', 'const topicId = preparation?.topicId ?? mintObjectId()', 'const topicId = mintObjectId()'],
  'closed-preparation-reopened': ['store.ts', "(!preparation || preparation.createPresentation === true)", 'true']
} as const
const mutation = process.env.TAKEOVER_FLOW_MUTANT as keyof typeof mutations | undefined
if (mutation && !mutations[mutation]) throw Error('Choose an exact Takeover flow mutation')
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], {
  name: 'takeover-flow-loaded-owner', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/core/src/') && !path.startsWith('apps/host/src/')) return
    let loaded = original
    const change = mutation && mutations[mutation]
    if (change && path.endsWith('/' + change[0])) {
      if (original.split(change[1]).length !== 2) throw Error('The Takeover flow mutation requires one original production anchor: ' + mutation)
      loaded = original.replace(change[1], change[2])
    }
    if (process.env.TAKEOVER_FLOW_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.TAKEOVER_FLOW_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded),
        ...(loaded === original ? {} : { mutation }) }) + '\n')
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  }
}], test: { ...source.test,
  include: ['apps/desktop/test/takeover-flow.test.tsx'], passWithNoTests: false } })
