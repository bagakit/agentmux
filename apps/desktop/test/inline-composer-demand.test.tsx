// @vitest-environment happy-dom
import { act, createRef, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { InlineComposer } from '@agentmux/client-ui/components/InlineComposer'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { expect, it, vi } from 'vitest'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const dom = composerDOM()
type EditorElement = HTMLElement & { editor: Editor }
function editor(): EditorElement {
  const element = dom.container.querySelector<EditorElement>('.ProseMirror')
  expect(element).not.toBeNull()
  expect(element!.editor).toBeDefined()
  return element!
}
function ControlledInline({ active, insertion, historyNavigation }: {
  active?: boolean; insertion?: RefObject<ComposerInsertionHandle | null>; historyNavigation?: 'browsing' | 'restored'
}) {
  const value = useAppStore(state => state.agentComposerDrafts['agent-1'] ?? '')
  return <InlineComposer {...(active === undefined ? {} : { active })} {...(insertion ? { insertionRef: insertion } : {})}
    {...(historyNavigation ? { historyNavigation } : {})} value={value}
    onValueChange={next => useAppStore.getState().setAgentComposerDraft('agent-1', next)}
    disabled={false} placeholder="Message" aria-label="Message" onKeyDown={() => {}} />
}

it('the real Desktop Session adapter defers unseen editors and hydrates the latest saved draft on first presentation', async () => {
  const additions = vi.spyOn(document, 'addEventListener')
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  expect(dom.container.querySelectorAll('.ProseMirror')).toHaveLength(0)
  expect(additions.mock.calls.filter(([type]) => type === 'selectionchange')).toHaveLength(0)
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', 'Fresh unseen draft'))
  expect(dom.container.querySelectorAll('.ProseMirror')).toHaveLength(0)
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible />)
  const original = editor()
  expect(original.textContent).toBe('Fresh unseen draft')
  await act(async () => original.editor.commands.insertContent(' typed'))
  expect(dom.draft()).toContain(' typed')
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', 'Updated visited draft'))
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible />)
  expect(editor()).toBe(original)
  expect(original.textContent).toBe('Updated visited draft')
  expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('run-agent-1')
})

it('an unselected visible or disabled Session still owns its first editor; activity is not input authorization', async () => {
  useAppStore.setState({ workbenchSpaceSelection: null, sessions: [composerSession()] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible disabled />)
  expect(editor().editor.isEditable).toBe(false)
  expect(editor().textContent).toBe('Keep my draft')
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible />)
  expect(editor().editor.isEditable).toBe(true)
})

it('the Launcher passes actual presentation demand and keeps its first editor after hiding', async () => {
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', {
    regionId: 'region', kind: 'launcher', workspaceId: 'workspace'
  }) }, activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Original Launcher draft' },
  prewarmTerminal: vi.fn(async () => {}), detectExecutors: vi.fn(async () => {}) })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  expect(dom.container.querySelectorAll('.ProseMirror')).toHaveLength(0)
  await act(async () => useAppStore.getState().setAgentComposerDraft('region', 'Latest Launcher draft'))
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />)
  const original = editor()
  expect(original.textContent).toBe('Latest Launcher draft')
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  expect(editor()).toBe(original)
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />)
  expect(editor()).toBe(original)
})

it('shared callers keep default eager behavior and unseen insertion reports its exact unavailable editor without consuming work', async () => {
  const insertion = createRef<ComposerInsertionHandle>()
  await dom.render(<ControlledInline insertion={insertion} />)
  expect(editor().textContent).toBe('Keep my draft')
  await dom.render(null)
  await dom.render(<ControlledInline active={false} insertion={insertion} />)
  const resolve = vi.fn(async () => 'Attachment')
  const outcome = await insertion.current!.insert(resolve).then(() => null, error => error.code)
  expect(outcome).toBe('COMPOSER_EDITOR_UNAVAILABLE')
  expect(() => insertion.current!.replace('Replacement')).toThrow('The saved draft was not changed')
  expect(resolve).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
  expect(dom.container.querySelectorAll('.ProseMirror')).toHaveLength(0)
  await dom.render(<ControlledInline active insertion={insertion} />)
  await act(async () => insertion.current!.insert(resolve))
  expect(resolve).toHaveBeenCalledOnce()
  expect(dom.draft()).toContain('Attachment')
  await dom.render(<AgentComposer value="Default shared input" onChange={() => {}} disabled={false} placeholder="Message" />)
  expect(editor().textContent).toBe('Default shared input')
})

