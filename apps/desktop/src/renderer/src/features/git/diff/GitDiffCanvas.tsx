import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { GitFileDiff } from '../../../../../shared/git-contracts'

export type GitDiffViewState = { loading: boolean; diff: GitFileDiff | null; error: string | null }
import type { MonacoThemeId } from '../../../lib/monaco-theme'
import { diffEditorSides } from '../../../lib/editor-diff'
import { FullPageLoadingSurface } from '../../../components/FullPageLoadingSurface'
import { ReadonlyDiffEditor } from '../../../components/ReadonlyDiffEditor'

const ThemeStatusWarningIcon = semanticIconComponent('status.warning')


// Shared readonly canvas for worktree and fixed-commit diffs. Main owns the old/new sides; Monaco
// owns diff rendering. Binary or oversized blobs never masquerade as two empty text documents.
export function GitDiffCanvas({
  diff,
  wordWrap,
  language,
  theme
}: {
  diff: GitDiffViewState | undefined
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
        <ThemeStatusWarningIcon size={14} />
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
  return <ReadonlyDiffEditor original={sides.original} modified={sides.modified} wordWrap={wordWrap} language={language} theme={theme} />
}
