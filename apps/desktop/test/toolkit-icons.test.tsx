// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { getSemanticIconCatalog, semanticIconHref, SEMANTIC_ICON_CATALOG } from '@agentmux/client-ui/icons'
import { TOOLKIT_ICON_OPTIONS, TOOLKIT_ICON_IDS } from '../src/shared/toolkit-preferences'
import { ToolkitIcon, toolkitIconLabels } from '../src/renderer/src/components/toolkit/ToolkitIcon'
import { ToolkitIconPicker } from '../src/renderer/src/components/toolkit/ToolkitIconPicker'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let removeTheme: () => void
beforeEach(() => { removeTheme = mountThemeRuntime(window) })
afterEach(() => removeTheme())

it('preserves saved icon meanings and exposes the static disk in the shared theme catalog', async () => {
  expect(TOOLKIT_ICON_IDS).toHaveLength(18)
  expect(new Set(TOOLKIT_ICON_IDS).size).toBe(18)
  const original = ['terminal', 'lightning', 'refresh', 'gauge', 'key', 'card', 'agent', 'sparkle', 'phone']
  expect(TOOLKIT_ICON_OPTIONS.slice(0, 9).map(option => option.semanticId)).toEqual(original.map(id => `toolkit.${id}`))
  expect(getSemanticIconCatalog().icons.find(icon => icon.id === 'object.disk')).toMatchObject({ label: 'Disk', groupId: 'object', defaultGlyph: 'hard-drive' })
  await dom.render(<div>{TOOLKIT_ICON_OPTIONS.map(option => <ToolkitIcon key={option.value} icon={option.value} data-choice={option.value} />)}</div>)
  for (const option of TOOLKIT_ICON_OPTIONS) {
    const svg = dom.container.querySelector(`[data-choice="${option.value}"]`)!
    expect(svg.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(option.semanticId))
    expect(svg.closest('[data-icon-animation]')).toBeNull()
    expect(document.getElementById(semanticIconHref(option.semanticId).slice(1))?.childElementCount).toBeGreaterThan(0)
    expect(toolkitIconLabels[option.value]).toBe(SEMANTIC_ICON_CATALOG[option.semanticId].label)
  }
  const disk = document.getElementById(semanticIconHref('object.disk').slice(1))!
  expect(disk.querySelectorAll('path, line')).toHaveLength(4)
  expect(disk.querySelector('line[x1="22"][x2="2"]')).not.toBeNull()
})

it('uses the same retained semantic sprite for picker and tool output under glyph and path overrides', async () => {
  await dom.render(<><ToolkitIconPicker icon="hard-drive" onChange={() => {}} /><ToolkitIcon icon="hard-drive" data-tool-output="disk" /><ToolkitIcon icon="terminal" data-tool-output="terminal" /></>)
  const disk = document.getElementById(semanticIconHref('object.disk').slice(1))!
  const terminal = document.getElementById(semanticIconHref('toolkit.terminal').slice(1))!
  const originalDisk = disk.innerHTML, originalTerminal = terminal.innerHTML
  const tool = dom.container.querySelector('[data-tool-output="disk"]')!
  const choice = dom.container.querySelector('input[value="hard-drive"]')!.parentElement!
  expect(choice.querySelector('use')?.getAttribute('href')).toBe(tool.querySelector('use')?.getAttribute('href'))
  for (const mode of ['dark', 'light'] as const) {
    const theme = structuredClone(GRAPHITE_THEME)
    theme.id = 'custom.toolkit-icon-proof'; theme.name = 'Toolkit semantic proof'
    theme.icons = { ...theme.icons, 'object.disk': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }, 'toolkit.terminal': { kind: 'glyph', glyph: 'x' } }
    await act(async () => { expect(previewTheme(theme, window, mode).applied).toBe(true) })
    const updatedDisk = document.getElementById(semanticIconHref('object.disk').slice(1))!
    expect(updatedDisk.innerHTML).not.toBe(originalDisk)
    expect(updatedDisk.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
    expect(document.getElementById(semanticIconHref('toolkit.terminal').slice(1))!.innerHTML).not.toBe(originalTerminal)
    expect(dom.container.querySelector('[data-tool-output="disk"]')).toBe(tool)
    expect(choice.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.disk'))
  }
})

it('filters by meaning and stable identifiers without replacing the selected draft, and returns focus on Escape', async () => {
  const changes: string[] = []
  function View() {
    const [icon, setIcon] = useState('terminal')
    return <ToolkitIconPicker icon={icon} onChange={value => { changes.push(value); setIcon(value) }} />
  }
  await dom.render(<View />)
  const picker = dom.container.querySelector<HTMLDetailsElement>('details')!, summary = picker.querySelector('summary')!
  await dom.click('summary')
  expect(picker.open).toBe(true)
  const radios = [...picker.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(radios).toHaveLength(18)
  expect(new Set(radios.map(radio => radio.name)).size).toBe(1)
  expect(radios.every(radio => radio.getAttribute('aria-label'))).toBe(true)
  async function search(query: string) {
    const input = picker.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  for (const query of ['磁盘', 'HARD-DRIVE', 'object.disk', 'Disk']) {
    await search(query)
    expect([...picker.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value)).toEqual(['hard-drive'])
    expect(picker.querySelector('.toolkit-icon-picker__current')?.textContent).toContain('Terminal')
    expect(changes).toEqual([])
  }
  await dom.click('input[value="hard-drive"]')
  expect(changes).toEqual(['hard-drive'])
  await search('no-such-meaning')
  expect(picker.querySelector('[role="status"]')?.textContent).toContain('No matching icons')
  expect(picker.querySelector('.toolkit-icon-picker__current')?.textContent).toContain('Disk')
  await search('')
  expect(picker.querySelector<HTMLInputElement>('input[value="hard-drive"]')!.checked).toBe(true)
  expect(changes).toEqual(['hard-drive'])
  await act(async () => picker.querySelector('input[type="search"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(picker.open).toBe(false)
  expect(document.activeElement).toBe(summary)
})
