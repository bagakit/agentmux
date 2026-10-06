import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { Alias } from 'vite'
import original from './vitest.mailbox-collaboration.config.mts'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
const root = resolve(import.meta.dirname, '../../..')
const changes = {
 evidenceScope: ["record: original", "record: { ...original, replies: [] }"],
 evidenceIssue: ["issue: detailIssue", "issue: null"],
 evidenceLoading: ["loadingDetail ? 'reading-unconfirmed'", "false ? 'reading-unconfirmed'"],
 evidenceVisibility: ["[original, detail, selectionOwner]", "[original, detail, selected]"],
 query: ["searchable.includes(query.trim().toLocaleLowerCase())", "true"],
 status: ["status === 'all' || (status === 'waiting' ? item.originAwaits : !item.originAwaits)", "true"],
 names: ["names.get(item.ownerAgentSessionId), names.get(item.workerAgentSessionId)", "'', ''"],
 clear: ["setQuery(''); setStatus('all');", "setQuery('');"],
 preserve: ["++navigationRequest.current; setNavigationIssue(null); setSelected(source)", "setQuery(''); setStatus('all'); ++navigationRequest.current; setNavigationIssue(null); setSelected(source)"],
 input: ["if (event.key === 'Enter') event.stopPropagation()", "if (false) event.stopPropagation()"]
} as const
export default defineConfig({ ...original, resolve: { ...original.resolve, dedupe: ['react','react-dom'], alias: [...(original.resolve!.alias as Alias[]), {find:'react',replacement:resolve(root,'apps/desktop/node_modules/react')}, {find:'react-dom',replacement:resolve(root,'apps/desktop/node_modules/react-dom')}, ...Object.entries(radixOverlayAliases).map(([find,replacement])=>({find,replacement}))] },
 plugins: [...(original.plugins ?? []), { name:'collaboration-record-tools-mutations', enforce:'pre', transform(source,id) {
  const mutation=process.env.COLLABORATION_TOOLS_MUTATION as keyof typeof changes | undefined
  if (!mutation) return
  if (mutation === 'evidenceVersion' as string) {
   if(relative(root,id)!=='packages/client-ui/src/components/ContentCopyButton.tsx') return
   const needle='[text, identity, copyText]'; assert.equal(source.split(needle).length-1,1)
   if(process.env.COLLABORATION_TOOLS_HITS)appendFileSync(process.env.COLLABORATION_TOOLS_HITS,mutation+'\n')
   return {code:source.replace(needle,'[copyText]'),map:null}
  }
  if (mutation === 'parentEscape' as string) {
   if(relative(root,id)!=='apps/desktop/src/renderer/src/components/SessionMailbox.tsx') return
   const needle="event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event)"; assert.equal(source.split(needle).length-1,1)
   if(process.env.COLLABORATION_TOOLS_HITS)appendFileSync(process.env.COLLABORATION_TOOLS_HITS,mutation+'\n')
   return {code:source.replace(needle,"event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)"),map:null}
  }
  if(relative(root,id)!=='apps/desktop/src/renderer/src/components/MailboxCollaboration.tsx') return
  assert.ok(changes[mutation]); const [needle,replacement]=changes[mutation]; assert.equal(source.split(needle).length-1,1)
  if(process.env.COLLABORATION_TOOLS_HITS)appendFileSync(process.env.COLLABORATION_TOOLS_HITS,mutation+'\n')
  return {code:source.replace(needle,replacement),map:null}
 } }], test:{ ...original.test, server:{deps:{inline:[/@radix-ui\//]}}, include:['apps/desktop/test/mailbox-collaboration.test.tsx'], passWithNoTests:false }
})
