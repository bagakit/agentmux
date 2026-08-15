import { describe, expect, it } from 'vitest'
import type { GitFileDiff } from '../src/shared/git-contracts.js'
import { diffEditorSides, wordWrapOption } from '../src/renderer/src/lib/editor-diff.js'

// This is the one place a single-file diff's directionality is decided, and getting it wrong is worse
// than showing no diff: a diff whose two sides both came from the worktree always reads as "no changes"
// while looking like it works. So these tests pin `original` to the OLD (HEAD) side and `modified` to
// the NEW (worktree) side by their exact bytes — swap them in the implementation and the first test
// reddens; source both sides from the same side and the "always-empty diff" test reddens.

function modified(oldText: string, newText: string): GitFileDiff {
  return {
    path: 'src/app.ts',
    old: { present: true, binary: false, text: oldText },
    new: { present: true, binary: false, text: newText },
    binary: false,
    change: 'modified'
  }
}

describe('diffEditorSides directionality', () => {
  it('maps old→original (HEAD, left) and new→modified (worktree, right) by exact text', () => {
    const sides = diffEditorSides(modified('const a = 1', 'const a = 2'))
    // Pinned to the concrete sides, not to "they differ": if the two are swapped, the left would carry
    // the worktree text and the right the HEAD text — these literal checks catch exactly that swap.
    expect(sides.original).toBe('const a = 1')
    expect(sides.modified).toBe('const a = 2')
  })

  it('never shows an always-empty diff: the two sides come from different git versions', () => {
    // The defect this function exists to make impossible: both sides sourced from the worktree. If the
    // implementation ever read `diff.new` (or `diff.old`) for BOTH sides, a genuinely-changed file would
    // render identical text on both sides — a diff that is silently, permanently empty.
    const sides = diffEditorSides(modified('was here before', 'is here now'))
    expect(sides.original).not.toBe(sides.modified)
    expect(sides.original).toBe('was here before')
    expect(sides.modified).toBe('is here now')
  })

  it('draws an added file as an insertion: absent old side becomes empty original', () => {
    const added: GitFileDiff = {
      path: 'src/new.ts',
      old: { present: false },
      new: { present: true, binary: false, text: 'brand new file' },
      binary: false,
      change: 'added'
    }
    const sides = diffEditorSides(added)
    expect(sides.original).toBe('')
    expect(sides.modified).toBe('brand new file')
  })

  it('draws a deleted file as a deletion: absent new side becomes empty modified', () => {
    const deleted: GitFileDiff = {
      path: 'src/gone.ts',
      old: { present: true, binary: false, text: 'about to go' },
      new: { present: false },
      binary: false,
      change: 'deleted'
    }
    const sides = diffEditorSides(deleted)
    expect(sides.original).toBe('about to go')
    expect(sides.modified).toBe('')
  })

  it('reports binary so the caller shows a placeholder rather than two empty strings', () => {
    const binary: GitFileDiff = {
      path: 'assets/logo.png',
      old: { present: true, binary: true },
      new: { present: true, binary: true },
      binary: true,
      change: 'modified'
    }
    const sides = diffEditorSides(binary)
    expect(sides.binary).toBe(true)
    // A binary side carries no text; both sides being '' is exactly why the caller must branch on
    // `binary` instead of feeding these to the diff (which would read as "no changes").
    expect(sides.original).toBe('')
    expect(sides.modified).toBe('')
  })
})

describe('wordWrapOption', () => {
  it('maps the toggle bit to Monaco\'s enum in exactly one place', () => {
    // If this ever returned a constant, the toggle would be a no-op with wrap stuck on one setting.
    expect(wordWrapOption(true)).toBe('on')
    expect(wordWrapOption(false)).toBe('off')
  })
})
