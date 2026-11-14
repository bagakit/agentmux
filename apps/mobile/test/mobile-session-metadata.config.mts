import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './conversation-controllers.config.mts'
import { staleDistComplaint } from '../../../vitest.dist-freshness'

const root = resolve(import.meta.dirname, '../../..'), variant = process.env.MOBILE_SESSION_METADATA_MUTATION, trace = process.env.MOBILE_SESSION_METADATA_LOADED
const mutations: Record<string, { file: string; before: string; after: string; target: string }> = {
  'event-per-read': { file: 'apps/mobile/src/conversation/use-hosted-conversation.ts',
    before: 'if (readingMetadata) { metadataDirty = true; metadataEpoch.current++; return }',
    after: '// Every event starts its own read.', target: 'coalesces 20 matching metadata events' },
  'stale-run-reply': { file: 'apps/mobile/src/conversation/use-hosted-conversation.ts',
    before: 'if (readingMetadata) { metadataDirty = true; metadataEpoch.current++; return }',
    after: 'if (readingMetadata) { metadataDirty = true; return }', target: 'after a Run source change' },
  'cache-only': { file: 'apps/mobile/src/conversation/use-hosted-conversation.ts',
    before: 'const result = await readMobileConversationSession(client, id)', after: "const result = (() => { try { return { session: client.agentSession(id), metadata: { state: 'active' as const, issue: null } } } catch { return { session: null, metadata: { state: 'unconfirmed' as const, issue: 'Controlled cache-only metadata' } } } })()", target: 'cache-miss active metadata' },
  'retired-as-unknown': { file: 'apps/mobile/src/conversation/mobile-conversation-session.ts',
    before: 'metadata: { state: exact[0]!.state, issue: null }', after: "metadata: { state: 'unconfirmed' as const, issue: null }", target: 'retired exact descriptors' },
  'sticky-issue': { file: 'apps/mobile/src/conversation/use-hosted-conversation.ts',
    before: 'metadata: result.metadata }', after: 'metadata: { ...result.metadata, issue: original.metadata.issue } }', target: 'explicit metadata refresh while parked' }
}
if (variant && !mutations[variant]) throw new Error('Unknown metadata mutation: ' + variant)
const mutation = variant ? mutations[variant] : undefined
const owners = new Set(['apps/mobile/src/conversation/mobile-conversation-session.ts', 'apps/mobile/src/conversation/use-hosted-conversation.ts',
  'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', 'apps/mobile/test/mobile-session-metadata.test.tsx',
  'packages/core/src/client.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/agent-session-store.ts'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, cacheDir: resolve(root, '.tmp/mobile-session-metadata/vitest', variant ?? 'baseline'),
  // Core, Host and the owning UI workspaces use Source aliases. Qualify the
  // generated identity and remaining compiled dependencies, without unrelated Core/dist.
  plugins: [...(base.plugins ?? []).filter(plugin => !plugin || !('name' in plugin) || plugin.name !== 'mobile-controller-qualified-identity'),
    { name: 'mobile-session-metadata-qualified-assets', async configResolved() {
      for (const [name, entry] of [['identity', 'dist/runtime-source.js'], ['relay', 'dist/connection-offer.js'],
        ['capsule', 'dist/index.js'], ['diagnostic-evidence', 'dist/index.js']] as const) {
        const complaint = await staleDistComplaint(resolve(root, 'packages', name), entry)
        if (complaint) throw new Error(complaint)
      }
    } }, { name: 'mobile-session-metadata-evaluated-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (mutation?.file === file) {
      if (code.split(mutation.before).length !== 2) throw new Error('Metadata mutation anchor must match once: ' + variant)
      code = code.replace(mutation.before, mutation.after)
    }
    if (!trace) return code === source ? undefined : code
    const row = { file, mutation: mutation?.file === file ? variant : null, originalSHA256: sha(source), loadedSHA256: sha(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport { appendFileSync as __metadataEvidence } from 'node:fs'; __metadataEvidence(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
  } }], test: { ...base.test, include: ['test/mobile-session-metadata.test.tsx'], ...(mutation ? { testNamePattern: mutation.target } : {}), maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
}
