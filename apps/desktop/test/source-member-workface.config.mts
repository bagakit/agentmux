import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_MEMBER_WORKFACE_MUTATION
const file = 'apps/desktop/src/renderer/src/components/MountedSpaceAgent.tsx'
const variants: Record<string, {file?:string; from:string; to:string}> = {
  'suspend-settled': { from:'interactiveResize={interactiveResize}', to:'interactiveResize={true}' },
  'local-conversation': { from:'port: original.conversation,', to:'port: api.conversation,' },
  'wrong-run-resize': {file:'apps/desktop/src/main/space-member-surface.ts',from:'client.resizeTerminal(input.target.expectedRun, value.cols, value.rows)',to:"client.resizeTerminal({runId:input.target.expectedRun.runId + '-wrong'}, value.cols, value.rows)"},
  'drop-live-conversation': {from:'conversations.get(event.readerId)?.(event.observation)',to:'undefined'},
  'drop-status-refresh': {file:'apps/desktop/src/main/space-member-surface.ts',from:" || event.type === 'agent-status'",to:''},
  'drop-coalesced-update': {file:'apps/desktop/src/main/space-member-surface.ts',from:'if (reading) { readAgain = true; return }',to:'if (reading) return'},
}
if (mutation && !variants[mutation]) throw Error('Unknown member workface mutation')
export default { ...base, cacheDir: resolve(root, '.tmp/source-member-workface-' + (mutation ?? 'candidate')),
 plugins: [...base.plugins ?? [], { name: 'member-workface-source-proof', enforce: 'pre' as const, transform(source: string,id: string) {
  const path = relative(root,id.split('?')[0]!); if (path !== (mutation ? variants[mutation]!.file ?? file : file)) return
  let code = source
  if (mutation) { const {from,to} = variants[mutation]!; if (!source.includes(from)) throw Error('Missing production mutation anchor'); code=source.replaceAll(from,to) }
  if (process.env.AGENTMUX_MEMBER_WORKFACE_LOADED) appendFileSync(process.env.AGENTMUX_MEMBER_WORKFACE_LOADED,JSON.stringify({file:path,mutation:mutation??null,original: createHash('sha256').update(source).digest('hex'),loaded:createHash('sha256').update(code).digest('hex')})+'\n')
  return {code,map:null}
 }}],
 test: { ...base.test, include: ['apps/desktop/test/source-member-workface.test.tsx'], passWithNoTests:false, testTimeout:20000, hookTimeout:20000 }
}
