import { describe, expect, it } from 'vitest'
import { parseOptions } from '../scripts/capture-settings-evaluation.mjs'
import { presentationIssues, selectSections, validateCapture } from '../scripts/fixtures/settings-evaluation/analysis.mjs'

const registered = [{ id: 'profile', archetype: 'preference' }, { id: 'hosts', archetype: 'console' }, { id: 'prompts', archetype: 'library' }, { id: 'inapp', archetype: 'reference' }]
const viewport = { width: 1280, height: 860 }, variants = [{ mode: 'dark', ...viewport }]
const facts = { firstControl: { top: 40, name: 'Name' }, clientHeight: 600, introductionHeight: 100, introductions: [],
  smallBody: [], bodyFontSizes: [12, 13], bodyToken: 12, cjk: [], jargon: [], saveBars: [], textLength: 100, overflowX: false }

describe('Settings presentation capture boundaries', () => {
  it('never replaces a missing contribution, unknown selection or empty capture with a passing result', () => {
    expect(() => selectSections([], undefined)).toThrow('nonempty')
    expect(() => selectSections([{ id: 'missing' }], undefined)).toThrow('archetype')
    expect(() => selectSections(registered, ['unknown'])).toThrow('Unknown Settings section')
    expect(() => selectSections(registered, [])).toThrow('at least one')
    expect(() => selectSections(registered, ['profile', 'profile'])).toThrow('unique')
    expect(() => validateCapture({ rows: [] }, registered, variants)).toThrow('no Settings measurements')
    const rows = registered.map(section => ({ section: section.id, mode: 'dark', viewport, status: 'measured', facts }))
    expect(() => validateCapture({ rows }, registered, variants)).not.toThrow()
    expect(() => validateCapture({ rows: rows.slice(1) }, registered, variants)).toThrow('Expected 4')
    expect(() => validateCapture({ rows: [...rows.slice(1), rows[1]] }, registered, variants)).toThrow('Missing, duplicated or failed')
    expect(() => validateCapture({ rows: rows.map(row => row.section === 'hosts' ? { ...row, status: 'render-failed' } : row) }, registered, variants)).toThrow('hosts')
    expect(() => validateCapture({ rows: rows.map(row => ({ ...row, facts: { ...row.facts, jargon: undefined } })) }, registered, variants)).toThrow('Incomplete Renderer metrics')
  })

  it('keeps native-state unavailability visible while validating only actual rendered presentation', () => {
    const rows = [{ section: 'hosts', mode: 'dark', viewport, status: 'state-unavailable', stateUnavailable: 'The real Host is not connected.', facts }]
    expect(() => validateCapture({ rows }, [registered[1]], variants)).not.toThrow()
    expect(rows[0].status).toBe('state-unavailable')
    expect(presentationIssues(registered[1], facts, viewport)).toEqual([])
  })

  it('uses the Settings SSOT bounds only for their applicable archetypes and viewport', () => {
    const late = { ...facts, firstControl: { top: 201 }, introductionHeight: 161 }
    expect(presentationIssues(registered[0], late, viewport).map(issue => issue.dimension)).toEqual(['first-screen', 'first-screen'])
    expect(presentationIssues(registered[1], late, viewport).map(issue => issue.dimension)).toEqual(['first-screen', 'first-screen'])
    expect(presentationIssues(registered[2], late, viewport)).toEqual([])
    expect(presentationIssues(registered[3], { ...late, firstControl: null }, viewport)).toEqual([])
    expect(presentationIssues(registered[0], late, { width: 640, height: 860 })).toEqual([])
    expect(presentationIssues(registered[0], { ...facts, firstControl: { top: 200 }, introductionHeight: 160 }, viewport)).toEqual([])
  })

  it('reports each measured typography, language, wording and overflow defect independently', () => {
    const issues = presentationIssues(registered[0], { ...facts, smallBody: [{ size: 10, text: 'A full explanatory paragraph.' }],
      bodyFontSizes: [10, 11, 12, 13, 14], cjk: [{ text: '中文' }], jargon: [{ text: 'The Core owner.' }], overflowX: true }, viewport)
    expect(issues.map(issue => issue.dimension)).toEqual(['first-screen', 'type', 'type', 'language', 'jargon'])
  })

  it('rejects misspelled or malformed command inputs before starting Electron', () => {
    for (const args of [['--assert', 'typo'], ['--sections'], ['--typo'], ['--sizes', '0x860'], ['--sizes', 'wide'], ['--modes', 'blue']]) expect(() => parseOptions(args)).toThrow()
    expect(parseOptions(['--check-schema', '--assert', 'language,jargon', '--sections', 'profile,appearance', '--modes', 'dark,light', '--sizes', '1280x860,640x860']))
      .toMatchObject({ assertions: ['language', 'jargon'], sections: ['profile', 'appearance'], modes: ['dark', 'light'], sizes: [[1280, 860], [640, 860]] })
  })
})
