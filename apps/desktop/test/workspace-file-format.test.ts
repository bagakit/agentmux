import { describe, expect, it } from 'vitest'
import { workspaceFileFormat } from '../src/shared/workspace-file-format'
import { detectLanguage } from '../src/renderer/src/lib/language-detect'

describe('lightweight File format capabilities', () => {
  it.each([
    ['PAGE.HTM', 'html', 'text/html', 'html'],
    ['a.jsonc', 'json', 'application/json', 'json'],
    ['a.csv', 'csv', 'text/csv', 'plaintext'],
    ['a.tsv', 'tsv', 'text/tab-separated-values', 'plaintext'],
    ['a.markdown', 'markdown', 'text/markdown', 'markdown'],
    ['a.svg', 'svg', 'image/svg+xml', 'xml'],
    ['draft.note.json', 'note', 'application/json', 'json']
  ])('declares %s without parsing source', (path, sourcePreview, mime, language) => {
    expect(workspaceFileFormat(path)).toMatchObject({ sourcePreview, mime, language, sourceEditable: true })
    expect(detectLanguage(path)).toBe(language)
  })
  it('retains media ownership and source defaults', () => {
    expect(workspaceFileFormat('photo.PNG')).toMatchObject({ sourcePreview: null, sourceEditable: false, defaultMode: 'preview', mime: 'image/png' })
    expect(workspaceFileFormat('a.svg').defaultMode).toBe('preview')
    expect(workspaceFileFormat('a.html')).toMatchObject({ defaultMode: 'edit', browserPreview: true, previewConfirmation: 'renderer' })
    expect(workspaceFileFormat('unknown.ts')).toMatchObject({ sourcePreview: null, sourceEditable: true, defaultMode: 'edit' })
    expect(detectLanguage('unknown.ts')).toBe('typescript')
  })
})
