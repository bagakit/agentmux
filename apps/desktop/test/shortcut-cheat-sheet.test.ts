import { describe, expect, it } from 'vitest'
import {
  CHEAT_SHEET_GROUPS,
  buildCheatSheet,
  formatChord,
  groupIdForBinding,
  type CheatSheetGroupId
} from '../src/renderer/src/lib/shortcut-cheat-sheet.js'
import { SHORTCUT_SCOPES, SHORTCUT_BINDINGS, type Chord, type ShortcutBinding } from '../src/renderer/src/lib/shortcut-registry.js'

// The cheat-sheet is pure接线 over the registry — it declares NO binding of its own. These guards must FAIL
// on the two ways a hand-kept second list drifts (this repo's "声明了却从不注册的事件" lesson): a binding
// added to the registry that the sheet drops, or a row in the sheet that the registry does not have. Plus
// the platform-shape guard: a mac chord must never render as a non-mac one, and vice versa.

// ---------------------------------------------------------------------------
// SAME-SET, both directions. This is the core judgement of this phase.
// ---------------------------------------------------------------------------
describe('cheat-sheet is the same set as the registry', () => {
  it('the union of all rendered row ids equals the registry id set exactly (both directions)', () => {
    // Not anchored to a literal list on purpose: the SSOT for "which ids exist" is the registry, and
    // shortcut-registry.test.ts already freezes that literal set. Here the property is EQUALITY to the
    // registry — add a binding and the sheet must grow; drop one and it must shrink; filter one out in
    // buildCheatSheet and this fails immediately.
    const rowIds = buildCheatSheet(true).flatMap((group) => group.rows.map((row) => row.id))
    const registryIds = SHORTCUT_BINDINGS.map((binding) => binding.id)
    // no duplicates — every binding appears in exactly one group
    expect(new Set(rowIds).size).toBe(rowIds.length)
    expect(new Set(rowIds)).toEqual(new Set(registryIds))
    // and the platform doesn't change WHICH bindings show, only their key shape
    const rowIdsOther = buildCheatSheet(false).flatMap((group) => group.rows.map((row) => row.id))
    expect(new Set(rowIdsOther)).toEqual(new Set(registryIds))
  })

  it('the help binding itself appears — you can discover how to open this sheet from inside it', () => {
    const rowIds = buildCheatSheet(true).flatMap((group) => group.rows.map((row) => row.id))
    expect(rowIds).toContain('help.shortcuts')
  })
})

