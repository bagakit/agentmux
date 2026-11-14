import {appendFileSync, readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {relative} from 'node:path'
import {defineConfig} from 'vitest/config'
import base from './mote-object-navigation.config.mts'
const owner='apps/desktop/src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx'
const mutations={
 'drag-positions': ['if (drag.current === gesture) paintResize(gesture)', 'if (drag.current === gesture) positionRef.current?.()'],
 'stale-release': ['{ updateResize(event.clientX, event.clientY); endResize(true) }', '{ endResize(true) }'],
 'parallel-position': ['disposed || computing || pending !== null', 'disposed || pending !== null'],
 'gesture-requeues': ['if (!disposed && dirty) position()', 'if (!disposed && (dirty || revision !== geometryRevision.current)) position()'],
 'hide-on-release': ["useLayoutEffect(() => { positionRef.current?.() }, [floating.size?.width, floating.size?.height])", "useLayoutEffect(() => { if (panelRef.current) panelRef.current.style.visibility = 'hidden'; positionRef.current?.() }, [floating.size?.width, floating.size?.height])"]
} as const
const mutation=process.env.MOTE_RESIZE_MUTATION as keyof typeof mutations|undefined
if(mutation&&!mutations[mutation])throw Error('Unknown resize mutation')
export default defineConfig({...base,cacheDir:'.tmp/mote-resize-'+(mutation??'original'),plugins:[...base.plugins??[],{name:'actual-resize-owner',enforce:'pre',transform(original,id){
 const path=relative(base.root!,id.split('?')[0]!)
 if(![owner,'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts','apps/desktop/test/mote-floating-resize.test.tsx'].includes(path))return
 let loaded=original
 if(mutation&&path===owner){const [before,after]=mutations[mutation];if(original.split(before).length!==2)throw Error('One original owner anchor required');loaded=original.replace(before,after)}
 const trace=process.env.MOTE_RESIZE_LOADED,sha=(s:string | Buffer)=>createHash('sha256').update(s).digest('hex')
 if(trace)appendFileSync(trace,JSON.stringify({path,raw:sha(readFileSync(id.split('?')[0]!)),original:sha(original),loaded:sha(loaded),mutation:loaded!==original?mutation:null})+'\n')
 return loaded===original?undefined:{code:loaded,map:null}
 }}],test:{...base.test,include:['apps/desktop/test/mote-floating-resize.test.tsx'],passWithNoTests:false,testTimeout:25000}})
