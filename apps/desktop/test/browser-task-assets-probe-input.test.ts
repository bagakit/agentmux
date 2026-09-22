import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync(process.env.AGENTMUX_TASK_VERSION_PROBE_SOURCE ?? new URL('../scripts/browser-task-assets-probe-scenario.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function selectVersion(')
const end = source.indexOf('\nasync function pageCount(', start)
assert.ok(start >= 0 && end > start, 'The actual scenario selection helper must be present')
const helper = source.slice(start, end)
assert.ok(helper.includes('Task asset version') && helper.includes('ctx.receipt.taskAssets.versionSelection'))

type Option = { value: string; label: string; disabled: boolean }
type Input = { type: string; key?: string; text?: string }
type Mode = 'trusted' | 'untrusted-change' | 'no-change' | 'wrong-value'
function fixture(mode: Mode = 'trusted', options: Option[] = [
  { value: '1', label: 'v1 · Recorded task', disabled: false },
  { value: '2', label: 'v2 · Recorded task', disabled: false }
], reachable = true) {
  const listeners = new Map<string, Set<(event: object) => void>>()
  const select = {
    value: '2', options,
    addEventListener(type: string, listener: (event: object) => void) { const current = listeners.get(type) ?? new Set(); current.add(listener); listeners.set(type, current) },
    removeEventListener(type: string, listener: (event: object) => void) { listeners.get(type)?.delete(listener) }
  }
  const document = { activeElement: null as unknown, hasFocus: () => false, querySelector: () => select }
  const context = createContext({ assert, quoted: JSON.stringify, taskSurface: '[aria-label="Editable Browser task asset"]', document, Date })
  const inputs: Input[] = [], expressions: string[] = []
  let typed = ''
  const emit = (type: string, key?: string, trusted = true) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, key, isTrusted: trusted })
  }
  const ctx = {
    receipt: { taskAssets: {} as Record<string, any> },
    probe: { cdp: {
      async evaluate(expression: string) {
        // This runs every emitted expression. The browser's typeahead is deliberately
        // only a transport model here; actual Chromium selection remains Root's gate.
        new Function(expression)
        expressions.push(expression)
        return runInContext(expression, context)
      },
      async call(method: string, input: Input) {
        assert.equal(method, 'Input.dispatchKeyEvent')
        inputs.push({ ...input })
        if (input.key === 'Tab' && input.type === 'keyDown' && reachable) document.activeElement = select
        if (document.activeElement !== select) return
        emit(input.type === 'char' ? 'keypress' : input.type.toLowerCase(), input.key)
        if (input.type !== 'char') return
        typed += input.text ?? ''
        const matches = options.filter(option => !option.disabled && option.label.toLowerCase().startsWith(typed.toLowerCase()))
        if (matches.length !== 1) return
        select.value = matches[0]!.value
        emit('input')
        if (mode !== 'no-change') emit('change', undefined, mode !== 'untrusted-change')
        // A prior trusted target change is insufficient if the current control
        // has since returned to another value.
        if (mode === 'wrong-value') select.value = '2'
      }
    } },
    async waitFor(_label: string, observe: () => Promise<unknown>) {
      const observed = await observe()
      assert.ok(observed, 'The actual value and trusted target change were not observed')
      return observed
    }
  }
  const selectVersion = runInContext(`(${helper})`, context) as (fixtureContext: typeof ctx, version: number) => Promise<void>
  return { ctx, inputs, expressions, select: () => selectVersion(ctx, 1) }
}

it('uses the real option label prefix through bounded keyboard input, retaining false document.hasFocus as observation', async () => {
  const f = fixture()
  await f.select()
  expect(f.inputs.map(input => [input.type, input.key, input.text ?? null])).toEqual([
    ['keyDown', 'Tab', null], ['keyUp', 'Tab', null],
    ['rawKeyDown', 'v', null], ['char', 'v', 'v'], ['keyUp', 'v', null],
    ['rawKeyDown', '1', null], ['char', '1', '1'], ['keyUp', '1', null]
  ])
  expect(f.ctx.receipt.taskAssets.versionSelection.prefix).toBe('v1')
  expect(f.ctx.receipt.taskAssets.versionSelection.after.value).toBe('1')
  expect(f.ctx.receipt.taskAssets.versionSelection.after.documentFocused).toBe(false)
  expect(f.expressions.length).toBeGreaterThan(0)
  for (const expression of f.expressions) {
    expect(expression).not.toMatch(/\.(?:value|selectedIndex)\s*=(?!=)/)
    expect(expression).not.toMatch(/\.focus\s*\(|dispatchEvent\s*\(/)
  }
})

it.each(['untrusted-change', 'no-change', 'wrong-value'] as const)('rejects %s instead of accepting an apparent selected value', async mode => {
  const f = fixture(mode)
  await expect(f.select()).rejects.toThrow()
  expect(f.ctx.receipt.taskAssets.versionSelection.after).toBeTruthy()
  expect(f.inputs.filter(input => input.type === 'char').map(input => input.text)).toEqual(['v', '1'])
})

it('rejects empty actual options without issuing a selection sequence', async () => {
  const f = fixture('trusted', [])
  await expect(f.select()).rejects.toThrow(/options|option/i)
  expect(f.inputs.filter(input => input.type === 'char')).toEqual([])
})

it('rejects a label with no unique prefix instead of substituting the DOM option value', async () => {
  const f = fixture('trusted', [
    { value: '1', label: 'Same label', disabled: false },
    { value: '2', label: 'Same label', disabled: false }
  ])
  await expect(f.select()).rejects.toThrow(/prefix/i)
  expect(f.inputs.filter(input => input.type === 'char')).toEqual([])
})

it('bounds real Tab navigation and rejects an unreachable control', async () => {
  const f = fixture('trusted', undefined, false)
  await expect(f.select()).rejects.toThrow(/navigation/i)
  expect(f.inputs.length).toBe(160)
  expect(f.inputs.filter(input => input.type === 'char')).toEqual([])
})

it('parses nonempty actual completion-observation programs without assigning the parameter or changing focus', () => {
  const start = source.indexOf("ctx.setPhase('task-assets-temporary-secret-disposal')")
  const end = source.indexOf('receipt.taskAssets.complete = true', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const completion = source.slice(start, end)
  expect(completion).toContain('Saving the inspection draft cannot change the completed v1 cursor')
  const templates = [...completion.matchAll(/probe\.cdp\.evaluate\((`[^`]*`)\)/g)]
  expect(templates).toHaveLength(2)
  const context = createContext({ quoted: JSON.stringify, taskSurface: '[aria-label="Editable Browser task asset"]' })
  for (const [_, template] of templates) {
    const expression = runInContext(template!, context) as string
    expect(expression.length).toBeGreaterThan(0)
    expect(() => new Function(expression)).not.toThrow()
    expect(expression).not.toMatch(/\.(?:value|selectedIndex)\s*=(?!=)|\.focus\s*\(|dispatchEvent\s*\(/)
  }
})
