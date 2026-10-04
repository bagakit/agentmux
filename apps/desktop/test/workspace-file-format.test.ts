import { describe, expect, it } from 'vitest'
import { workspaceFileFormat } from '../src/shared/workspace-file-format'
import { detectLanguage } from '../src/renderer/src/lib/language-detect'

describe('lightweight File format capabilities', () => {
  it.each([
    ['PAGE.HTM', 'html', 'text/html', 'html'],
    ['a.jsonc', 'json', 'application/json', 'json'],
    ['a.csv', 'csv', 'text/csv', 'csv'],
    ['a.tsv', 'tsv', 'text/tab-separated-values', 'tsv'],
    ['a.ndjson', 'jsonl', 'application/x-ndjson', 'jsonl'],
    ['a.yaml', 'yaml', 'application/yaml', 'yaml'],
    ['a.toml', 'toml', 'application/toml', 'toml'],
    ['a.mmd', 'mermaid', 'text/plain', 'mermaid'],
    ['a.dot', 'dot', 'text/vnd.graphviz', 'dot'],
    ['a.drawio', 'drawio', 'application/xml', 'xml'],
    ['a.puml', 'plantuml', 'text/plain', 'plantuml'],
    ['a.excalidraw', 'excalidraw', 'application/json', 'json'],
    ['a.vega.json', 'vega', 'application/json', 'json'],
    ['a.vl.json', 'vega-lite', 'application/json', 'json'],
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
  it('declares exact formatting and explicit build capabilities without loading engines', () => {
    for (const path of ['a.tsx', 'a.html', 'a.yaml']) expect(workspaceFileFormat(path).formatter).toBe('prettier')
    expect(workspaceFileFormat('a.ndjson').formatter).toBe('jsonl')
    expect(workspaceFileFormat('a.csv').formatter).toBe('delimited')
    expect(workspaceFileFormat('a.toml').formatter).toBeNull()
    expect(workspaceFileFormat('a.tex')).toMatchObject({ sourcePreview: 'latex', language: 'latex', formatter: null, defaultMode: 'edit' })
    expect(workspaceFileFormat('a.typ')).toMatchObject({ sourcePreview: 'typst', language: 'typst', formatter: null, defaultMode: 'edit' })
  })

})
