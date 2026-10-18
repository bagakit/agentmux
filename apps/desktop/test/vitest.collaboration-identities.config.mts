import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
export const identityMutations = [
  { name: 'exact-store-selector', file: 'main/runtime-controller.ts', before: 'host.client.sessionHistorySources({ agentSessionId: reference.agentSessionId })', after: 'host.client.sessionHistorySources()' },
  { name: 'original-owner', file: 'main/runtime-controller.ts', before: 'hostId === reference.hostId)', after: "hostId === 'another-owner')" },
  { name: 'ipc-consumer', file: 'main/ipc.ts', before: 'args.runtime.sessionHistorySource(reference)', after: 'args.runtime.sessionHistorySources()' },
  { name: 'map-consumer', file: 'renderer/src/components/AgentCollaborationMap.tsx', before: 'wanted, catalog.agents, enabled, facts.config?.hosts', after: 'wanted, catalog.agents, false, facts.config?.hosts' },
  { name: 'partial-observation', file: 'renderer/src/lib/focus-history-sources.ts', before: 'api.sessions.historySources({ observation: true })', after: 'api.sessions.historySources()' },
  { name: 'identity-check', file: 'renderer/src/lib/use-collaboration-identities.ts', before: 'result.source.agentSessionId !== reference.agentSessionId', after: 'false' },
  { name: 'late-owner-result', file: 'renderer/src/lib/use-collaboration-identities.ts', before: 'if (!accepted()) return\n          const read = { reference, source: result.source', after: 'const read = { reference, source: result.source' },
  { name: 'pending-connection-result', file: 'renderer/src/lib/use-collaboration-identities.ts', before: 'current() && !request.invalidated', after: 'current()' },
  { name: 'offscreen-explicit-retry', file: 'renderer/src/lib/use-collaboration-identities.ts', before: '[...wanted, ...retries.current.keys()]', after: '[...wanted]' },
  { name: 'semantic-owner-epoch', file: 'main/runtime-controller.ts', before: 'runtimeOwner(host.client)?.ownerInstanceId !== owner.ownerInstanceId', after: 'false' },
  { name: 'returned-session', file: 'main/runtime-controller.ts', before: 'sources.some(source => source.agentSessionId !== reference.agentSessionId)', after: 'false' },
  { name: 'demand-scope-churn', file: 'renderer/src/lib/use-collaboration-identities.ts', before: 'const current = () => enabled && currentOwner.current === ownerToken', after: 'const current = () => active' },
  { name: 'retained-creation', file: 'renderer/src/lib/agent-collaboration.ts', before: 'for (const source of retained)', after: 'for (const source of [])' }
] as const
const selected = process.env.AGENTMUX_MAP_IDENTITY_MUTATION, mutation = identityMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown identity mutation')
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
export default defineConfig({ ...shared, define: { ...shared.define, __AGENTMUX_WEB_PREVIEW__: process.env.AGENTMUX_MAP_IDENTITY_BRIDGE ? 'false' : 'true' },
  plugins: [...shared.plugins ?? [], { name: 'map-identity-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    let code = source
    if (mutation && path === 'apps/desktop/src/' + mutation.file) {
      if (source.split(mutation.before).length !== 2) throw Error('One exact identity mutation anchor required')
      code = code.replace(mutation.before, mutation.after)
    }
    if (process.env.AGENTMUX_MAP_IDENTITY_LOADED) appendFileSync(process.env.AGENTMUX_MAP_IDENTITY_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: code !== source }) + '\n')
    if (code !== source) return { code, map: null }
  } }], test: { ...shared.test, include: [process.env.AGENTMUX_MAP_IDENTITY_BRIDGE ? 'apps/desktop/test/collaboration-identity-bridge.test.tsx' : 'apps/desktop/test/collaboration-identities.test.tsx'], passWithNoTests: false } })
