import { win32 as _historyWin32 } from 'node:path'
// Derive synthetic directory labels from this fixture module; only drive/UNC grammar is fixed.
function _historyWindowsFixturePath(volume: string, relative: string): string {
  const label = _historyFixturePath('windows-path-cases').split(/[\\/]/u).filter(Boolean).map(segment => segment.replace(/[<>:"|?*]/gu, '-')).join('-')
  const [head, ...tail] = relative.split('/')
  const sep = _historyWin32.sep
  const root = volume === 'unc' ? sep.repeat(2) + label + '-server' + sep + label + '-' + head + sep : volume + ':' + sep + label + '-' + head
  return _historyWin32.join(root, ...tail)
}

import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme, type ThemeDocument } from '@agentmux/client-ui/theme'
import { semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import { FilePathLabel } from '../src/renderer/src/components/FilePathLabel'
import { mountMonacoIcons } from '../src/renderer/src/lib/monaco-icons'

let host: HTMLDivElement, root: Root, releaseTheme: () => void
const cleanups: Array<() => void> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  releaseTheme = mountThemeRuntime(window, { appAppearance: 'light' })
})
afterEach(async () => {
  await act(async () => root.unmount())
  cleanups.splice(0).forEach(cleanup => cleanup())
  releaseTheme(); host.remove(); vi.restoreAllMocks()
})

const files: readonly [string, SemanticIconId][] = [
  ['LICENSE', 'file.license'], ['docs/LICENCE.md', 'file.license'], ['COPYING.txt', 'file.license'], ['NOTICE', 'file.license'],
  ['CODEOWNERS', 'file.text'], ['docs/SECURITY.md', 'file.text'],
  ['deps/custom.lock', 'file.package'], [_historyWindowsFixturePath("C", "project/.env.local"), 'file.config'],
  ['analysis.ipynb', 'file.notebook'], ['flow.mmd', 'file.diagram'],
  ['slides.ppt', 'file.presentation'], ['slides.pptx', 'file.presentation'], ['theme.css', 'file.stylesheet'],
  ['server.key', 'file.key'], ['server.pem', 'file.key'], ['server.crt', 'file.key'],
  ['client.p12', 'file.locked'], ['client.pfx', 'file.locked'], ['report.svg', 'file.image']
]
function themeWithPaths(names: readonly SemanticIconId[]): ThemeDocument {
  const theme = structuredClone(GRAPHITE_THEME)
  theme.id = 'custom.file-editor-consumers'; theme.name = 'File and editor meanings'
  theme.icons = Object.fromEntries(names.map((name, index) => [name, { kind: 'paths', paths: [{ d: `M3 ${3 + index}H20` }] }]))
  return theme
}

it('actual FilePathLabel consumers classify files independently and keep their mounted paths when the root drawing changes', async () => {
  await act(async () => root.render(<>{files.map(([path], index) => <div key={path} data-file-case={index}><FilePathLabel path={path} /></div>)}</>))
  const mounted = files.map(([path, name], index) => {
    const label = host.querySelector<HTMLElement>(`[data-file-case="${index}"] .file-path-label`)!
    expect(label, `actual nonempty file label ${path}`).not.toBeNull()
    const svg = label.querySelector('svg')!, use = svg.querySelector('use')!
    expect(use.getAttribute('href'), path).toBe(semanticIconHref(name))
    expect(svg.getAttribute('width')).toBe('13'); expect(label.title).toBe(path)
    const symbol = document.getElementById(semanticIconHref(name).slice(1))!
    expect(symbol?.children.length, `real drawing ${name}`).toBeGreaterThan(0)
    return { label, svg, use, title: label.title, text: label.textContent }
  })
  const meanings = [...new Set(files.map(([, name]) => name))]
  const theme = themeWithPaths(meanings)
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  expect(host.querySelectorAll('.file-path-label')).toHaveLength(files.length)
  files.forEach(([path, name], index) => {
    const original = mounted[index]!
    expect(host.querySelector(`[data-file-case="${index}"] .file-path-label`), path).toBe(original.label)
    expect(original.label.querySelector('svg')).toBe(original.svg)
    expect(original.svg.querySelector('use')).toBe(original.use)
    expect(original.label.title).toBe(original.title); expect(original.label.textContent).toBe(original.text)
    expect(original.use.getAttribute('href')).toBe(semanticIconHref(name))
    expect(document.getElementById(semanticIconHref(name).slice(1))?.querySelector('path')?.getAttribute('d')).toBe(theme.icons[name]?.kind === 'paths' ? theme.icons[name].paths[0]!.d : undefined)
  })
})

function maskSvg(style: HTMLStyleElement, machineId: string): Document {
  const rules = [...style.sheet!.cssRules] as CSSStyleRule[]
  const rule = rules.find(candidate => candidate.selectorText?.split(',').map(selector => selector.trim()).includes(`.monaco-editor .codicon-${machineId}::before`))
  expect(rule, `actual nonempty native CSS rule for ${machineId}`).toBeDefined()
  const mask = rule!.style.getPropertyValue('mask-image')
  const encoded = mask.match(/^url\(["']?data:image\/svg\+xml,([^"')]+)["']?\)$/)?.[1]
  expect(encoded, `actual native SVG mask for ${machineId}`).toBeDefined()
  const svg = new DOMParser().parseFromString(decodeURIComponent(encoded!), 'image/svg+xml')
  expect(svg.querySelector('svg')).not.toBeNull(); expect(svg.querySelector('parsererror')).toBeNull()
  return svg
}

it('the actual Monaco mask owner separates settings from tools and follows one root update without replacing its style', async () => {
  const release = mountMonacoIcons(window); cleanups.push(release)
  const style = document.querySelector<HTMLStyleElement>('style[data-monaco-semantic-icons]')!
  expect(style).not.toBeNull()
  expect(document.querySelectorAll('style[data-monaco-semantic-icons]')).toHaveLength(1)
  const meanings = ['object.settings', 'object.tools', 'editor.increase-verbosity', 'editor.decrease-verbosity', 'editor.snooze-suggestions', 'status.paused'] as const
  const theme = themeWithPaths(meanings)
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  const expected = new Map(meanings.map((name, index) => [name, `M3 ${3 + index}H20`]))
  for (const [machine, name] of [
    ['gear', 'object.settings'], ['tools', 'object.tools'], ['wrench', 'object.tools'],
    ['hover-increase-verbosity', 'editor.increase-verbosity'], ['hover-decrease-verbosity', 'editor.decrease-verbosity'],
    ['bell-slash', 'editor.snooze-suggestions']
  ] as const) expect(maskSvg(style, machine).querySelector('path')?.getAttribute('d'), machine).toBe(expected.get(name))
  expect(document.querySelector('style[data-monaco-semantic-icons]')).toBe(style)
  expect(document.querySelectorAll('style[data-monaco-semantic-icons]')).toHaveLength(1)
  release(); cleanups.pop()
  expect(style.isConnected).toBe(false)
  expect(document.querySelector('style[data-monaco-semantic-icons]')).toBeNull()
})
