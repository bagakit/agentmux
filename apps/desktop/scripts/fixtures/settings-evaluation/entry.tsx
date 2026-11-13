import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '@desktop/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '@desktop/renderer/src/components/DesktopClientUiProvider'
import { DocumentationNavigation } from '@desktop/renderer/src/components/documentation/DocumentationNavigation'
import { useAppStore } from '@desktop/renderer/src/store'
import { api } from '@desktop/renderer/src/lib/api'
import { settingsModules } from '@desktop/renderer/src/components/settings/settings-modules'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '@desktop/renderer/src/styles/index.css'

const config = await api.config.get()
useAppStore.setState({ config, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
class CaptureBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { errors.push(error.message) }
  render() { return this.state.failed ? <p data-capture-failed>Settings render failed.</p> : this.props.children }
}

function show(section: string) {
  errors.length = 0
  flushSync(() => root.render(<CaptureBoundary key={section}>
    <DocumentationNavigation.Provider value={{ open() {} } as never}>
      <DesktopClientUiProvider><SettingsPanel initialSection={section as never} onClose={() => {}} /></DesktopClientUiProvider>
    </DocumentationNavigation.Provider>
  </CaptureBoundary>))
}

function measure(section: string) {
  if (errors.length || document.querySelector('[data-capture-failed]')) throw new Error(errors.join('\n') || 'The Settings editor failed to render.')
  const pane = [...document.querySelectorAll<HTMLElement>('[data-settings-pane]')].find(element => element.dataset.settingsPane === section && !element.hidden)
  if (!pane) throw new Error(`The real SettingsPanel did not mount ${section}.`)
  pane.scrollTop = 0
  const visible = (element: Element) => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
  const rect = pane.getBoundingClientRect()
  const control = [...pane.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea, button, [role=switch], [role=radio], [contenteditable=true]')]
    .filter(element => visible(element) && !element.matches(':disabled, [aria-disabled=true]'))
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0]
  const introductions = [...pane.querySelectorAll<HTMLElement>('.settings-concept-intro, .mote-origin')].filter(visible)
    .filter(element => !element.parentElement?.closest('.settings-concept-intro, .mote-origin'))
    .map(element => ({ className: element.className, height: Math.round(element.getBoundingClientRect().height) }))
  const excluded = 'code, pre, textarea, [contenteditable=true], [aria-hidden=true]'
  const diagnostics = '[role=alert], .settings-inline-error, [data-diagnostics], .settings-diagnostics, .settings-resource-error'
  const cjk: { text: string; count: number }[] = [], jargon: { text: string; terms: string[] }[] = []
  const bodyFontSizes = new Set<number>(), smallBody: { text: string; size: number; minimum: number }[] = []
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement!, text = node.textContent?.trim() ?? ''
    if (!text || !visible(parent) || parent.closest(excluded)) continue
    const chars = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
    if (chars) cjk.push({ text: text.slice(0, 240), count: chars.length })
    if (!parent.closest(diagnostics)) {
      const terms = text.match(/\b(?:owner|Core|Runtime|retained|unconfirmed)\b/g)
      if (terms) jargon.push({ text: text.slice(0, 240), terms })
    }
  }
  const bodyToken = Number.parseFloat(getComputedStyle(pane).getPropertyValue('--fs-body'))
  if (!Number.isFinite(bodyToken)) throw new Error('The real body font token could not be measured.')
  const paragraphs = [...pane.querySelectorAll<HTMLElement>('p, h3, h4, h5, dd, li')].filter(element => visible(element) && !element.closest(excluded + ', ' + diagnostics))
  for (const element of paragraphs) {
    const text = element.innerText.trim(), size = Number.parseFloat(getComputedStyle(element).fontSize)
    if (!text || !Number.isFinite(size)) continue
    bodyFontSizes.add(Math.round(size * 10) / 10)
    if (!element.matches('h3,h4,h5') && text.length >= 40 && size + .1 < bodyToken) smallBody.push({ text: text.slice(0, 240), size, minimum: bodyToken })
  }
  return {
    textLength: pane.innerText.trim().length, clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight,
    firstControl: control ? { top: Math.round(control.getBoundingClientRect().top - rect.top), name: control.getAttribute('aria-label') || control.textContent?.trim().slice(0, 100) || control.id || control.tagName.toLowerCase() } : null,
    introductions, introductionHeight: introductions.reduce((sum, intro) => sum + intro.height, 0),
    bodyFontSizes: [...bodyFontSizes].sort((a, b) => a - b), bodyToken, smallBody, cjk, jargon,
    saveBars: [...pane.querySelectorAll<HTMLElement>('[data-settings-save-bar]')].filter(visible).map(element => ({
      text: element.innerText.trim(), blocked: element.hasAttribute('data-settings-save-blocked'),
      hasAlert: Boolean(element.querySelector('[role=alert]')), disabled: Boolean(element.querySelector('button:disabled'))
    })),
    overflowX: document.documentElement.scrollWidth > window.innerWidth || pane.scrollWidth > pane.clientWidth + 1
  }
}

show('profile')
Object.assign(window, { settingsEvaluation: {
  registered: settingsModules.map(({ id, group, title, archetype }) => ({ id, group, title, archetype })), show, measure,
  appearance: (mode: 'dark' | 'light') => updateThemeSelection({ ...config.appearance, appAppearance: mode })
} })
