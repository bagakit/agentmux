import { describe, expect, it } from 'vitest'
import { workspaceFileFormat } from '../src/shared/workspace-file-format'
import { readJsonPreview } from '../src/renderer/src/lib/file-json-preview'
import { readDelimitedPreview } from '../src/renderer/src/lib/file-delimited-preview'
import { fileSupportsInlinePreview } from '../src/renderer/src/lib/file-region-presentation'

describe('shared file capabilities and mature data grammars', () => {
  it('resolves composite Note identity before JSON, and all consumers agree on legal preview modes', () => {
    expect(workspaceFileFormat('knowledge.note.json').sourcePreview).toBe('note')
    expect(workspaceFileFormat('knowledge.note.json').defaultMode).toBe('preview')
    expect(workspaceFileFormat('notes.MDOWN').sourcePreview).toBe('markdown')
    expect(workspaceFileFormat('Windows\\notes.MD').extension).toBe('md')
    for (const path of ['data.json', 'data.jsonc', 'data.csv', 'data.tsv', 'README.md', 'drawing.svg', 'knowledge.note.json']) {
      expect(fileSupportsInlinePreview(path)).toBe(true)
      expect(workspaceFileFormat(path).sourceEditable).toBe(true)
    }
    expect(workspaceFileFormat('photo.png').sourceEditable).toBe(false)
    expect(workspaceFileFormat('movie.webm').defaultMode).toBe('preview')
    expect(fileSupportsInlinePreview('code.ts')).toBe(false)
    expect(workspaceFileFormat('index.HTML').browserPreview).toBe(true)
  })
  it('keeps duplicate keys, source order and exact large-number literals without JS number write-back', () => {
    const content = '{"z":9007199254740993,"z":1e100,"a":false}'
    const result = readJsonPreview(content)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw Error('Expected parsed JSON')
    expect(result.node.children).toHaveLength(3)
    const number = result.node.children![0]!.children![1]!
    expect(content.slice(number.offset, number.offset + number.length)).toBe('9007199254740993')
  })
  it('honors JSONC comments and trailing commas while identifying malformed JSON and bounded source', () => {
    expect(readJsonPreview('{// explanation\n"a":1,}', true).status).toBe('ready')
    expect(readJsonPreview('{// explanation\n"a":1,}').status).toBe('invalid')
    expect(readJsonPreview('{// explanation\n"a":1}').status).toBe('invalid')
    expect(readJsonPreview('{\n"a": }')).toMatchObject({ status: 'invalid', message: expect.stringContaining('line 2') })
    expect(readJsonPreview('"' + '中'.repeat(400_000) + '"').status).toBe('too-large')
  })
  it('preserves CSV quotes, embedded newlines, empty cells and formula-looking text as literal strings', () => {
    expect(readDelimitedPreview('Name,Notes,Value\r\nAda,"quoted, cell\nsecond line",001\r\nBo,,=1+1', ',')).toMatchObject({
      status: 'ready', columns: 3, rows: [['Name', 'Notes', 'Value'], ['Ada', 'quoted, cell\nsecond line', '001'], ['Bo', '', '=1+1']]
    })
    expect(readDelimitedPreview('a\tb\n1\t2', '\t')).toMatchObject({ status: 'ready', rows: [['a', 'b'], ['1', '2']] })
    expect(readDelimitedPreview('a,"unterminated', ',').status).toBe('invalid')
    expect(readDelimitedPreview(Array.from({ length: 5002 }, (_, i) => String(i)).join('\n'), ',')).toMatchObject({ status: 'ready', truncated: true, rows: expect.any(Array) })
  })
})
