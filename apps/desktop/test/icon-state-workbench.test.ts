// @vitest-environment happy-dom
import {readFile} from 'node:fs/promises'
import {afterEach, expect, it, vi} from 'vitest'
import {AUTHORED_ICON_DESIGNS,AUTHORED_ICON_GLYPH_IDS} from '../../../packages/client-ui/src/theme/icon-authored.js'
import {removeIconSprite} from '../../../packages/client-ui/src/theme/icon-sprite.js'
import {getSemanticIconCatalog} from '../../../packages/client-ui/src/theme/icon-catalog-metadata.js'
import {ICON_GLYPHS} from '../../../packages/client-ui/src/theme/icon-catalog.js'
import {createReviewCatalog} from '../scripts/icon-review/catalog.mjs'

afterEach(() => { removeIconSprite(document); document.body.replaceChildren(); vi.unstubAllGlobals() })

it('projects every authored state design into the actual workbench, plays only the selected sample and retains original drafts', async () => {
  const html=await readFile('apps/desktop/scripts/icon-review/index.html','utf8')
  const catalog=JSON.stringify(await createReviewCatalog({getSemanticIconCatalog,ICON_GLYPHS,AUTHORED_ICON_GLYPH_IDS}))
  const manifest=await readFile('apps/desktop/scripts/icon-review/review-manifest.json','utf8')
  document.documentElement.innerHTML=new DOMParser().parseFromString(html,'text/html').documentElement.innerHTML
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}))
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
  document.getElementById('pause-motion')!.click();expect(carrier.style.animationPlayState).toBe('paused')
  document.getElementById('pause-motion')!.click();expect(carrier.style.animationPlayState).toBe('running')
  document.querySelector<HTMLElement>('[data-close="motion-dialog"]')!.click()
  expect(review().exportTheme()).toBe(before)
  expect(review().buildPacket().summary.changed_roles).toBe(0)
  expect(review().buildPacket().history).toEqual([])
  expect(localStorage.getItem('agentmux.icon-review.v1')).toBeNull()
})
