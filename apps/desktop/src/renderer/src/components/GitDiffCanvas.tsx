import '../monaco'
import { DiffEditor } from '@monaco-editor/react'
import { AlertTriangle } from 'lucide-react'
import type { EditorRegionDiffState } from '../store'
import type { MonacoThemeId } from '../lib/monaco-theme'
import { diffEditorSides, wordWrapOption } from '../lib/editor-diff'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'

// Shared readonly canvas for worktree and fixed-commit diffs. Main owns the old/new sides; Monaco
// owns diff rendering. Binary or oversized blobs never masquerade as two empty text documents.
export function GitDiffCanvas({
  diff,
  wordWrap,
  language,
  theme
}: {
  diff: EditorRegionDiffState | undefined
  wordWrap: boolean
  language: string
  theme: MonacoThemeId
}) {
  if (!diff || (diff.loading && !diff.diff)) {
    return (
      <FullPageLoadingSurface
        scope="region"
        phase="loading"
        eyebrow="File diff"
        title="Loading diff"
        detail="Reading the two file versions."
      />
    )
  }
  if (diff.error && !diff.diff) {
    return (
      <section className="pane-state pane-state--error">
        <AlertTriangle size={14} />
        <strong>Could not load diff</strong>
        <span>{diff.error}</span>
      </section>
    )
  }
  if (!diff.diff) {
    return (
      <section className="pane-state">
        <span>No diff available.</span>
      </section>
    )
  }
  if (diff.diff.binary) {
    return (
      <section className="pane-state">
        <span>Binary file or too large for textual diff.</span>
      </section>
    )
  }
  const sides = diffEditorSides(diff.diff)
  return (
    <DiffEditor
      original={sides.original}
      modified={sides.modified}
      language={language}
      theme={theme}
      options={{
        readOnly: true,
        // Monaco decides side-by-side vs inline from width; leaving renderSideBySide default lets its own
        // large-diff degradation stand. We only assert the sides are fed correctly, not how it lays out.
        minimap: { enabled: false },
        fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
        fontSize: 14,
        lineHeight: 21,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: wordWrapOption(wordWrap)
      }}
    />
  )
}
