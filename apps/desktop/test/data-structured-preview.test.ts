import { fixtureClock as _hygiene_fixtureClock } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { readJsonLines } from '../src/renderer/src/lib/file-formats/data-jsonl'
import { readYamlPreview, readTomlPreview } from '../src/renderer/src/lib/file-formats/data-config'
import { DATA_PREVIEW_MAX_BYTES } from '../src/renderer/src/lib/file-data-preview'

describe('JSON Lines independent records', () => {
  it('keeps good neighbours, exact scalar spelling, physical lines and local error columns', () => {
    const source = '{"id":9223372036854775807}\r\n{"broken":}\r\nfalse\n["a\\nb"]\nnull\n'
    const result = readJsonLines(source)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.records).toHaveLength(5)
    expect(result.records[0]?.node?.children?.[0]?.text).toBe('9223372036854775807')
    expect(result.diagnostics).toMatchObject([{ line: 2, column: 11 }])
    expect(result.records[2]?.node).toEqual({ type: 'boolean', text: 'false' })
    expect(result.records[3]?.node?.children?.[0]?.text).toBe('"a\\nb"')
    expect(result.records[4]?.node?.text).toBe('null')
    expect(source).toContain('9223372036854775807')
  })
  it('diagnoses blank/BOM/comment/trailing-comma records, permits a final line without newline', () => {
    const result = readJsonLines('\uFEFF{}\n\n{"a":1,}\n// no comments\n0')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.diagnostics.map(item => item.line)).toEqual([1, 2, 3, 4])
    expect(result.records[4]?.node?.text).toBe('0')
    expect(readJsonLines('')).toMatchObject({ status: 'ready', records: [] })
  })
  it('bounds input, records and nested models while retaining the source', () => {
    expect(readJsonLines('字'.repeat(DATA_PREVIEW_MAX_BYTES / 2))).toMatchObject({ status: 'too-large' })
    const lines = '0\n'.repeat(5001), result = readJsonLines(lines)
    expect(result).toMatchObject({ status: 'ready', truncated: true })
    if (result.status === 'ready') expect(result.records).toHaveLength(5000)
    expect(lines).toHaveLength(10002)
    expect(JSON.stringify(readJsonLines('['.repeat(100) + '0' + ']'.repeat(100)))).toContain('Use Source')
  })
})

describe('configuration structured readers', () => {
  it('keeps independent YAML documents and errors, source scalar text and aliases without expanding them', () => {
    const result = readYamlPreview('value: 9223372036854775807\nanchor: &self [*self]\n---\nbad: [\n---\ngood: |\n  readable\n')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.records).toHaveLength(3)
    expect(result.records[0]?.node?.children?.[0]?.text).toBe('9223372036854775807')
    expect(JSON.stringify(result.records[0])).toContain('*self (anchor reference)')
    expect(result.records[1]?.diagnostics.length).toBeGreaterThan(0)
    expect(result.records[2]?.node?.children?.[0]?.text).toContain('readable')
  })
  it('reports YAML duplicate/undefined aliases and bounds config inputs', () => {
    const result = readYamlPreview('a: 1\na: 2\n---\na: *missing')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.records[1]?.diagnostics[0]?.message).toContain('Unresolved alias')
    expect(readYamlPreview('a'.repeat(DATA_PREVIEW_MAX_BYTES + 1)).status).toBe('too-large')
    expect(readTomlPreview('a'.repeat(DATA_PREVIEW_MAX_BYTES + 1)).status).toBe('too-large')
  })
  it('preserves TOML integer precision and float type, arrays/tables and literal unsafe own keys', () => {
    const result = readTomlPreview('big = 9223372036854775807\nfloat = 1.0\ninf = inf\n"__proto__" = "safe"\n[[items]]\nname = "first"')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.diagnostics).toEqual([])
    const children = result.records[0]?.node?.children!
    expect(children.find(child => child.label === 'big')).toMatchObject({ type: 'integer', text: '9223372036854775807' })
    expect(children.find(child => child.label === 'float')).toMatchObject({ type: 'float', text: '1.0' })
    expect(children.find(child => child.label === '__proto__')).toMatchObject({ type: 'string', text: '"safe"' })
    expect(children.find(child => child.label === 'items')?.children).toHaveLength(1)
    expect(({} as Record<string, unknown>).safe).toBeUndefined()
  })
  it('has correct TOML error location and never silently uses lossy legacy dates', () => {
    const result = readTomlPreview('ok = true\nbad = [')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.diagnostics[0]?.line).toBe(2)
    const date = readTomlPreview(("time = " + _hygiene_fixtureClock(7, 32, 0, 123456789, 9)))
    expect(date.status).toBe('ready')
    if (date.status !== 'ready') return
    if ('Temporal' in globalThis) expect(date.records[0]?.node?.children?.[0]?.text).toContain('.123456789')
    else expect(date.diagnostics[0]?.message).toContain('Temporal is unavailable')
  })
})
