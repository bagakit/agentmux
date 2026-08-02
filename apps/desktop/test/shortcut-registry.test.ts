import { describe, expect, it } from 'vitest'
import {
  INNER_SCOPES,
  SHORTCUT_BINDINGS,
  SHORTCUT_SCOPES,
  chordForPlatform,
  chordMatches,
  matchShortcut,
  monacoKeybindingFor,
  routeWindowShortcut,
  type Chord,
  type ShortcutBinding,
  type ShortcutEvent
} from '../src/renderer/src/lib/shortcut-registry.js'
import { formatChord } from '../src/renderer/src/lib/shortcut-cheat-sheet.js'

// The registry is the SSOT for every keyboard binding. These guards must FAIL on a real mutation:
// change any binding's modifiers, swap two ids, flatten the letter/digit bottom lines into one, invert a
// gate, or collide two ids. Expected values are anchored to literals, never derived from the object under
// test.

function event(overrides: Partial<ShortcutEvent>): ShortcutEvent {
  return { key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

// ---------------------------------------------------------------------------
// id uniqueness & stability. Two bindings sharing an id → red. The id set is the override-persistence
// key and the cheat-sheet anchor, so it is anchored to the exact literal list: adding/renaming a binding
// forces this list to be updated deliberately (that IS the "stable id" contract).
// ---------------------------------------------------------------------------
describe('binding id set', () => {
  it('every id is unique', () => {
    const ids = SHORTCUT_BINDINGS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is exactly this frozen set of ids (stability contract — changing it is a deliberate act)', () => {
    // Anchored literal, NOT derived from SHORTCUT_BINDINGS. A dropped/renamed/added binding turns this red.
    expect([...SHORTCUT_BINDINGS.map((b) => b.id)].sort()).toEqual([
      'editor.save',
      'editor.show-commands',
      'editor.toggle-word-wrap',
      'help.shortcuts',
      'quick-switch.toggle',
      'terminal.clear',
      'terminal.copy',
      'terminal.newline',
      'terminal.search',
      'workbench.close-region',
      'workbench.focus-region.down',
      'workbench.focus-region.left',
      'workbench.focus-region.right',
      'workbench.focus-region.up',
      'workbench.next-tab',
      'workbench.previous-tab',
      'workbench.select-tab.1',
      'workbench.select-tab.2',
      'workbench.select-tab.3',
      'workbench.select-tab.4',
      'workbench.select-tab.5',
      'workbench.select-tab.6',
      'workbench.select-tab.7',
      'workbench.select-tab.8',
      'workbench.select-tab.9',
      'workbench.split.down',
      'workbench.split.right',
      // launcher scope: the start page's own handler. Its whole point is firing INSIDE the prompt textarea,
      // which is why it cannot be an un-gated window binding — see ShortcutScope's comment.
      'launcher.submit'
    ].sort())
  })

  it('no two bindings in one scope resolve to the same chord on either platform', () => {
    // A collision within a scope would make one binding unreachable. Every scope that routes by MATCHING is
    // checked — derived by subtracting the one scope that does not (editor, matched by Monaco's own table),
    // rather than hand-listing `['window', 'terminal']` as this did before. A scope added to the registry
    // was silently outside this loop: its bindings could collide with each other and nothing said so.
    const matchedScopes = SHORTCUT_SCOPES.filter((scope) => scope !== 'editor')
    // Self-check: if the subtraction ever empties (or the union shrinks to just editor) the loop below runs
    // zero times and passes vacuously.
    expect(matchedScopes.length, 'no matched scopes — SHORTCUT_SCOPES changed shape').toBeGreaterThan(1)
    for (const scope of matchedScopes) {
      const inScope = SHORTCUT_BINDINGS.filter((b) => b.scope === scope)
      // Every declared scope must actually carry bindings; an empty scope is a declaration with no registry
      // entry (this repo's "声明了却从不注册的事件" shape) and also makes this scope's iteration vacuous.
      expect(inScope.length, `scope ${scope} is declared but no binding uses it`).toBeGreaterThan(0)
      for (const isMac of [true, false]) {
        const seen = new Map<string, string>()
        for (const binding of inScope) {
          const chord = chordForPlatform(binding, isMac)
          const key = `${chord.key}|${chord.primary}|${chord.shift}|${chord.alt}`
          expect(seen.has(key), `collision in ${scope}/${isMac ? 'mac' : 'other'}: ${binding.id} vs ${seen.get(key)}`).toBe(false)
          seen.set(key, binding.id)
        }
      }
    }
  })

  it('an un-gated window binding never collides with a terminal or editor chord — those surfaces do not shield it', () => {
    // The within-scope guard above is NOT enough, because the scopes are not actually isolated from each
    // other. App's window listener runs at `capture: true` and only calls `preventDefault()` — it never
    // stops propagation — so a window binding sees the key FIRST no matter which surface has focus.
    // What shields the inner surfaces is the `not-in-editable` gate: Monaco's input element is a
    // `<textarea class="inputarea">` and xterm's is also editable, so a gated binding steps aside there.
    // An UN-gated window binding (quick switch, help) has no such shield and fires over both surfaces.
    //
    // So the real rule is: an un-gated window chord must not be claimed by any terminal or editor binding,
    // or that inner binding is simply unreachable — the window action wins every time. This was never
    // guarded, and it is the same blind spot that let `editor.show-commands` ship claiming Ctrl+Shift+E,
    // which `workbench.split.right` also declares.
    const unGatedWindow = SHORTCUT_BINDINGS.filter((b) => b.scope === 'window' && b.gate !== 'not-in-editable')
    // Self-check: an empty list would make the loop below vacuously green.
    expect(unGatedWindow.length, 'no un-gated window bindings found — the filter or the registry changed shape').toBeGreaterThan(0)
    // The inner scopes come from the registry's own derived list, NOT a hand-written `terminal || editor`.
    // That hand-list was the hole: adding a scope left its bindings outside this guard entirely, so a new
    // inner binding could ship claiming a chord an un-gated window binding already wins — silently
    // unreachable, which is the exact defect this test was written for.
    expect(
      [...INNER_SCOPES].sort(),
      'INNER_SCOPES must be every scope except window, or this guard has a blind spot again'
    ).toEqual(SHORTCUT_SCOPES.filter((scope) => scope !== 'window').sort())
    const inner = SHORTCUT_BINDINGS.filter((b) => INNER_SCOPES.includes(b.scope))
    expect(inner.length, 'no inner-scope bindings found — the filter or the registry changed shape').toBeGreaterThan(0)

    for (const isMac of [true, false]) {
      const chordKey = (b: ShortcutBinding): string => {
        const c = chordForPlatform(b, isMac)
        return `${c.key}|${c.primary}|${c.shift}|${c.alt}`
      }
      const claimed = new Map(unGatedWindow.map((b) => [chordKey(b), b.id]))
      for (const binding of inner) {
        const key = chordKey(binding)
        expect(
          claimed.has(key),
          `${binding.id} (${binding.scope}) is unreachable on ${isMac ? 'mac' : 'other'}: the un-gated window binding ${claimed.get(key)} claims the same chord and fires first`
        ).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The platform bottom line: off mac, NO binding fires on a bare Ctrl+letter (that is readline's Ctrl+W
// delete-word / Ctrl+D EOF). This is a distribution property — sample the WHOLE letter alphabet against
// every non-mac binding, not one pair (this repo's lesson: sampling one pair goes false-green).
// ---------------------------------------------------------------------------
describe('non-mac never claims a bare Ctrl+letter', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('')

  it('no window or terminal binding matches a bare Ctrl+<letter> off mac', () => {
    for (const letter of letters) {
      const bareCtrlLetter = event({ key: letter, ctrlKey: true })
      expect(matchShortcut(bareCtrlLetter, false, { scope: 'window' }), `window bare Ctrl+${letter}`).toBeNull()
      expect(matchShortcut(bareCtrlLetter, false, { scope: 'terminal' }), `terminal bare Ctrl+${letter}`).toBeNull()
    }
  })

  it('every letter-class binding requires Shift off mac (so it can never be a bare Ctrl+letter)', () => {
    // Direct structural read: the bottom line lives on keyClass 'letter'. If someone flattens a letter
    // binding to bare Ctrl off mac, its `other.shift` flips to false and this fails — for that specific
    // binding, not just a sampled one. Editor.save is the deliberate exception (its own scope, no shell).
    for (const binding of SHORTCUT_BINDINGS) {
      if (binding.keyClass !== 'letter') continue
      if (binding.scope === 'editor') continue
      expect(binding.other.shift, `${binding.id} must require Shift off mac`).toBe(true)
      expect(binding.other.primary, `${binding.id} rides the primary (Ctrl) chord off mac`).toBe(true)
    }
  })

  it('digit and arrow classes ride bare primary off mac — the OTHER bottom line, kept distinct', () => {
    // This is the second, different bottom line: Ctrl+digit (tab select) and Ctrl+Alt+arrow are safe off
    // mac and must NOT carry the letter rule's Shift. Guarding this stops anyone flattening the two
    // bottom lines into one "all chords need Shift off mac" rule.
    const digits = SHORTCUT_BINDINGS.filter((b) => b.keyClass === 'digit')
    expect(digits.length).toBeGreaterThan(0)
    for (const binding of digits) {
      expect(binding.other.shift, `${binding.id} digit must NOT require Shift off mac`).toBe(false)
      expect(binding.other.primary, `${binding.id} digit rides bare Ctrl off mac`).toBe(true)
    }
    const arrows = SHORTCUT_BINDINGS.filter((b) => b.keyClass === 'arrow')
    expect(arrows.length).toBeGreaterThan(0)
    for (const binding of arrows) {
      expect(binding.other.shift, `${binding.id} arrow must NOT require Shift off mac`).toBe(false)
      expect(binding.other.alt, `${binding.id} arrow requires Alt`).toBe(true)
    }
  })

  it('a bare Ctrl+digit off mac DOES select a tab — proving the digit bottom line is real, not vacuous', () => {
    // The mirror of the letter guard: if the digit rule were wrongly given Shift, this would go null.
    expect(matchShortcut(event({ key: '1', ctrlKey: true }), false, { scope: 'window' }))
      .toBe('workbench.select-tab.1')
  })

  // 守的缺陷：`help.shortcuts` 曾以 keyClass 'letter' 声明 `/`，两个平台都写 `'/'`。字母那条「非 mac 加
  // Shift」的底线之所以能用一个字符覆盖两个平台，靠的是 `chordMatches` 的 `toLowerCase()` 恰好抵消了
  // Shift 带来的大小写变化——按 Ctrl+Shift+P 时 `event.key` 是 `'P'`，小写回去正是 `'p'`。符号没有这个
  // 往返：Shift+`/` 送到的是 `'?'`，一个完全不同的字符，小写化对它什么都不做。于是非 mac 上注册表期望
  // `'/'` 而键盘送 `'?'`，匹配恒为 null——**全应用唯一的快捷键发现入口按不出来**，而菜单加速键是主进程
  // 故意抹掉的，没有第二条路。上面那条 letter 守卫按 keyClass 过滤，`/` 冒充 letter 时正好绕过它。
  //
  // 判据落在「真实键盘送什么」上，不落在 keyClass 上：符号类的 `other.key` 必须与 `mac.key` 不同（因为
  // 它必须是 Shift 后的那个字符），并且用真实事件两个平台各打一次。keyClass 在注册表外零消费者，
  // 所以只判它等于某个字面量证不了任何行为。
  it('symbol-class bindings name their shifted character — a real keyboard event fires them on both platforms', () => {
    const symbols = SHORTCUT_BINDINGS.filter((b) => b.keyClass === 'symbol')
    // 挡板：这一族读成空则下面循环一条不跑、整条静默通过。把 help 改回 letter 会让这里立刻红。
    expect(symbols.length, 'the registry must carry at least one symbol binding').toBeGreaterThan(0)
    for (const binding of symbols) {
      // 承重不变量：非 mac 要求 Shift，而 Shift 会改变送到的字符，所以两个平台的 key 必须不同。
      // 把 symbolChords 写成两边同字符（正是原来的 bug）会在这里红。
      expect(binding.other.shift, `${binding.id} must require Shift off mac`).toBe(true)
      expect(binding.other.key, `${binding.id}: the shifted key must differ from the unshifted one`)
        .not.toBe(binding.mac.key)
      // 行为侧：两个平台各用一个真实事件打一次。结构对而匹配不上（比如 chordMatches 哪天改了归一化）
      // 会在这里红，而不是只在结构断言那里绿着。
      expect(
        matchShortcut(event({ key: binding.mac.key, metaKey: true }), true, { scope: binding.scope }),
        `${binding.id} must fire on mac`
      ).toBe(binding.id)
      expect(
        matchShortcut(event({ key: binding.other.key, ctrlKey: true, shiftKey: true }), false, { scope: binding.scope }),
        `${binding.id} must fire off mac`
      ).toBe(binding.id)
    }
  })

  it('relative tab nav rides the real bracket keys, and the two directions are not swapped', () => {
    // 独立于上面那条通用符号规则：它用**声明自己的 key** 造事件，所以「把 `{` 写成 `(`」照旧绿——
    // 造出来的事件跟着错一起错。这里的字面量取自真实 US 布局：`[`/`]` 加 Cmd（mac），
    // 而 Ctrl+Shift+`[` 送到的是 `{`、Shift+`]` 是 `}`。
    expect(matchShortcut(event({ key: '[', metaKey: true }), true, { scope: 'window' }))
      .toBe('workbench.previous-tab')
    expect(matchShortcut(event({ key: ']', metaKey: true }), true, { scope: 'window' }))
      .toBe('workbench.next-tab')
    expect(matchShortcut(event({ key: '{', ctrlKey: true, shiftKey: true }), false, { scope: 'window' }))
      .toBe('workbench.previous-tab')
    expect(matchShortcut(event({ key: '}', ctrlKey: true, shiftKey: true }), false, { scope: 'window' }))
      .toBe('workbench.next-tab')
    // 与 help 相反，这两条是 gated 的：在 composer 里打字时按 Cmd+] 不该翻 Tab。
    expect(matchShortcut(event({ key: ']', metaKey: true }), true, { scope: 'window', editableTarget: true }))
      .toBeNull()
  })

  it('help is reachable: a real US-layout Ctrl+Shift+/ (which delivers "?") summons the cheat-sheet', () => {
    // 具体锚点，独立于上面那条通用规则：这是全应用唯一的发现入口，值得钉死它自己的和弦。
    // `?` 是 US 布局按 Ctrl+Shift+/ 时 `event.key` 的真实取值——不是 `/`。
    expect(matchShortcut(event({ key: '?', ctrlKey: true, shiftKey: true }), false, { scope: 'window' }))
      .toBe('help.shortcuts')
    expect(matchShortcut(event({ key: '/', metaKey: true }), true, { scope: 'window' }))
      .toBe('help.shortcuts')
    // 反向：help 不设 gate（打字时也要能召唤），但绝不能被裸 `/` 或裸 `?` 命中——那会在终端里吞掉输入。
    expect(matchShortcut(event({ key: '/' }), false, { scope: 'window' })).toBeNull()
    expect(matchShortcut(event({ key: '?', shiftKey: true }), false, { scope: 'window' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Exact per-binding chords, anchored to literals. Mutating any modifier flips one of these.
// ---------------------------------------------------------------------------
describe('exact chord matching per binding', () => {
  it('quick switch: Cmd+P mac / Ctrl+Shift+P other; not the readline-reserved bare Ctrl+P', () => {
    expect(matchShortcut(event({ key: 'p', metaKey: true }), true, { scope: 'window' })).toBe('quick-switch.toggle')
    expect(matchShortcut(event({ key: 'p', ctrlKey: true, shiftKey: true }), false, { scope: 'window' })).toBe('quick-switch.toggle')
    expect(matchShortcut(event({ key: 'p', ctrlKey: true }), false, { scope: 'window' })).toBeNull()
  })

  it('close region: Cmd+W mac / Ctrl+Shift+W other', () => {
    expect(matchShortcut(event({ key: 'w', metaKey: true }), true, { scope: 'window' })).toBe('workbench.close-region')
    expect(matchShortcut(event({ key: 'w', ctrlKey: true, shiftKey: true }), false, { scope: 'window' })).toBe('workbench.close-region')
    // bare Ctrl+W off mac stays with readline
    expect(matchShortcut(event({ key: 'w', ctrlKey: true }), false, { scope: 'window' })).toBeNull()
  })

  it('split: mac uses Shift for direction (D right / Shift+D down); other uses distinct letters (E/O)', () => {
    expect(matchShortcut(event({ key: 'd', metaKey: true }), true, { scope: 'window' })).toBe('workbench.split.right')
    expect(matchShortcut(event({ key: 'd', metaKey: true, shiftKey: true }), true, { scope: 'window' })).toBe('workbench.split.down')
    expect(matchShortcut(event({ key: 'e', ctrlKey: true, shiftKey: true }), false, { scope: 'window' })).toBe('workbench.split.right')
    expect(matchShortcut(event({ key: 'o', ctrlKey: true, shiftKey: true }), false, { scope: 'window' })).toBe('workbench.split.down')
  })

  it('focus region: Cmd/Ctrl+Alt+arrow, both platforms', () => {
    expect(matchShortcut(event({ key: 'arrowleft', metaKey: true, altKey: true }), true, { scope: 'window' })).toBe('workbench.focus-region.left')
    expect(matchShortcut(event({ key: 'arrowdown', ctrlKey: true, altKey: true }), false, { scope: 'window' })).toBe('workbench.focus-region.down')
    // no Alt → not a focus move
    expect(matchShortcut(event({ key: 'arrowleft', metaKey: true }), true, { scope: 'window' })).toBeNull()
  })

  it('terminal search/copy/clear: Cmd+F/C/K mac, Ctrl+Shift+F/C/K other, only in terminal scope', () => {
    expect(matchShortcut(event({ key: 'f', metaKey: true }), true, { scope: 'terminal' })).toBe('terminal.search')
    expect(matchShortcut(event({ key: 'c', metaKey: true }), true, { scope: 'terminal' })).toBe('terminal.copy')
    expect(matchShortcut(event({ key: 'k', metaKey: true }), true, { scope: 'terminal' })).toBe('terminal.clear')
    expect(matchShortcut(event({ key: 'f', ctrlKey: true, shiftKey: true }), false, { scope: 'terminal' })).toBe('terminal.search')
    // a terminal chord must NOT resolve in window scope, and vice versa — scopes are disjoint
    expect(matchShortcut(event({ key: 'f', metaKey: true }), true, { scope: 'window' })).toBeNull()
  })

  it('terminal newline: bare Shift+Enter only; any primary modifier or plain Enter is not ours', () => {
    expect(matchShortcut(event({ key: 'Enter', shiftKey: true }), true, { scope: 'terminal' })).toBe('terminal.newline')
    expect(matchShortcut(event({ key: 'Enter' }), true, { scope: 'terminal' })).toBeNull()
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(matchShortcut(event({ key: 'Enter', shiftKey: true, [modifier]: true }), true, { scope: 'terminal' })).toBeNull()
    }
  })

  it('editor save: bare Cmd/Ctrl+S both platforms (editor scope has no readline underneath)', () => {
    expect(matchShortcut(event({ key: 's', metaKey: true }), true, { scope: 'editor' })).toBe('editor.save')
    expect(matchShortcut(event({ key: 's', ctrlKey: true }), false, { scope: 'editor' })).toBe('editor.save')
  })

  it('Shift is matched exactly — Cmd+Shift+F is a distinct chord, not Cmd+F', () => {
    // The three original libs disagreed on whether to exclude Shift on the mac side. The registry
    // matches Shift exactly, so a future binding can claim Cmd+Shift+F. If someone stops matching Shift
    // exactly (mac side ignores it), this goes green-when-it-should-be-red for terminal.search.
    expect(matchShortcut(event({ key: 'f', metaKey: true, shiftKey: true }), true, { scope: 'terminal' })).toBeNull()
    expect(matchShortcut(event({ key: 'f', metaKey: true }), true, { scope: 'terminal' })).toBe('terminal.search')
  })
})

// ---------------------------------------------------------------------------
// The context gate, both directions. A `not-in-editable` binding must be suppressed when editableTarget
// is true (should-block-blocks), and must fire when it is false (should-not-block-doesn't). The un-gated
// quick switcher fires either way.
// ---------------------------------------------------------------------------
describe('editable-target gate (both directions)', () => {
  it('suppresses a gated binding inside an editable target', () => {
    expect(matchShortcut(event({ key: 'w', metaKey: true }), true, { scope: 'window', editableTarget: true })).toBeNull()
    expect(matchShortcut(event({ key: 'd', metaKey: true }), true, { scope: 'window', editableTarget: true })).toBeNull()
    expect(matchShortcut(event({ key: '1', metaKey: true }), true, { scope: 'window', editableTarget: true })).toBeNull()
  })

  it('fires a gated binding when NOT in an editable target', () => {
    expect(matchShortcut(event({ key: 'w', metaKey: true }), true, { scope: 'window', editableTarget: false })).toBe('workbench.close-region')
  })

  it('the quick switcher is un-gated: fires even inside an editable target', () => {
    // A global navigation gesture must reach the user mid-typing; if someone adds the gate to it, red.
    expect(matchShortcut(event({ key: 'p', metaKey: true }), true, { scope: 'window', editableTarget: true })).toBe('quick-switch.toggle')
  })
})

// ---------------------------------------------------------------------------
// chordMatches unit-level: the exactness that everything above rides on.
// ---------------------------------------------------------------------------
describe('chordMatches', () => {
  const chord: Chord = { key: 'f', primary: true, shift: false, alt: false }
  it('rejects when the opposite primary modifier is held (Cmd on non-mac / Ctrl on mac)', () => {
    expect(chordMatches(chord, event({ key: 'f', metaKey: true, ctrlKey: true }), true)).toBe(false)
    expect(chordMatches(chord, event({ key: 'f', metaKey: true, ctrlKey: true }), false)).toBe(false)
  })
  it('a non-primary chord rejects any primary modifier', () => {
    const bare: Chord = { key: 'enter', primary: false, shift: true, alt: false }
    expect(chordMatches(bare, event({ key: 'Enter', shiftKey: true }), true)).toBe(true)
    expect(chordMatches(bare, event({ key: 'Enter', shiftKey: true, metaKey: true }), true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// routeWindowShortcut: the pure core of App's shell. Match → gate → dispatch to the id's handler → report
// consumption. A handler that returns false must NOT be reported as consumed (so the shell won't
// preventDefault). An unmatched or unhandled event returns false.
// ---------------------------------------------------------------------------
describe('routeWindowShortcut', () => {
  it('dispatches to the matched id handler and reports what the handler returned', () => {
    const calls: string[] = []
    const handlers = {
      'workbench.close-region': () => { calls.push('close'); return true }
    }
    const consumed = routeWindowShortcut(event({ key: 'w', metaKey: true }), true, false, handlers)
    expect(consumed).toBe(true)
    expect(calls).toEqual(['close'])
  })

  it('a declining handler (returns false) is not reported consumed', () => {
    const handlers = { 'workbench.close-region': () => false }
    expect(routeWindowShortcut(event({ key: 'w', metaKey: true }), true, false, handlers)).toBe(false)
  })

  it('an unmatched event returns false and calls nothing', () => {
    let called = false
    const handlers = { 'workbench.close-region': () => { called = true; return true } }
    expect(routeWindowShortcut(event({ key: 'z', metaKey: true }), true, false, handlers)).toBe(false)
    expect(called).toBe(false)
  })

  it('honours the gate: a gated id inside an editable target routes nothing', () => {
    let called = false
    const handlers = { 'workbench.close-region': () => { called = true; return true } }
    expect(routeWindowShortcut(event({ key: 'w', metaKey: true }), true, true, handlers)).toBe(false)
    expect(called).toBe(false)
  })

  it('a matched id with no registered handler returns false (never throws)', () => {
    expect(routeWindowShortcut(event({ key: 'w', metaKey: true }), true, false, {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The registry → Monaco crossing. This is the one boundary where the registry is NOT the matcher: Monaco
// owns the table, so something has to translate. It had no test at all, which is exactly how the defect
// below survived — mutating `const chord = binding.mac` to `binding.other` left every existing test green.
// ---------------------------------------------------------------------------
describe('monacoKeybindingFor', () => {
  // Real Monaco 0.56.0 values, not placeholders — a wrong constant would make the expected bitmasks
  // meaningless. KeyMod: common/services/editorBaseApi.js:16-19. KeyCode F1=59: base/common/keyCodes.js:104.
  const monaco = {
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
    KeyCode: { KeyE: 35, KeyS: 49, KeyZ: 56, F1: 59 } as Record<string, number>
  }

  function binding(overrides: Partial<ShortcutBinding> & Pick<ShortcutBinding, 'mac' | 'other'>): ShortcutBinding {
    return { id: 'test.binding', scope: 'editor', keyClass: 'letter', label: 'Test', ...overrides }
  }

  it('refuses a binding whose two platform chords differ, instead of silently shipping one of them', () => {
    // The defect's actual shape. `editor.show-commands` used `letterChords`, which diverges ON PURPOSE
    // (bare Cmd on mac, Ctrl+Shift elsewhere). Monaco remaps only the primary modifier — Shift passes
    // through verbatim — so off mac Monaco was handed Ctrl+E while the cheat-sheet advertised Ctrl+Shift+E.
    // The advertised key did nothing and the working key was advertised nowhere.
    expect(() => monacoKeybindingFor(binding({
      mac: { key: 'e', primary: true, shift: false, alt: false },
      other: { key: 'e', primary: true, shift: true, alt: false }
    }), monaco)).toThrow(/identical on every platform/)
  })

  it('each modifier difference is caught on its own — not just the one the defect happened to have', () => {
    // Four separate exits. Guarding only `shift` would let a key/primary/alt divergence through, and the
    // ONE that shipped was shift — so a guard written against just that instance proves nothing.
    const base = { key: 'e', primary: true, shift: false, alt: false }
    for (const other of [
      { ...base, key: 'f' },
      { ...base, primary: false },
      { ...base, shift: true },
      { ...base, alt: true }
    ]) {
      expect(() => monacoKeybindingFor(binding({ mac: base, other }), monaco), JSON.stringify(other)).toThrow()
    }
  })

  it('translates an identical-on-both-platforms chord to the bitmask Monaco wants', () => {
    // Anchored to the literal sum, NOT recomputed from `monaco.*` — an expected value derived the same way
    // the implementation derives it would drift along with any mutation and stay green.
    expect(monacoKeybindingFor(binding({
      mac: { key: 's', primary: true, shift: false, alt: false },
      other: { key: 's', primary: true, shift: false, alt: false }
    }), monaco)).toBe(2048 + 49)
  })

  it('a function key rides no modifier at all — F1 alone, never ⌘F1', () => {
    expect(monacoKeybindingFor(binding({
      keyClass: 'named',
      mac: { key: 'f1', primary: false, shift: false, alt: false },
      other: { key: 'f1', primary: false, shift: false, alt: false }
    }), monaco)).toBe(59)
  })

  it('a key Monaco spells differently throws rather than shipping a keybinding that can never fire', () => {
    // `undefined` through `|` becomes NaN, which Monaco accepts and then never matches. Loud beats silent.
    expect(() => monacoKeybindingFor(binding({
      keyClass: 'named',
      mac: { key: 'backspace', primary: true, shift: false, alt: false },
      other: { key: 'backspace', primary: true, shift: false, alt: false }
    }), monaco)).toThrow(/no Monaco KeyCode/)
  })

  it('every editor binding in the real registry survives the crossing', () => {
    // The guards above use fixtures; this one runs the SHIPPING table through it. A future editor binding
    // written with `letterChords` turns this red at the source rather than at a user's keyboard.
    const editorBindings = SHORTCUT_BINDINGS.filter((b) => b.scope === 'editor')
    expect(editorBindings.length, 'no editor bindings found — the filter or the registry changed shape').toBeGreaterThan(0)
    for (const b of editorBindings) {
      expect(() => monacoKeybindingFor(b, monaco), `${b.id} cannot be expressed to Monaco`).not.toThrow()
    }
  })

  it('the chord the cheat-sheet advertises off mac is the chord Monaco is handed', () => {
    // The missing assertion named by the review. The cheat-sheet renders `.other` off mac while Monaco is
    // handed `.mac`; when those diverge the user reads one key and the editor obeys another. Comparing the
    // two projections — display tokens vs Monaco bitmask — is what makes that disagreement detectable.
    for (const b of SHORTCUT_BINDINGS.filter((x) => x.scope === 'editor')) {
      const advertised = formatChord(chordForPlatform(b, false), false)
      const obeyed = monacoKeybindingFor(b, monaco)
      // Rebuild the bitmask from the DISPLAYED tokens, so the two sides are derived from different fields.
      const tokenBits = (advertised.includes('Ctrl') ? monaco.KeyMod.CtrlCmd : 0)
        + (advertised.includes('Alt') ? monaco.KeyMod.Alt : 0)
        + (advertised.includes('Shift') ? monaco.KeyMod.Shift : 0)
      const keyToken = advertised[advertised.length - 1]!
      const keyBits = monaco.KeyCode[keyToken.length === 1 ? `Key${keyToken}` : keyToken.toUpperCase()]
      expect(keyBits, `${b.id}: cheat-sheet renders key token ${keyToken} that no Monaco KeyCode matches`).toBeTypeOf('number')
      expect(tokenBits + keyBits!, `${b.id}: cheat-sheet advertises ${advertised.join('+')} but Monaco obeys a different chord`).toBe(obeyed)
    }
  })
})
