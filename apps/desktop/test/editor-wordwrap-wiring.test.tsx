import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorPaneStoreState } from './helpers/editor-pane-store.js'

// Two things this proves, neither reachable by source-text grep:
//   1. The Alt+Z command EditorPane registers is really wired to toggleEditorWordWrap — running the
//      captured handler flips the store bit. Delete the registration (or point it at the wrong action)
//      and the "pressing Alt+Z toggles" test reddens.
//   2. Monaco receives `wordWrap` derived from the live bit, not the frozen `'off'` it used to hardcode.
//      We capture the options EditorPane passes and assert they follow the bit both ways; hardcode it
//      back to a constant and the "reflects the state bit" test reddens.
//
// The base state comes from the shared editorPaneStoreState() helper (the same one the store-fixture
// detector guards against EditorPane's real reads), so a future slice EditorPane starts reading does
// not silently red this file with a render-time TypeError far from its cause.

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

const monacoSpy = vi.hoisted(() => ({
  commands: [] as Array<{ keybinding: number; handler: () => void }>,
  lastOptions: null as Record<string, unknown> | null
}))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  // Monaco 的常量取自共享 helper（真值，附来源）而不是在这里手抄：EditorPane 每加一个注册，手抄的那份
  // 就少一个常量，而缺常量会让注册**抛**，把红打在与被测接线无关的地方。
  const { monacoKeybindingConstants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({
      onMount,
      options
    }: {
      onMount?: (editor: unknown, monaco: unknown) => void
      options?: Record<string, unknown>
    }) => {
      monacoSpy.lastOptions = options ?? null
      const editor = {
        addCommand: (keybinding: number, handler: () => void) => {
          monacoSpy.commands.push({ keybinding, handler })
        },
        addAction: vi.fn(),
        createContextKey: vi.fn(() => ({ set: vi.fn() })),
        onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        revealLineInCenter: vi.fn(),
        setPosition: vi.fn(),
        focus: vi.fn()
      }
      onMount?.(editor, monacoKeybindingConstants())
      return null
    },
    DiffEditor: () => null
  }
})

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { files: { reveal: vi.fn(async () => {}) } }
}))

import { EditorPane } from '../src/renderer/src/components/EditorPane.js'

const WORKSPACE = 'workspace'
const PATH = 'src/app.ts'
const KEY = `${WORKSPACE}\0${PATH}`
// KeyMod.Alt (512) | KeyCode.KeyZ (56) — the registry's editor.toggle-word-wrap chord in Monaco bits.
const ALT_Z = 512 | 56

const toggleSpy = vi.fn()

beforeEach(() => {
  // Start from the shared base shape, then override just the slices this test drives.
  fixture.state = { ...editorPaneStoreState(), editorWordWrap: false, toggleEditorWordWrap: toggleSpy }
})

function mount(): void {
  fixture.state.documents = { [KEY]: { path: PATH, content: 'hello', revision: 'r1' } }
  renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: 'region', kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
}

function pressWordWrap(): void {
  const command = monacoSpy.commands.find((entry) => entry.keybinding === ALT_Z)
  if (!command) throw new Error('Alt+Z (word wrap) was never registered')
  command.handler()
}

afterEach(() => {
  monacoSpy.commands = []
  monacoSpy.lastOptions = null
  toggleSpy.mockClear()
})

describe('editor word-wrap wiring', () => {
  it('registers Alt+Z, not some other chord', () => {
    mount()
    expect(monacoSpy.commands.map((entry) => entry.keybinding)).toContain(ALT_Z)
  })

  it('pressing Alt+Z toggles the store bit — deleting the registration reddens this', () => {
    mount()
    pressWordWrap()
    expect(toggleSpy).toHaveBeenCalledTimes(1)
  })

  it('Monaco gets wordWrap off when the bit is off', () => {
    fixture.state.editorWordWrap = false
    mount()
    expect(monacoSpy.lastOptions?.wordWrap).toBe('off')
  })

  it('Monaco gets wordWrap on when the bit is on — hardcoding it back to a constant reddens this', () => {
    fixture.state.editorWordWrap = true
    mount()
    expect(monacoSpy.lastOptions?.wordWrap).toBe('on')
  })
})
