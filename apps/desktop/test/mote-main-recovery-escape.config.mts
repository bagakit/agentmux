import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..'), name = process.env.AGENTMUX_MOTE_ESCAPE_MUTANT
const variants: Record<string, {file:string; edits:Array<[string,string]>}> = {
  'fold-original-actions': {file:'components/ActivityView.tsx',edits:[['{!moteConversation ? readingAction : null}', '{readingAction}'],['{readingAction ? <div className="activity-feed__session-actions"','{false ? <div className="activity-feed__session-actions"']]},
  'failure-needs-entry': {file:'lib/mote-main-entry.ts',edits:[["const canonicalUnavailable = currentOriginal?.kind === 'unavailable'", "const canonicalUnavailable = Boolean(entryToken) && currentOriginal?.kind === 'unavailable'"]]},
  'old-run-failure': {file:'lib/mote-main-entry.ts',edits:[['original.previousRun.runId === session?.control.run.runId','true']]},
  'metadata-revives-entry': {file:'lib/mote-main-entry.ts',edits:[['JSON.stringify([target,entryToken])','JSON.stringify([target,entryToken,session?.continuity])']]},
  'source-gates-original-position': {file:'lib/mote-main-action.ts',edits:[['export async function readMoteMainStartPosition(scope: MoteWorkfaceScope, operationId: string) {','export async function readMoteMainStartPosition(scope: MoteWorkfaceScope, operationId: string) { await inspectMoteMainAction(scope, operationId)']]},
  'position-borrows-current-main': {file:'lib/mote-main-action.ts',edits:[['const reference = moteMainCreatedReference(record)','const reference = (await api.moteDialogue.read({ target })).main.current']]},
  'late-unavailable-on-healthy-run': {file:'lib/mote-main-entry.ts',edits:[[": state.key === key && !(state.status === 'unavailable' && session?.processState === 'running') ? state :",': state.key === key ? state :']]},
  'hide-retained-request': {file:'components/MoteMainActions.tsx',edits:[['...(retained && (!result','...(reading && retained && (!result']]}
}
if(name && !variants[name]) throw Error('Unknown recovery escape mutation')
export default defineConfig({ ...base, cacheDir: base.cacheDir + '-recovery-escape', plugins:[...base.plugins ?? [],{
  name:'loaded-original-mote-escape',enforce:'pre',transform(original,id){
    const file=relative(root,id.split('?')[0]!), target=name && variants[name]
    if(!target || file!=='apps/desktop/src/renderer/src/'+target.file)return
    let changed=original
    for(const [before,after] of target.edits){if(changed.split(before).length!==2)throw Error('Expected one exact production anchor: '+name);changed=changed.replace(before,after)}
    const trace=process.env.AGENTMUX_MOTE_ESCAPE_TRACE;if(!trace)throw Error('Loaded production trace required')
    const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
    appendFileSync(trace,JSON.stringify({name,file,original:sha(original),changed:sha(changed)})+'\n')
    return {code:changed,map:null}
  }
}],test: { ...base.test, include: ['apps/desktop/test/mote-main-recovery-escape.test.tsx'], passWithNoTests: false, maxWorkers: 1, testTimeout: 30000 } })
