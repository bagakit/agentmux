import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitFileDiff } from '../src/shared/contracts.js'
import { editorPaneStoreState } from './helpers/editor-pane-store.js'

// The core guard for the diff feature: when a file Region is in diff mode, EditorPane must render
// Monaco's DiffEditor with the sides pointed the right way — NOT fall back to the plain editable Editor,
// and NOT feed both diff sides from the same git version. Both failures look fine on screen:
//   - falling back to the plain Editor shows the worktree file and silently loses "this is a diff";
//   - both sides from the worktree renders a genuinely-changed file as "no changes".
// We stub both Monaco components to record which one mounted and with what props, so a fallback or a
// swapped side is a red test, not a silent visual regression. The base store shape comes from the
// shared editorPaneStoreState() helper so a future slice does not silently red this file.

const mounted = vi.hoisted(() => ({
  plain: 0,
  diff: [] as Array<{ original: unknown; modified: unknown }>
}))

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  // Monaco 的常量取自共享 helper（真值，附来源）而不是在这里手抄：EditorPane 每加一个注册，手抄的那份
  // 就少一个常量，而缺常量会让注册**抛**，把红打在与被测接线无关的地方。
  const { monacoKeybindingConstants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      mounted.plain += 1
      const editor = {
        addCommand: vi.fn(),
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
    DiffEditor: ({ original, modified }: { original?: unknown; modified?: unknown }) => {
      mounted.diff.push({ original, modified })
      return null
    }
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
const REGION = 'region'

function modifiedDiff(oldText: string, newText: string): GitFileDiff {
  return {
    path: PATH,
    old: { present: true, binary: false, text: oldText },
    new: { present: true, binary: false, text: newText },
    binary: false,
    change: 'modified'
  }
}

function renderMarkup(): string {
  fixture.state.documents = { [KEY]: { path: PATH, content: 'worktree content', revision: 'r1' } }
  return renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: REGION, kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
}

beforeEach(() => {
  fixture.state = { ...editorPaneStoreState() }
})

afterEach(() => {
  mounted.plain = 0
  mounted.diff = []
})

describe('editor diff-mode render wiring', () => {
  it('edit mode renders the plain Editor, never the DiffEditor', () => {
    fixture.state.editorRegionModes = {} // defaults to 'edit'
    renderMarkup()
    expect(mounted.plain).toBe(1)
    expect(mounted.diff).toHaveLength(0)
  })

  it('diff mode renders the DiffEditor and does NOT fall back to the plain Editor', () => {
    // The core judgment: a Region in diff mode with a loaded diff must mount DiffEditor. If the branch
    // ever fell through to <Editor>, this reddens on the plain count — the exact "diff silently becomes
    // a plain editor" regression.
    fixture.state.editorRegionModes = { [REGION]: 'diff' }
    fixture.state.editorRegionDiffs = {
      [REGION]: { loading: false, diff: modifiedDiff('const a = 1', 'const a = 2'), error: null }
    }
    renderMarkup()
    expect(mounted.diff).toHaveLength(1)
    expect(mounted.plain).toBe(0)
  })

  it('feeds the DiffEditor old→original, new→modified — swapping the sides reddens this', () => {
    fixture.state.editorRegionModes = { [REGION]: 'diff' }
    fixture.state.editorRegionDiffs = {
      [REGION]: { loading: false, diff: modifiedDiff('was here before', 'is here now'), error: null }
    }
    renderMarkup()
    expect(mounted.diff[0]?.original).toBe('was here before')
    expect(mounted.diff[0]?.modified).toBe('is here now')
    // And never the always-empty diff: the two sides must not be the same text.
    expect(mounted.diff[0]?.original).not.toBe(mounted.diff[0]?.modified)
  })

  it('a binary diff shows a placeholder, not a DiffEditor fed two empty strings', () => {
    fixture.state.editorRegionModes = { [REGION]: 'diff' }
    fixture.state.editorRegionDiffs = {
      [REGION]: {
        loading: false,
        diff: { path: PATH, old: { present: true, binary: true }, new: { present: true, binary: true }, binary: true, change: 'modified' },
        error: null
      }
    }
    const markup = renderMarkup()
    expect(mounted.diff).toHaveLength(0)
    expect(mounted.plain).toBe(0)
    expect(markup).toContain('Binary file')
  })

  it('a diff load error shows the message, not a blank DiffEditor', () => {
    fixture.state.editorRegionModes = { [REGION]: 'diff' }
    fixture.state.editorRegionDiffs = {
      [REGION]: { loading: false, diff: null, error: 'fatal: not a git repository' }
    }
    const markup = renderMarkup()
    expect(mounted.diff).toHaveLength(0)
    expect(markup).toContain('fatal: not a git repository')
  })
})
