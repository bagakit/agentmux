import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import source from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'

const variants = {
  'reader-disconnected': ['AgentInformationReader.tsx', "context.kind === 'agent' ? <AgentTakeoverRelations", 'false ? <AgentTakeoverRelations'],
  'owner-ignored': ['AgentTakeoverRelations.tsx', 'page.owner.runtimeId === query.expectedRuntimeId &&', 'true &&'],
  'direction-ignored': ['AgentTakeoverRelations.tsx', 'page.direction === query.direction &&', 'true &&'],
  'subject-ignored': ['AgentTakeoverRelations.tsx', 'page.subject.runtimeId === query.subject.runtimeId && page.subject.agentSessionId === query.subject.agentSessionId &&', 'true &&'],
  'incoming-target-ignored': ['AgentTakeoverRelations.tsx', 'record.agent.runtimeId === query.subject.runtimeId && record.agent.agentSessionId === query.subject.agentSessionId', 'true'],
  'outgoing-source-ignored': ['AgentTakeoverRelations.tsx', 'record.takeover.source.runtimeId === query.subject.runtimeId && record.takeover.source.agentSessionId === query.subject.agentSessionId', 'true'],
  'unknown-nature-defaulted': ['AgentTakeoverRelations.tsx', "value === null ? 'Nature unconfirmed'", "value === null ? 'Takeover'"],
  'nature-reclassified': ['AgentTakeoverRelations.tsx', "promotion: 'Promotion'", "promotion: 'Handson'"],
  'pagination-hidden': ['AgentTakeoverRelations.tsx', 'held?.outgoing?.nextCursor ? <button', 'false ? <button'],
  'retired-provenance-lost': ['AgentTakeoverRelations.tsx', "inspection.kind === 'retired-agent' ? inspection.history?.creation : inspection.creation", "inspection.kind === 'retired-agent' ? undefined : inspection.creation"],
  'organization-diagnostic-hidden': ['AgentTakeoverRelations.tsx', 'takeover.source.organizationIssue ? <p', 'false ? <p'],
  'refresh-drops-records': ['AgentTakeoverRelations.tsx', 'outgoing: page ?? previous?.outgoing', 'outgoing: page'],
  'source-runtime-pin-dropped': ['AgentTakeoverRelations.tsx', 'api.sessions.owner(subject!.hostId, originalRuntimeId!)', 'api.sessions.owner(subject!.hostId)'],
  'catalog-runtime-erased': ['space-agent-control.ts', '...(originalRuntime === undefined ? {} : { runtimeId: originalRuntime })', '...{}'],
  'serializer-runtime-erased': ['desktop-spatial-state.ts', 'if (region?.execution && runtimeId !== undefined) region.execution.runtimeId = runtimeId;', ''],
  'serializer-source-admission-injected': ['desktop-spatial-state.ts', 'spatialCatalog({ ...state, topicCategories: categories }, topics)', 'spatialCatalog({ ...state, ...(previous ? { originalSpatialGraph: previous } : {}), topicCategories: categories }, topics)'],
  'terminal-runtime-guessed': ['desktop-agent-presentation.ts', "region.kind === 'agent' && region.agentSessionId === session.control.agentSessionId", "(region.kind === 'terminal' || region.kind === 'agent' && region.agentSessionId === session.control.agentSessionId)"],
  'source-directory-ignored': ['desktop-agent-presentation.ts', 'execution.cwd === session.workspacePath', 'true'],
  'location-runtime-ignored': ['AgentTakeoverRelations.tsx', 'route.value.identity.runtimeId === runtimeId', 'true'],
  'chooser-runtime-ignored': ['store.ts', 'request.subject.runtimeId !== undefined && execution?.runtimeId !== request.subject.runtimeId', 'false'],
  'owner-runtime-pin-dropped': ['agent-takeover-ipc.ts', 'expectedRuntimeId === undefined ? {} : { expectedRuntimeId }', '{}'],
  'owner-rebound-ack-accepted': ['runtime-controller.ts', "method === 'runtime.owner.identity' && this.configuredClient(hostId) !== client", 'false']
} as const
const mutation = process.env.AGENT_TAKEOVER_SOURCE_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Choose one exact Takeover Source mutation')
/** Source checks consume public types and the original Reader and owner call paths. */
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], {
  name: 'takeover-source-original-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/core/src/')) return
    let loaded = original
    const change = mutation && variants[mutation]
    if (change && path.endsWith('/' + change[0])) {
      if (original.split(change[1]).length !== 2) throw Error('The Source mutation requires one original production anchor')
      loaded = original.replace(change[1], change[2])
    }
    if (process.env.AGENT_TAKEOVER_SOURCE_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AGENT_TAKEOVER_SOURCE_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded),
        ...(loaded === original ? {} : { mutation }) }) + '\n')
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  }
}], test: { ...source.test, include: ['apps/desktop/test/agent-takeover-source.test.tsx'], passWithNoTests: false } })