it('an attachment in flight keeps its original bookmark and editor through hidden edits', async () => {
  const insertion = createRef<ComposerInsertionHandle>()
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', 'abcd'))
  await dom.render(<ControlledInline active insertion={insertion} />)
  const original = editor(), maintained = original.editor
  let finish!: (value: string) => void
  const attachment = new Promise<string>(resolve => { finish = resolve })
  let pending!: Promise<void>
  await act(async () => {
    maintained.commands.setTextSelection(3)
    pending = insertion.current!.insert(() => attachment)
    maintained.commands.insertContent('X')
  })
  await dom.render(<ControlledInline active={false} insertion={insertion} />)
  expect(editor()).toBe(original)
  await act(async () => { finish('attachment'); await pending })
  expect(dom.draft()).toBe('abXattachmentcd')
  await dom.render(<ControlledInline active insertion={insertion} />)
  expect(editor()).toBe(original)
  expect(original.editor).toBe(maintained)
  expect(original.textContent).toBe('abXattachmentcd')
})

it('hidden presentation preserves selection and the original draft undo across temporary history browsing', async () => {
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', ''))
  await dom.render(<ControlledInline active />)
  const original = editor(), maintained = original.editor
  await act(async () => { maintained.commands.insertContent('typed draft'); maintained.commands.setTextSelection({ from: 2, to: 6 }) })
  await dom.render(<ControlledInline active={false} />)
  expect(editor()).toBe(original)
  expect([maintained.state.selection.from, maintained.state.selection.to]).toEqual([2, 6])
  await act(async () => {
    useAppStore.getState().setAgentComposerDraft('agent-1', 'History preview')
    await dom.render(<ControlledInline active={false} historyNavigation="browsing" />)
  })
  await act(async () => {
    useAppStore.getState().setAgentComposerDraft('agent-1', 'typed draft')
    await dom.render(<ControlledInline active historyNavigation="restored" />)
  })
  expect(editor()).toBe(original)
  expect(original.editor).toBe(maintained)
  await act(async () => { expect(maintained.commands.undo()).toBe(true) })
  expect(dom.draft()).toBe('')
})

it.each(['current', 'cancelled', 'other-region'] as const)('first presentation consumes only its still-current exact caret intent: %s', async intent => {
  const outside = document.createElement('button'); document.body.append(outside)
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 40))
  const scene = (visible: boolean) => <section data-workbench-region-id="target-region" hidden={!visible} inert={!visible}>
    <AgentSessionComposer sessionId="agent-1" visible={visible} />
  </section>
  try {
    outside.focus()
    useAppStore.setState({ regionCaretFocus: { regionId: 'target-region', nonce: 91 } })
    await dom.render(scene(false))
    expect(dom.container.querySelectorAll('.ProseMirror')).toHaveLength(0)
    expect(useAppStore.getState().regionCaretFocus?.nonce).toBe(91)
    if (intent !== 'current') useAppStore.setState({ regionCaretFocus: intent === 'cancelled' ? null : { regionId: 'another-region', nonce: 92 } })
    await dom.render(scene(true))
    const original = editor()
    if (intent === 'current') {
      await vi.waitFor(() => expect(document.activeElement).toBe(original))
      expect(useAppStore.getState().regionCaretFocus).toBeNull()
    } else {
      expect(document.activeElement).toBe(outside)
      expect(useAppStore.getState().regionCaretFocus).toEqual(intent === 'cancelled' ? null : { regionId: 'another-region', nonce: 92 })
    }
  } finally { geometry.mockRestore(); outside.remove() }
})
