import { describe, expect, it } from 'vitest'
import { workspaceFileFormat, workspaceFilePreviewFormat } from '../src/catalog'
import { detectLanguage } from '../../../apps/desktop/src/renderer/src/lib/language-detect'
import { effectiveFileRegionMode, fileSupportsInlinePreview } from '../../../apps/desktop/src/renderer/src/lib/file-region-presentation'

describe('independent extension consumers', () => {
  it('packaged capabilities reach existing File and language consumers', () => {
    expect(fileSupportsInlinePreview('architecture.mmd')).toBe(true)
    expect(detectLanguage('architecture.mmd')).toBe('mermaid')
    expect(effectiveFileRegionMode({}, 'original-region', 'audio.flac')).toBe('preview')
    expect(effectiveFileRegionMode({}, 'original-region', 'notes.note.md')).toBe('preview')
    expect(workspaceFileFormat('notes.note.md').sourcePreview).toBe('note')
    expect(workspaceFileFormat('regular.json').formatter).toBe('prettier')
    expect(workspaceFilePreviewFormat('page.PDF')?.kind).toBe('pdf')
    expect(workspaceFilePreviewFormat('unknown.binary')).toBeNull()
  })
})
