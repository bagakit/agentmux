import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mote-discussion-threads.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
 'duplicate-count': ['apps/desktop/src/renderer/src/components/MoteThreadsPanel.tsx', 'moteWorkEvents(dialogue.page.links).length', 'dialogue.page.links.length'],
 'unknown-zero': ['apps/desktop/src/renderer/src/components/MoteThreadsPanel.tsx', "dialogue?.page?.sourceStatus === 'read'", 'dialogue?.page'],
 'wrong-host': ['apps/desktop/src/renderer/src/components/MoteActiveWorkShortcut.tsx', 'source.origin.hostId === member.hostId && ', ''],
 'waiting-is-active': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', "item.observation.semantic === 'active'", "item.observation.semantic !== 'unknown'"],
 'drop-main-dom': ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx', 'hidden={!showOriginal} inert={!showOriginal}>{children}</div>', 'hidden={!showOriginal} inert={!showOriginal}>{showOriginal ? children : null}</div>']
}
const name = process.env.AGENTMUX_MOTE_TOP_MUTATION
if(name && !mutations[name]) throw Error('Unknown top navigation mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], { name: 'actual-top-navigation-counterexample', enforce: 'pre', transform(original, id) {
 if(!name) return
 const [file,before,after] = mutations[name]!
 if(relative(root,id.split('?')[0]!)!==file) return
 if(original.split(before).length!==2) throw Error('Expected one actual source anchor: '+name)
 const changed = original.replace(before,after), trace = process.env.AGENTMUX_MOTE_TOP_TRACE
 if(!trace) throw Error('Actual loaded source trace required')
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
 appendFileSync(trace,JSON.stringify({name,file,original:sha(original),changed:sha(changed)})+'\n')
 return {code:changed,map:null}
} }], test: {...base.test,include:['apps/desktop/test/mote-discussion-threads.test.tsx','apps/desktop/test/mote-threads-source.test.tsx','apps/desktop/test/mote-thread-discovery.test.tsx'],passWithNoTests:false} })
