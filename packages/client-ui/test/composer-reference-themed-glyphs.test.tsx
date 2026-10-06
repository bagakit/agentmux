// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { InlineComposer } from '../src/components/InlineComposer.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { encodeSemanticReference, type ComposerSemanticReference } from '../src/lib/composer-semantic-reference.js'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '../src/theme/index.js'
import { semanticIconHref } from '../src/theme/icons.js'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined, cleanup: (() => void) | undefined
const references: ComposerSemanticReference[] = [
 {kind:'skill',label:'Original skill',reference:'skills/original/SKILL.md',token:'original-skill'},
 {kind:'component',label:'Original component',reference:'components/Original.tsx',token:'original-component'},
 {kind:'file',label:'Original file',reference:'src/original.ts',token:'original-file'},
 {kind:'subcommand',label:'Original expansion',reference:'Expanded original authored prompt',token:'original-command'}
]
afterEach(async()=>{await act(async()=>root?.unmount());root=undefined;cleanup?.();cleanup=undefined;document.body.replaceChildren();vi.restoreAllMocks()})
it('all four actual TipTap NodeViews retain semantic references, selection and activation while root geometry changes',async()=>{
 cleanup=mountThemeRuntime(window)
 const host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const changed=vi.fn(),activated=vi.fn(),platform={bindComposerFocus:()=>()=>{}} as ClientUiPlatform
 const value='Unsaved '+references.map(encodeSemanticReference).join(' ')+' tail'
 await act(async()=>root!.render(<ClientUiProvider platform={platform}><InlineComposer value={value} onValueChange={changed} onActivateReference={activated} disabled={false} placeholder="Original draft" aria-label="Original draft" onKeyDown={()=>{}}/></ClientUiProvider>))
 const editor=host.querySelector<HTMLElement>('[role=textbox]')!,nodes=references.map(r=>editor.querySelector<HTMLElement>(`[data-tool-reference="${r.kind}"]`)!)
 expect(nodes).toHaveLength(4)
 for(const[n,index]of nodes.map((n,index)=>[n,index] as const)){
  const reference=references[index]!,id=`conversation.reference-${reference.kind}` as const
  expect(n,'actual nonempty reference NodeView').not.toBeNull();expect(n.textContent).toBe(reference.label);expect(n.getAttribute('aria-label')).toContain(reference.reference)
  expect(n.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(id));expect(n.querySelector('svg')?.getAttribute('width')).toBe('12');expect(n.querySelector('svg')?.style.pointerEvents).toBe('none')
 }
 const range=document.createRange();range.setStart(editor.querySelector('p')!.firstChild!,0);range.setEnd(editor.querySelector('p')!.firstChild!,7);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range)
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.nodeview-references';custom.name='Original references';custom.icons=Object.fromEntries(references.map(r=>[`conversation.reference-${r.kind}`,{kind:'paths' as const,paths:[{d:'M4 4H20V20H4Z'}]}]))
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(host.querySelector('[role=textbox]')).toBe(editor);expect(document.getSelection()!.toString()).toBe('Unsaved');expect(changed).not.toHaveBeenCalled();expect(activated).not.toHaveBeenCalled()
 for(const[n,index]of nodes.map((n,index)=>[n,index] as const)){const reference=references[index]!;expect(editor.querySelector(`[data-tool-reference="${reference.kind}"]`)).toBe(n);expect(document.getElementById(semanticIconHref(`conversation.reference-${reference.kind}`).slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');await act(async()=>n.click());if(reference.kind!=='subcommand')expect(activated).toHaveBeenLastCalledWith(expect.objectContaining({kind:reference.kind,reference:reference.reference,label:reference.label}))}
 expect(activated).toHaveBeenCalledTimes(3);expect(changed).toHaveBeenLastCalledWith(expect.stringContaining('Expanded original authored prompt'));expect(changed.mock.calls.at(-1)?.[0]).toContain(encodeSemanticReference(references[0]!))
})
