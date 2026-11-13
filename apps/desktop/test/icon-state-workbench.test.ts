// @vitest-environment happy-dom
import {readFile} from 'node:fs/promises'
import {afterEach, expect, it, vi} from 'vitest'
import {AUTHORED_ICON_DESIGNS,AUTHORED_ICON_GLYPH_IDS} from '../../../packages/client-ui/src/theme/icon-authored.js'
import {removeIconSprite} from '../../../packages/client-ui/src/theme/icon-sprite.js'
import {getSemanticIconCatalog} from '../../../packages/client-ui/src/theme/icon-catalog-metadata.js'
import {ICON_GLYPHS} from '../../../packages/client-ui/src/theme/icon-catalog.js'
import {createReviewCatalog} from '../scripts/icon-review/catalog.mjs'
import futureDesigns from '../scripts/icon-review/future-designs.json'

afterEach(() => { window.dispatchEvent(new Event('pagehide')); removeIconSprite(document); document.body.replaceChildren(); vi.unstubAllGlobals() })

it('projects every authored state design into the actual workbench, plays only the selected sample and retains original drafts', async () => {
  const html=await readFile('apps/desktop/scripts/icon-review/index.html','utf8')
  const catalog=JSON.stringify(await createReviewCatalog({getSemanticIconCatalog,ICON_GLYPHS,AUTHORED_ICON_GLYPH_IDS}))
  const manifest=await readFile('apps/desktop/scripts/icon-review/review-manifest.json','utf8')
  const page=new DOMParser().parseFromString(html.replace(/<link[^>]*>|<script[^>]*><\/script>/g,''),'text/html')
  page.querySelectorAll('link,script').forEach(node=>node.remove())
  document.documentElement.innerHTML=page.documentElement.innerHTML
  let narrow=false
  const mediaChanges=new Set<() => void>(), observedMotes=new Set<Element>()
  vi.stubGlobal('matchMedia',(query:string)=>({
    get matches(){return query==='(max-width:950px)'&&narrow},
    addEventListener(_type:string,callback:() => void){if(query==='(max-width:950px)')mediaChanges.add(callback)},
    removeEventListener(_type:string,callback:() => void){mediaChanges.delete(callback)}
  }))
  vi.stubGlobal('IntersectionObserver',class {
    constructor(private callback:IntersectionObserverCallback){}
    observe(node:Element){observedMotes.add(node);this.callback([{target:node,isIntersecting:true,intersectionRatio:1} as IntersectionObserverEntry],this as unknown as IntersectionObserver)}
    unobserve(node:Element){observedMotes.delete(node)}
    disconnect(){observedMotes.clear()}
  })
  vi.stubGlobal('fetch',async (url:string)=>new Response(url.endsWith('catalog.json')?catalog:manifest,{status:200,headers:{'Content-Type':'application/json'}}))
  localStorage.removeItem('agentmux.icon-review.v1')
  await import('../scripts/icon-review/app.js')
  const review=()=> (window as unknown as {iconReview:{ready:boolean;buildPacket():{summary:{changed_roles:number};history:unknown[]};exportTheme():string}}).iconReview
  await vi.waitFor(()=>expect(review()?.ready).toBe(true))
  const before=review().exportTheme()
  document.getElementById('view-motion')!.click()
  const ids=Object.keys(AUTHORED_ICON_DESIGNS)
  expect(ids.length).toBeGreaterThan(0)
  const cards=[...document.querySelectorAll<HTMLElement>('[data-motion-glyph]')]
  expect(cards.map(e=>e.dataset.motionGlyph)).toEqual(ids)
  expect(document.querySelector('#inventory-content [data-icon-animation]')).toBeNull()
  for(const card of cards){
    const id=card.dataset.motionGlyph as keyof typeof AUTHORED_ICON_DESIGNS,design=AUTHORED_ICON_DESIGNS[id]
    card.click()
    expect(document.getElementById('motion-title')!.textContent).toBe(id)
    expect(document.querySelectorAll('#motion-dialog [data-icon-animation]')).toHaveLength(design.motion.kind==='still'?0:1)
    expect(document.querySelector('.motion-role-list [data-icon-animation]')).toBeNull()
    document.querySelector<HTMLElement>('[data-close="motion-dialog"]')!.click()
    expect(document.getElementById('motion-content')!.children).toHaveLength(0)
  }
  document.querySelector<HTMLElement>('[data-motion-glyph="work-writing"]')!.click()
  expect(document.querySelector('#authored-demo [data-semantic-work="status.working"]')).not.toBeNull()
  expect(document.querySelectorAll('#authored-demo [data-semantic-work="status.working"] use')).toHaveLength(2)
  document.querySelector<HTMLElement>('[data-close="motion-dialog"]')!.click()
  document.querySelector<HTMLElement>('[data-motion-glyph="demonstration-edit"]')!.click()
  const first=document.querySelector('#authored-demo .semantic-icon-motion')
  expect(first).not.toBeNull()
  // A background tab can deliver the previous native close event after a new open.
  document.getElementById('motion-dialog')!.dispatchEvent(new Event('close'))
  expect(document.querySelector('#authored-demo .semantic-icon-motion')).toBe(first)
  document.getElementById('replay-motion')!.click()
  expect(document.querySelector('#authored-demo .semantic-icon-motion')).not.toBe(first)
  document.querySelector<HTMLElement>('[data-close="motion-dialog"]')!.click()
  document.querySelector<HTMLElement>('[data-motion-glyph="content-stream"]')!.click()
  const carrier=document.querySelector<HTMLElement>('#authored-demo .semantic-icon-motion')!
  document.getElementById('pause-motion')!.click();expect(carrier.style.animationPlayState).toBe('paused');expect(carrier.style.getPropertyValue('--icon-motion-play-state')).toBe('paused')
  document.getElementById('pause-motion')!.click();expect(carrier.style.animationPlayState).toBe('running');expect(carrier.style.getPropertyValue('--icon-motion-play-state')).toBe('running')
  document.querySelector<HTMLElement>('[data-close="motion-dialog"]')!.click()
  document.getElementById('view-future')!.click()
  const candidates=[...document.querySelectorAll<HTMLElement>('[data-future-glyph]')]
  expect(futureDesigns.length).toBeGreaterThan(0)
  expect(candidates.map(candidate => candidate.dataset.futureGlyph)).toEqual(futureDesigns.map(design => design.id))
  expect(candidates.some(candidate => candidate.dataset.futureGlyph === 'shared-content')).toBe(false)
  for(const candidate of candidates) expect(ICON_GLYPHS).not.toHaveProperty(candidate.dataset.futureGlyph!)
  expect(ICON_GLYPHS).toHaveProperty('note-block')
  expect(ICON_GLYPHS).toHaveProperty('shared-block')
  expect(document.querySelectorAll('[data-pick]')).toHaveLength(0)
  document.getElementById('view-gallery')!.click()
  expect(document.querySelectorAll('[data-glyph]').length).toBe(new Set(getSemanticIconCatalog().icons.map(icon=>icon.defaultGlyph)).size)

  // A split Browser can cross the narrow breakpoint while a non-editing view is
  // selected. The hidden desktop inspector must never become an invisible modal.
  const inspector=document.getElementById('inspector') as HTMLDialogElement
  expect(inspector.open).toBe(true)
  document.getElementById('view-mote')!.click()
  await vi.waitFor(()=>expect(document.querySelector('#mote-preview [data-semantic-icon="object.mote"]')).not.toBeNull())
  expect(observedMotes.size).toBe(1)
  for(const width of [true,false]){
    narrow=width;mediaChanges.forEach(change=>change())
    expect(inspector.open).toBe(false)
  }
  // Back-forward cache restores the same document: pagehide releases the real
  // React/motion owner, and persisted pageshow must mount one live owner again.
  window.dispatchEvent(new Event('pagehide'))
  expect(document.querySelector('#mote-preview svg')).toBeNull()
  expect(observedMotes.size).toBe(0)
  const restored=new Event('pageshow');Object.defineProperty(restored,'persisted',{value:true})
  window.dispatchEvent(restored)
  await vi.waitFor(()=>expect(document.querySelector('#mote-preview [data-semantic-icon="object.mote"]')).not.toBeNull())
  expect(observedMotes.size).toBe(1)
  document.getElementById('view-future')!.click()
  expect(observedMotes.size).toBe(0)
  narrow=true;mediaChanges.forEach(change=>change())
  expect(inspector.open).toBe(false)
  document.getElementById('view-gallery')!.click()
  expect(inspector.open).toBe(false)
  narrow=false;mediaChanges.forEach(change=>change())
  expect(inspector.open).toBe(true)
  expect(review().exportTheme()).toBe(before)
  expect(review().buildPacket().summary.changed_roles).toBe(0)
  expect(review().buildPacket().history).toEqual([])
  expect(localStorage.getItem('agentmux.icon-review.v1')).toBeNull()
}, 20000)
