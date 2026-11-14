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
 const editor = host.querySelector<HTMLElement>('[role=textbox]')!
 const controls = references.map(reference => {
   const node = editor.querySelector<HTMLElement>(`[data-tool-reference="${reference.kind}"]`)!
   const id = `conversation.reference-${reference.kind}` as const
   expect(node, 'actual nonempty reference NodeView').not.toBeNull()
   const button = node.closest('button') ?? node.querySelector<HTMLButtonElement>('button[aria-expanded]')!
   expect(button).toBeInstanceOf(HTMLButtonElement)
   expect(button.textContent).toBe(reference.label)
   expect(button.getAttribute('aria-label') ?? '').toContain(reference.reference)
   expect(button.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(id))
   expect(button.querySelector('svg')?.getAttribute('width')).toBe('12')
   expect(button.querySelector('svg')?.style.pointerEvents).toBe('none')
   return { reference, node, button, id }
 })
 const draftPrefix = editor.querySelector('p')!.firstChild!
 const range = document.createRange()
 range.setStart(draftPrefix, 0)
 range.setEnd(draftPrefix, 7)
 document.getSelection()!.removeAllRanges()
 document.getSelection()!.addRange(range)
 const custom = structuredClone(GRAPHITE_THEME)
 custom.id = 'custom.nodeview-references'
 custom.name = 'Original references'
 custom.icons = Object.fromEntries(controls.map(({ id }) => [id, { kind: 'paths' as const, paths: [{ d: 'M4 4H20V20H4Z' }] }]))
 await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
 expect(host.querySelector('[role=textbox]')).toBe(editor)
 expect(document.getSelection()!.toString()).toBe('Unsaved')
 expect(changed).not.toHaveBeenCalled()
 expect(activated).not.toHaveBeenCalled()
 for (const { reference, node, button, id } of controls) {
   expect(editor.querySelector(`[data-tool-reference="${reference.kind}"]`)).toBe(node)
   expect(node.contains(button)).toBe(true)
   expect(document.getElementById(semanticIconHref(id).slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
   const actionsBefore = activated.mock.calls.length
   await act(async () => button.click())
   if (reference.kind === 'file') {
     expect(activated).toHaveBeenCalledTimes(actionsBefore)
     expect(button.getAttribute('aria-expanded')).toBe('true')
     const disclosure = document.getElementById(button.getAttribute('aria-controls')!)!
     expect(disclosure.querySelector('code')?.textContent).toBe(reference.reference)
     const open = disclosure.querySelector('button')!
     expect(open.textContent).toBe('Open file')
     await act(async () => open.click())
   }
   if (reference.kind !== 'subcommand') {
     expect(activated).toHaveBeenCalledTimes(actionsBefore + 1)
     const { kind, reference: target, label } = reference
     expect(activated).toHaveBeenLastCalledWith(expect.objectContaining({ kind, reference: target, label }))
   }
 }
 expect(activated).toHaveBeenCalledTimes(3)
 expect(changed).toHaveBeenLastCalledWith(expect.stringContaining('Expanded original authored prompt'))
 expect(changed.mock.calls.at(-1)?.[0]).toContain(encodeSemanticReference(references[0]!))
})
