import base from '../apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
const changes: Record<string, [string, string, string]> = {
  'require-peer': ['packages/core/src/conversation-timeline.ts',
    'for (const record of records) relations.push(...conversationInvocationMembers(record))',
    'for (const record of records) relations.push(...conversationInvocationMembers(record).filter(member => records.some(peer => peer.id !== record.id && conversationInvocationMembers(peer).some(other => conversationInvocationId(member.invocation) === conversationInvocationId(other.invocation)))))'],
  'bare-call-identity': ['packages/core/src/conversation-timeline.ts',
    "return JSON.stringify([ref.hostId, ref.agentSessionId, ref.source.providerId, ref.source.nativeSessionId,\n    typeof ref.subject === 'string' ? ['main'] : ['child', ref.subject.nativeActorId],\n    ref.scope.kind, ref.scope.kind === 'turn' ? ref.scope.nativeTurnId : null, ref.callId])",
    'return JSON.stringify(ref.callId)'],
  'trust-foreign-native-source': ['packages/core/src/conversation-timeline.ts',
    "if (record.order.kind !== 'native-page' || !sameSource(fact.invocation.source, record.order.source)) return false",
    'if (false) return false'],
  'skip-member-accounting': ['packages/core/src/conversation-changes.ts',
    "if (!same(relations.filter(relation => relation.kind === 'invocation-member'), records.flatMap(record => conversationInvocationMembers(record))))",
    'if (false)']
}
export default defineConfig({...base, cacheDir: '.cache/conversation-invocation',
  resolve:{...base.resolve, conditions:['module','import','default']},
  ssr:{...base.ssr, resolve:{conditions:['module','import','default']}},
  plugins: [...base.plugins ?? [], {
  name: 'invocation-membership-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!/^(?:packages|apps|test)\//u.test(path) || !/\.(?:ts|tsx|mts)$/u.test(path)) return
    let code = source
    const mutation = process.env.AGENTMUX_INVOCATION_MUTATION
    if (mutation) {
      const change = changes[mutation]
      if (!change) throw Error('Unknown invocation mutation: ' + mutation)
      if (path === change[0]) {
        if (source.split(change[1]).length !== 2) throw Error('Nonunique invocation source anchor: ' + mutation)
        code = source.replace(change[1], change[2])
      }
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_INVOCATION_LOADED) appendFileSync(process.env.AGENTMUX_INVOCATION_LOADED, JSON.stringify({path, originalSHA256:sha(source), sha256:sha(code), ...(source === code ? {} : {mutation})})+'\n')
    if (source !== code) return {code, map:null}
  }
}], test:{...base.test, environment:'node', testTimeout:30000, include:[
  'packages/core/test/conversation-timeline.test.ts',
  'packages/core/test/conversation-unified-public.test.ts',
  'apps/desktop/test/conversation-source-labels.test.tsx',
  'test/conversation-unified-consumers.integration.test.tsx'
], passWithNoTests:false, fileParallelism:false}})
