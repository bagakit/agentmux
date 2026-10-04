import { describe, expect, it } from 'vitest'
import {
  caretAtFirstLine,
  caretAtLastLine,
  emptyHistory,
  navigateHistory,
  recordHistory,
  restoreComposerHistory,
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_BYTES
} from '../src/renderer/src/lib/composer-history.js'

describe('recordHistory', () => {
  it('collapses a consecutive duplicate of the newest entry', () => {
    const once = recordHistory(emptyHistory, 'ls')
    const twice = recordHistory(once, 'ls')
    expect(twice.entries).toEqual(['ls'])
  })

  it('keeps a repeat that is NOT consecutive (dup collapse is only vs the newest)', () => {
    let s = recordHistory(emptyHistory, 'ls')
    s = recordHistory(s, 'cd')
    s = recordHistory(s, 'ls')
    expect(s.entries).toEqual(['ls', 'cd', 'ls'])
  })

  it('ignores an empty / whitespace-only prompt, returning state unchanged', () => {
    const seeded = recordHistory(emptyHistory, 'ls')
    expect(recordHistory(seeded, '   \n\t ')).toBe(seeded)
    expect(recordHistory(seeded, '')).toBe(seeded)
  })

  it('resets navigation (cursor to live, stash cleared) on record', () => {
    let s = recordHistory(emptyHistory, 'a')
    s = recordHistory(s, 'b')
    // arrow up to mid-history and stash a draft
    const nav = navigateHistory(s, 'older', 'typed draft')!
    expect(nav.state.stash).toBe('typed draft')
    expect(nav.state.cursor).toBe(1)
    const after = recordHistory(nav.state, 'c')
    expect(after.cursor).toBe(after.entries.length)
    expect(after.stash).toBeNull()
    expect(after.entries).toEqual(['a', 'b', 'c'])
  })
})

describe('navigateHistory', () => {
  function seeded() {
    let s = recordHistory(emptyHistory, 'first')
    s = recordHistory(s, 'second')
    s = recordHistory(s, 'third')
    return s
  }

  it('older from the live draft stashes the draft and shows the newest entry', () => {
    const s = seeded()
    const r = navigateHistory(s, 'older', 'my unsent draft')!
    expect(r.value).toBe('third')
    expect(r.state.cursor).toBe(2)
    expect(r.state.stash).toBe('my unsent draft')
  })

  it('older on empty history returns null (nothing to recall)', () => {
    expect(navigateHistory(emptyHistory, 'older', 'x')).toBeNull()
  })

  it('older at the oldest entry stays put but is HANDLED with the oldest value', () => {
    let s = seeded()
    let r = navigateHistory(s, 'older', 'd')! // -> third
    r = navigateHistory(r.state, 'older', 'd')! // -> second
    r = navigateHistory(r.state, 'older', 'd')! // -> first (oldest)
    const beeped = navigateHistory(r.state, 'older', 'd')!
    expect(beeped).not.toBeNull()
    expect(beeped.value).toBe('first')
    expect(beeped.state).toBe(r.state) // state unchanged at the floor
  })

  it('newer at the live draft returns null (nothing newer)', () => {
    expect(navigateHistory(seeded(), 'newer', 'draft')).toBeNull()
  })

  it('round-trip up-up-down-down restores the ORIGINAL draft exactly', () => {
    const s = seeded()
    const draft = 'half-typed thought'
    const up1 = navigateHistory(s, 'older', draft)! // -> third, stash draft
    expect(up1.value).toBe('third')
    const up2 = navigateHistory(up1.state, 'older', up1.value)! // -> second
    expect(up2.value).toBe('second')
    const down1 = navigateHistory(up2.state, 'newer', up2.value)! // -> third
    expect(down1.value).toBe('third')
    const down2 = navigateHistory(down1.state, 'newer', down1.value)! // -> live, restore draft
    expect(down2.value).toBe(draft)
    expect(down2.state.cursor).toBe(down2.state.entries.length)
    expect(down2.state.stash).toBeNull()
  })

  it('restores an EMPTY original draft as empty, not stale text', () => {
    const s = seeded()
    const up = navigateHistory(s, 'older', '')! // stash '' (blank live draft)
    expect(up.value).toBe('third')
    const down = navigateHistory(up.state, 'newer', up.value)!
    expect(down.value).toBe('') // must be the stashed blank, not the recalled 'third'
  })
})

describe('caret boundary predicates', () => {
  it('single line: caret anywhere is both first and last line', () => {
    expect(caretAtFirstLine('hello', 3)).toBe(true)
    expect(caretAtLastLine('hello', 3)).toBe(true)
  })

  it('caret in the middle line of a 3-line value is neither boundary', () => {
    const v = 'a\nb\nc'
    const caret = v.indexOf('b') // on the middle line
    expect(caretAtFirstLine(v, caret)).toBe(false)
    expect(caretAtLastLine(v, caret)).toBe(false)
  })

  it('caret on the first line of a multiline value: first yes, last no', () => {
    const v = 'top\nmid\nbottom'
    const caret = 1 // inside 'top'
    expect(caretAtFirstLine(v, caret)).toBe(true)
    expect(caretAtLastLine(v, caret)).toBe(false)
  })

  it('caret on the last line of a multiline value: first no, last yes', () => {
    const v = 'top\nmid\nbottom'
    const caret = v.length - 1 // inside 'bottom'
    expect(caretAtFirstLine(v, caret)).toBe(false)
    expect(caretAtLastLine(v, caret)).toBe(true)
  })
})


describe('bounded durable editor history', () => {
  it('retains the last 100 whole bodies with nonconsecutive repeats in original order', () => {
    let state = emptyHistory
    for (let index = 0; index < 101; index++) state = recordHistory(state, 'body-' + index)
    expect(state.entries).toEqual(Array.from({length: MAX_COMPOSER_HISTORY_ENTRIES}, (_, index) => 'body-' + (index + 1)))
    state = recordHistory(state, 'body-99')
    expect(state.entries.slice(-3)).toEqual(['body-99','body-100','body-99'])
  })
  it('measures actual multibyte UTF-8 and evicts only complete oldest entries', () => {
    const body = '图'.repeat(21840)
    let state = emptyHistory
    for (let index = 0; index < 17; index++) state = recordHistory(state, body + index)
    expect(state.entries).toHaveLength(16)
    expect(state.entries[0]).toBe(body + '1')
    expect(state.entries.at(-1)).toBe(body + '16')
    expect(state.entries.reduce((sum, entry) => sum + new TextEncoder().encode(entry).byteLength, 0)).toBeLessThanOrEqual(MAX_COMPOSER_HISTORY_BYTES)
  })
  it('restores only valid per-Session body arrays without inferring queue or delivery facts', () => {
    const restored = restoreComposerHistory({a:['literal original','later'], b:[false], c:null, d:{entries:['not a body array']}})
    expect(restored).toEqual({a:['literal original','later']})
    expect(restoreComposerHistory(undefined)).toEqual({})
    expect(restoreComposerHistory(['not a Session map'])).toEqual({})
    expect(restoreComposerHistory({a:Array.from({length:101},(_,i)=>''+i)}).a).toHaveLength(100)
  })
})