// ---------------------------------------------------------------------------
// Grouping is a projection of the registry's own (scope, gate), total over the table.
// ---------------------------------------------------------------------------
describe('grouping is derived from scope + gate, and is total', () => {
  it('maps each binding to exactly one group, anchored to the (scope, gate) rule', () => {
    // Anchored expectations for one representative of each group — mutating the rule (e.g. sending gated
    // window bindings to 'global') flips these.
    const groupOf = (id: string): CheatSheetGroupId =>
      groupIdForBinding(SHORTCUT_BINDINGS.find((b) => b.id === id)!)
    expect(groupOf('quick-switch.toggle')).toBe('global') // window, un-gated
    expect(groupOf('help.shortcuts')).toBe('global')       // window, un-gated
    expect(groupOf('workbench.close-region')).toBe('workbench') // window, gated
    expect(groupOf('workbench.select-tab.1')).toBe('workbench') // window, gated
    expect(groupOf('terminal.search')).toBe('terminal')
    expect(groupOf('editor.save')).toBe('editor')
    expect(groupOf('launcher.submit')).toBe('launcher')
  })

  // 守的缺陷：`groupIdForBinding` 曾以 `return binding.gate === 'not-in-editable' ? 'workbench' : 'global'`
  // 收尾——一个兜底。加 `launcher` scope 时它**静默落进 Global**：那一行会渲染在「Global」标题下，向用户
  // 宣称这是随处可用的手势，而它其实只在起点页那一格活着。分组不是装饰，它是「这个键在哪里能按」这句话，
  // 兜底把这句话说反了，而所有既有断言（同集合、平台形状、totality）全都照旧绿——新 scope 确实落在一个
  // 被渲染的组里，只是落错了。
  //
  // 判据不写「不许有兜底」（换个拼法就绕过），而是钉住那句话本身的含义：内层 scope 的组绝不能与任何
  // window scope 的组相同。scope 清单取自注册表自己的 SHORTCUT_SCOPES，所以新加一个 scope 立刻被质询。
  it('no inner scope shares a group with a window binding — a group states WHERE the chord is live', () => {
    const fixture = (scope: ShortcutBinding['scope'], gate?: 'not-in-editable'): ShortcutBinding => ({
      id: `fixture.${scope}`,
      scope,
      keyClass: 'named',
      label: 'Fixture',
      mac: { key: 'enter', primary: true, shift: false, alt: false },
      other: { key: 'enter', primary: true, shift: false, alt: false },
      ...(gate ? { gate } : {})
    })
    // The two shapes a window binding can take — both real (un-gated: quick switch / help; gated: workbench).
    const windowGroups = new Set([
      groupIdForBinding(fixture('window')),
      groupIdForBinding(fixture('window', 'not-in-editable'))
    ])
    const innerScopes = SHORTCUT_SCOPES.filter((scope) => scope !== 'window')
    // Self-check: an empty list makes the loop vacuous.
    expect(innerScopes.length, 'no inner scopes — SHORTCUT_SCOPES changed shape').toBeGreaterThan(0)
    for (const scope of innerScopes) {
      const group = groupIdForBinding(fixture(scope))
      expect(
        windowGroups.has(group),
        `scope ${scope} groups as "${group}", the same group a window binding gets — the sheet would claim it is available everywhere`
      ).toBe(false)
    }
  })

  // 第二个静默漏点，与上面那条正交：分组可以给出一个**正确看起来**的 id，而渲染那张表根本没有这一项。
  // `buildCheatSheet` 遍历的是 CHEAT_SHEET_GROUPS，所以那些行会从清单里彻底消失。tsc 看不见缺一项。
  // 用合成 binding 而不是真 binding：这样一个 scope 在还没有任何 binding 时就被质询，不必等到有人加键。
  it('every declared scope maps to a group the sheet actually renders', () => {
    const rendered = new Set(CHEAT_SHEET_GROUPS.map((group) => group.id))
    expect(rendered.size, 'CHEAT_SHEET_GROUPS is empty — nothing would render').toBeGreaterThan(0)
    for (const scope of SHORTCUT_SCOPES) {
      for (const gate of [undefined, 'not-in-editable'] as const) {
        const group = groupIdForBinding({
          id: `fixture.${scope}`,
          scope,
          keyClass: 'named',
          label: 'Fixture',
          mac: { key: 'enter', primary: true, shift: false, alt: false },
          other: { key: 'enter', primary: true, shift: false, alt: false },
          ...(gate ? { gate } : {})
        })
        expect(rendered.has(group), `scope ${scope}${gate ? ` (${gate})` : ''} groups as "${group}", which CHEAT_SHEET_GROUPS never renders`).toBe(true)
      }
    }
  })

  it('every binding lands in a group that buildCheatSheet actually renders', () => {
    // Totality: no binding falls through grouping. If a new scope were added to the registry without a
    // group, its bindings would vanish from the sheet and the same-set guard above would already be red;
    // this states the property directly too.
    const renderedGroups = new Set(buildCheatSheet(true).map((group) => group.id))
    for (const binding of SHORTCUT_BINDINGS) {
      expect(renderedGroups.has(groupIdForBinding(binding)), `${binding.id} lands in an unrendered group`).toBe(true)
    }
  })

  it('the un-gated/gated split within window scope is real — global and workbench are different sets', () => {
    // If someone flattened the split (all window → one group), one of these would be empty.
    const global = buildCheatSheet(true).find((g) => g.id === 'global')!
    const workbench = buildCheatSheet(true).find((g) => g.id === 'workbench')!
    expect(global.rows.length).toBeGreaterThan(0)
    expect(workbench.rows.length).toBeGreaterThan(0)
    expect(global.rows.every((row) => !workbench.rows.some((w) => w.id === row.id))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Platform shape. mac uses the symbol glyphs; every other platform spells the words. A mac shape must
// never leak into a non-mac render (and vice versa). Anchored to literals.
// ---------------------------------------------------------------------------
describe('platform chord shape', () => {
  it('mac renders ⌘/⌥/⇧ glyphs; other renders Ctrl/Alt/Shift words — anchored per chord', () => {
    const primaryShiftAlt: Chord = { key: 'k', primary: true, shift: true, alt: true }
    expect(formatChord(primaryShiftAlt, true)).toEqual(['⌘', '⌥', '⇧', 'K'])
    expect(formatChord(primaryShiftAlt, false)).toEqual(['Ctrl', 'Alt', 'Shift', 'K'])
  })

  it('arrows become glyphs, Enter is spelled, single letters upper-case', () => {
    expect(formatChord({ key: 'arrowleft', primary: true, shift: false, alt: true }, true)).toEqual(['⌘', '⌥', '←'])
    expect(formatChord({ key: 'enter', primary: false, shift: true, alt: false }, true)).toEqual(['⇧', 'Enter'])
    expect(formatChord({ key: '/', primary: true, shift: false, alt: false }, false)).toEqual(['Ctrl', '/'])
  })

  it('quick-switch reads Cmd+P on mac / Ctrl+Shift+P elsewhere — through the real registry chord', () => {
    // End-to-end through buildCheatSheet so a wrong chordForPlatform pick (mac chord on non-mac) is caught.
    const macRow = buildCheatSheet(true).flatMap((g) => g.rows).find((r) => r.id === 'quick-switch.toggle')!
    const otherRow = buildCheatSheet(false).flatMap((g) => g.rows).find((r) => r.id === 'quick-switch.toggle')!
    expect(macRow.keys).toEqual(['⌘', 'P'])
    expect(otherRow.keys).toEqual(['Ctrl', 'Shift', 'P'])
  })

  it('NO non-mac render contains a mac glyph anywhere, and NO mac render contains a spelled modifier', () => {
    // Distribution property over the whole table (not one sampled pair): if formatChord ignored isMac,
    // one of these would fire for some binding.
    const macGlyphs = ['⌘', '⌥', '⇧']
    const spelledMods = ['Ctrl', 'Alt', 'Shift']
    for (const row of buildCheatSheet(false).flatMap((g) => g.rows)) {
      for (const glyph of macGlyphs) {
        expect(row.keys.includes(glyph), `${row.id} leaked mac glyph ${glyph} into non-mac`).toBe(false)
      }
    }
    for (const row of buildCheatSheet(true).flatMap((g) => g.rows)) {
      for (const mod of spelledMods) {
        expect(row.keys.includes(mod), `${row.id} leaked spelled ${mod} into mac`).toBe(false)
      }
    }
  })
})
