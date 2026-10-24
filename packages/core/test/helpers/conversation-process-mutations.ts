import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../..')
export const processDetailMutations: Record<string, { suite: 'core' | 'ui'; path: string; from: string; to: string }> = {
  'bypass-deferred': { suite: 'core', path: 'packages/core/src/conversation-reader.ts', from: "unit.event.role === 'process' && unit.records.every", to: 'false && unit.records.every' },
  'cross-source-acceptance': { suite: 'core', path: 'packages/core/src/conversation-changes.ts', from: 'input.anchor && !same(anchor, input.anchor) || anchor &&', to: 'false || anchor &&' },
  'lost-invocation': { suite: 'core', path: 'packages/core/src/conversation-changes.ts', from: "if (!same(relations.filter(relation => relation.kind === 'invocation-member'), records.flatMap(record => conversationInvocationMembers(record))))", to: "if (false && !same(relations.filter(relation => relation.kind === 'invocation-member'), records.flatMap(record => conversationInvocationMembers(record))))" },
  'incomplete-fragment': { suite: 'core', path: 'packages/core/src/conversation-changes.ts', from: 'if (fragment || units.length !== page.window.itemCount || !page.window.view)', to: 'if (units.length !== page.window.itemCount || !page.window.view)' },
  'hidden-eager-read': { suite: 'ui', path: 'packages/client-ui/src/components/DeferredConversationProcess.tsx', from: 'if (!expanded || !active || loaded || error) return', to: 'if (!active || loaded || error) return' },
  'latest-version-substitution': { suite: 'ui', path: 'packages/client-ui/src/lib/read-conversation-process-detail.ts', from: '{ ...reference, anchor, limit: 100,', to: '{ ...reference, record: anchor.record, limit: 100,' },
  'eager-json-format': { suite: 'ui', path: 'packages/client-ui/src/components/ConversationToolPayload.tsx', from: 'formatted && validJson ? applyEdits', to: 'validJson ? applyEdits' },
  'collapse-unmount': { suite: 'ui', path: 'packages/client-ui/src/components/DeferredConversationProcess.tsx', from: '{loaded?.map((snapshot, index)', to: '{(expanded ? loaded : null)?.map((snapshot, index)' },
}
export function processDetailSourceProof() {
  const mutation = process.env.AGENTMUX_LAZY_MUTATION, selected = mutation ? processDetailMutations[mutation] : undefined
  if (mutation && !selected) throw Error('Unknown deferred detail mutation: ' + mutation)
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  return { name: 'process-detail-source-proof', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!/^(packages|apps)\//u.test(path) || path.includes('/node_modules/') || !/\.tsx?$/u.test(path)) return
    let code = source
    if (selected?.path === path) {
      if (source.split(selected.from).length !== 2) throw Error('Missing unique deferred detail mutation: ' + mutation)
      code = source.replace(selected.from, selected.to)
    }
    if (process.env.AGENTMUX_LAZY_LOADED) appendFileSync(process.env.AGENTMUX_LAZY_LOADED, JSON.stringify({ path, fileSHA256: hash(readFileSync(file)), originalSHA256: hash(source), sha256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }
}
