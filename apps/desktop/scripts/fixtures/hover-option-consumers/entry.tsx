import { fixturePath as _historyFixturePath } from "../../../../../test/fixture-values.mjs"
import {useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TopicCategoryDialog} from '../../../src/renderer/src/components/TopicCategoryDialog'
import {ConfirmationDialog} from '../../../src/renderer/src/components/ConfirmationDialog'
import {NotebookCreateDialog} from '../../../src/renderer/src/components/NotebookNavigation'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/styles/recall.css'
import {mountThemeRuntime} from '@agentmux/client-ui/theme'
import {NotebookSelector} from '../../../src/renderer/src/components/NotebookSelector'
import {SpaceCreateMenu} from '../../../src/renderer/src/components/SpaceCreateMenu'
import {TopicCategoryActionsMenu,TopicCategoryContextMenu} from '../../../src/renderer/src/components/TopicCategoryMenu'
import {TopicActionsMenu,TopicContextMenu} from '../../../src/renderer/src/components/TopicContextMenu'
import {resolveOverlayContainer} from '../../../src/renderer/src/components/WindowOverlayHost'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../../test/fixture-values.mjs'


mountThemeRuntime(window,{themeId:'graphite',appAppearance:'dark'})

const actions: {action:string;invoker:string|null}[]=[],errors:string[]=[]
window.addEventListener('error',event=>errors.push(event.message))
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)))
const category={key:'original-category',name:'Research',kind:'category' as const}
const record=(action:string)=>actions.push({action,invoker:document.activeElement?.getAttribute('aria-label')??null})
let show:(active:boolean)=>void
function App(){
 const [book,setBook]=useState('first'),[active,setActive]=useState(true),[dialog,setDialog]=useState<string|null>(null);show=setActive
 const invoker=useRef<HTMLElement|null>(null),notebookTrigger=useRef<HTMLButtonElement>(null)
 const open=(name:string)=>{record(name);invoker.current=document.activeElement as HTMLElement;setDialog(name)}
 const topic={pinned:false,onCopyPath:()=>record('path'),onCopyLink:()=>record('topic-link'),onRename:()=>open('Rename Topic'),onReveal:()=>record('reveal'),onTogglePin:()=>record('pin'),onEditWiki:()=>open('Edit Wiki')}
 const categoryActions={target:category,onChangeIcon:()=>open('Change Category avatar'),onRename:()=>open('Rename Category'),onCopyLink:()=>record('category-link')}
 return <main className="proof-page"><h1>Options stay one step away</h1><p>Original input and selection remain in place while these actual product menus are previewed.</p>
  <textarea aria-label="Original input" defaultValue="Original unsent draft stays here." />
  <div className="proof-options">
   <section className="proof-entry"><small>Recall · Notebook</small><NotebookSelector triggerRef={notebookTrigger} active={active} pending={false} notebooks={[{notebookId:'first',name:'Quick notes',createdAt:_historyFixtureEpoch(0, 0, 1)},{notebookId:'second',name:'Research notebook',createdAt:_historyFixtureEpoch(0, 0, 2)}]} selectedId={book} onSelect={id=>{record('select:'+id);setBook(id)}} onCreate={()=>open('Create Notebook')} /></section>
   <section className="proof-entry"><small>Space</small><SpaceCreateMenu onOpenFolder={async()=>{record('Open Folder')}} /></section>
   <section className="proof-entry"><small>Topic category</small><TopicCategoryContextMenu {...categoryActions}><div className="proof-row space-category-heading" data-context="category">Research<TopicCategoryActionsMenu {...categoryActions} /></div></TopicCategoryContextMenu></section>
   <section className="proof-entry"><small>Topic</small><TopicContextMenu {...topic}><div className="proof-row" data-context="topic">Original Topic<TopicActionsMenu title="Original Topic" {...topic} /></div></TopicContextMenu></section>
  </div>
  <TopicCategoryDialog target={dialog==='Rename Category'?{categoryId:'original-category',hostId:'local',spaceId:'original-category',directoryPath:_historyFixturePath("private-fixture/category"),title:'Research',revision:'original-revision'}:null} onClose={()=>setDialog(null)} returnFocus={()=>invoker.current} />
  <NotebookCreateDialog active={active} open={dialog==='Create Notebook'} onClose={()=>setDialog(null)} onCreated={()=>{throw Error('No notebook write belongs to this presentation fixture')}} restoreFocus={()=>notebookTrigger.current?.focus()} />
  <ConfirmationDialog open={dialog==='Rename Topic'} title="Original Topic action" description="The existing shared dialog returns to this exact menu invoker." intent="neutral" confirmLabel="Continue" onCancel={()=>setDialog(null)} onConfirm={()=>{throw Error('No domain write belongs to this presentation fixture')}} />
 </main>
}
createRoot(document.getElementById('root')!).render(<App />)
const input=()=>document.querySelector<HTMLTextAreaElement>('[aria-label="Original input"]')!
const rect=(node:Element)=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}
;(window as any).proof={
 ready:true,showNotebook:(active:boolean)=>show(active),
 prepare(){input().focus();input().setSelectionRange(2,9)},
 facts(){return{actions:[...actions],errors:[...errors],inputFocused:document.activeElement===input(),draft:input().value,selection:[input().selectionStart,input().selectionEnd],menuCount:document.querySelectorAll('[role="menu"]').length,dialog:document.querySelector('[role="dialog"]')?.textContent??null,dialogFocused:!!document.activeElement?.closest('[role="dialog"]'),focused:document.activeElement?.getAttribute('aria-label'),triggers:[...document.querySelectorAll<HTMLButtonElement>('.proof-options button')].filter(x=>x.getAttribute('aria-haspopup')==='menu').map(x=>({label:x.getAttribute('aria-label'),...rect(x)})),items:[...document.querySelectorAll('[role^="menuitem"]')].map(x=>({text:x.textContent,...rect(x)}))}},
 trigger(label:string){return rect(document.querySelector('[aria-label="'+label+'"]')!)},
 item(text:string){return rect([...document.querySelectorAll('[role^="menuitem"]')].find(x=>x.textContent===text)!)},
 context(kind:string){return rect(document.querySelector('[data-context="'+kind+'"]')!)}
}
