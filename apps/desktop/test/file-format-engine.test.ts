import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { formatFileContent } from '../src/renderer/src/lib/file-formats/format-engine'

describe('real source format engines', () => {
  it('loads real Prettier plugins for script, markup, style, Markdown and YAML', async () => {
    const fixtures = [
      ['test.js', 'const x={a:1}', 'const x = { a: 1 };'],
      ['test.ts', 'const x:number=1', 'const x: number = 1;'],
      ['test.jsonc', '{// comment\n"value":1}', '// comment'],
      ['test.html', '<main><p>hello</p></main>', '<p>hello</p>'],
      ['test.css', '.x{color:red}', 'color: red;'],
      ['test.md', '#   Heading', '# Heading'],
      ['test.yaml', 'value: [1,2]', 'value: [1, 2]']
    ] as const
    for (const [path, source, expected] of fixtures) {
      const formatted = await formatFileContent(path, source)
      expect(formatted, path).toContain(expected)
      expect(await formatFileContent(path, formatted), path).toBe(formatted)
    }
    await expect(formatFileContent('bad.ts', 'const =')).rejects.toThrow()
    await expect(formatFileContent('data.toml', 'a=1')).rejects.toThrow('source-preserving')
  })
  it('keeps JSONL physical records, lexical big integers and fails at the exact invalid line', async () => {
    const formatted = await formatFileContent('data.jsonl', '{"id":90071992547409931234,"items":[1,2]}\r\n{"ok":true}\r\n')
    expect(formatted).toContain('90071992547409931234')
    expect(formatted.split('\r\n')).toHaveLength(3)
    expect(formatted.endsWith('\r\n')).toBe(true)
    expect(formatted).toMatch(/"items": \[\s*1, 2\s*\]/)
    await expect(formatFileContent('data.ndjson', '{}\n{broken}\n')).rejects.toThrow('line 2')
    await expect(formatFileContent('data.jsonl', '{}\n\n{}')).rejects.toThrow('line 2')
  })
  it('normalizes CSV/TSV without converting strings, losing quotes/newlines or changing records', async () => {
    for (const [path, delimiter, source] of [
      ['data.csv', ',', 'id,value\r\n001,"two\nlines"\r\n"",true\r\n'],
      ['data.csv', ';', 'id;value\n001;"a;b"\n'],
      ['data.tsv', '\t', 'id\tvalue\n001\t"a\tb"\n']
    ]) {
      const formatted = await formatFileContent(path!, source!)
      const rows = (value: string) => Papa.parse(value, { delimiter: delimiter!, dynamicTyping: false, skipEmptyLines: false }).data
      expect(rows(formatted)).toEqual(rows(source!))
      expect(formatted).toContain('001')
      expect(await formatFileContent(path!, formatted)).toBe(formatted)
    }
    await expect(formatFileContent('bad.csv', 'a,b\n"unterminated')).rejects.toThrow()
  })
})
