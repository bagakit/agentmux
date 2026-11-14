import { Switch, TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionField } from '../SelectionField'
import { BROWSER_NEW_PAGE_DESTINATIONS, resolveBrowserNewPagePlacement, type BrowserNewPageDestination } from '../../../../shared/browser-new-page-placement'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useId, useState } from 'react'
import type { AppLinkSchemeChoice, BrowserConfig } from '../../../../shared/contracts'
import { useSettingDraftRecord } from './use-setting-draft'
import { RetainedBrowserUploads } from './RetainedBrowserUploads'
import { ExternalBrowserConnections } from './ExternalBrowserConnections'
import { BrowserResources } from '../browser/BrowserResources'
import { useBrowserDirectory } from '../../lib/use-browser-directory'
import { usePerformanceObservation } from '../../lib/use-performance-observation'
import { api } from '../../lib/api'
import { SettingsConceptSummary } from './SettingsConceptSummary'
import './browser-settings.css'

export type BrowserPreferences = { agentAutomation: boolean; automaticMemoryRelease: boolean; exitCheckUrl: string;
  newPageSpace: BrowserNewPageDestination; newPageFocus: BrowserNewPageDestination; newPageSurvey: BrowserNewPageDestination }

const newPageFields = [
  { scene: 'space', key: 'newPageSpace', label: 'Space' },
  { scene: 'focus', key: 'newPageFocus', label: 'Focus' },
  { scene: 'survey', key: 'newPageSurvey', label: 'Survey' }
] as const
const newPageOptions = BROWSER_NEW_PAGE_DESTINATIONS.map(value => ({ value,
  label: { window: 'Window', tab: 'Tab', region: 'Region' }[value] }))

/** Matches Main's rule: https without a user name or password. Empty turns the check off. */
function validExitCheckUrl(value: string): boolean {
  if (!value) return true
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
}

/**
 * Agent 驱动浏览器的总开关。
 *
 * 这一节存在的直接理由：主进程在 `ipc.ts` 的 `browser:runScript` 闸门上拒绝时说的是
 * “Turn it on in Settings › Browser”，而在此之前 Settings 里**没有 Browser 这一节**——那句拒绝
 * 点名了一个到不了的地方。按 AGENTS.md:32-52，拒绝要给出能走通的下一步；点名一个不存在的位置
 * 比不说更糟，因为它听起来像已经存在（记忆 copy-must-name-an-action-reachable-from-this-state）。
 *
 * 只做一个开关，不做权限分级：`BrowserConfig.agentAutomation` 本身就是总开关，开了就是全套页面
 * 能力可用。在这里摆一排分项开关，会造出一份与主进程实际检查不符的第二事实源。
 */
export function BrowserSettingsPane({ browser, active, onSave, onForget }: {
  browser: BrowserConfig
  active: boolean
  onSave: (value: BrowserPreferences, expected: BrowserPreferences) => Promise<void>
  onForget: (scheme: string, expected: AppLinkSchemeChoice) => Promise<void>
}) {
  const exitCheckHintId = useId()
  const saved: BrowserPreferences = { agentAutomation: browser.agentAutomation === true, automaticMemoryRelease: browser.automaticMemoryRelease !== false, exitCheckUrl: browser.exitCheckUrl ?? '',
    newPageSpace: resolveBrowserNewPagePlacement(browser.newPagePlacement, 'space'),
    newPageFocus: resolveBrowserNewPagePlacement(browser.newPagePlacement, 'focus'),
    newPageSurvey: resolveBrowserNewPagePlacement(browser.newPagePlacement, 'survey') }
  const draft = useSettingDraftRecord(saved)
  const saveState = useSettingsSave()
  const directory = useBrowserDirectory(active)
  const observation = usePerformanceObservation(api.toolkit, active)

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return (
    <div className="settings-pane-stack settings-browser">
      <SettingsConceptSummary icon="object.browser" title="Pages, permissions and connections"
        description="Choose where websites open new pages, manage agent access and inspect browser resources." />
      <section className="settings-browser__preferences" aria-label="Browser preferences">
      <section className="settings-group" data-settings-field="new-page-placement">
        <header><span>New pages from websites</span></header>
        <div className="browser-new-page-placement">
          {newPageFields.map(field => <div key={field.scene} className="browser-new-page-placement__row" data-settings-field={`new-page-${field.scene}`}>
            <label htmlFor={`browser-new-page-${field.scene}`}>{field.label}</label>
            <SelectionField id={`browser-new-page-${field.scene}`} label={`New webpage in ${field.label}`}
              value={draft.value[field.key]} options={newPageOptions} searchable={false}
              onValueChange={value => draft.setField(field.key, value as BrowserNewPageDestination)} />
          </div>)}
          <p className="settings-browser__permission-note">Applies when a website opens a separate page. Navigation within a page stays in that page. Message and terminal links keep their Focus setting.</p>
        </div>
      </section>
      <section className="settings-group" data-settings-field="agent-automation">
        <header><span>Agent automation</span><small>Saved: {saved.agentAutomation ? 'On' : 'Off'}</small></header>
        <label className="browser-automation-toggle">
          <Switch
            checked={draft.value.agentAutomation}
            onChange={(event) => draft.setField('agentAutomation', event.target.checked)}
          />
          <span>
            <strong>Let agents interact with browser pages</strong>
            <small>Read pages, follow links and submit forms in all open browsers.</small>
          </span>
        </label>
        <p className="settings-browser__permission-note">Uses your signed-in accounts, including actions that spend money. Off by default.</p>
      </section>
      <section className="settings-group browser-resources__policy" data-settings-field="automatic-memory-release">
        <header><span>Idle pages</span><small>Saved: {saved.automaticMemoryRelease ? 'Automatic' : 'Manual'}</small></header>
        <label><Switch checked={draft.value.automaticMemoryRelease} onChange={event => draft.setField('automaticMemoryRelease', event.target.checked)} />
          <span><strong>Automatically release safe idle pages</strong><small>Reduce memory use while keeping each page in its original workspace.</small></span></label>
        <details className="browser-resources__help"><summary>What happens when I return?</summary><p>The page reloads in place. Forms and arbitrary page state are not restored; protected pages stay in use. Saving this preference does not release a page immediately.</p></details>
      </section>
      <section className="settings-group" data-settings-field="exit-check">
        <header><span>Exit check</span><small>{saved.exitCheckUrl ? 'Saved: ' + saved.exitCheckUrl : 'Off'}</small></header>
        <label className="browser-start-settings__field"><span>Check address</span>
          <TextInput aria-label="Exit check address" type="url" inputMode="url" placeholder="https://" value={draft.value.exitCheckUrl}
            aria-describedby={exitCheckHintId} aria-invalid={!validExitCheckUrl(draft.value.exitCheckUrl.trim())} onChange={event => draft.setField('exitCheckUrl', event.target.value)} /></label>
        <p id={exitCheckHintId} className="settings-browser__permission-note">{validExitCheckUrl(draft.value.exitCheckUrl.trim())
          ? 'Check in Settings › Browser Profiles sends one request to this address through that Profile, to see where its route reaches. A service that answers with just your address shows it.'
          : 'Use an https:// address without a user name or password.'}</p>
      </section>
      </section>
      <AppLinkSchemes browser={browser} onForget={onForget} />
      <BrowserResources active={active} directory={directory} app={observation.snapshot?.observation?.app} observationError={observation.error} />
      <ExternalBrowserConnections targets={directory.rows.map(row => row.target).filter(target => target.source === 'external')}
        observedIds={directory.observedIds} />
      <RetainedBrowserUploads active={active} />
      <SettingsSaveBar save={saveState} dirty={draft.dirty} resolution={draft} blocked={validExitCheckUrl(draft.value.exitCheckUrl.trim()) ? undefined : 'the exit check address must be https:// without a user name or password.'} label="Save browser" onSave={() => void save()} />
    </div>
  )
}

/**
 * 记住的应用链接选择。
 *
 * 这一节存在的理由和上面那个开关**完全同形**：`appLinkRefusedMessage` 拒绝时说的是
 * “Change that choice in Settings › Browser”，而在此之前这一节里只有自动化开关——那句话点名的
 * 位置有节无控件，用户照它走过来什么也改不了（记忆
 * copy-must-name-an-action-reachable-from-this-state；房规见 browser-automation-setting-reachable）。
 *
 * 一个都没记过时整节不渲染：摆一张空表说"这里会列出你的选择"，是在给一个尚不存在的东西留位置。
 * 用户第一次回答之后它自己出现——那时它才有内容可看。
 */
function AppLinkSchemes({ browser, onForget }: {
  browser: BrowserConfig
  onForget: (scheme: string, expected: AppLinkSchemeChoice) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const saveState = useSettingsSave()
  const remembered = Object.entries(browser.appLinkSchemes ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (remembered.length === 0) return null

  /**
   * 忘掉一个 scheme，于是它回到「没问过」那一档，下次再问一次。
   *
   * 删的是键本身，不是写一个别的值：缺席、`'allow'`、`'deny'` 是三档，把「忘掉」写成
   * `'deny'` 会把「下次问我」变成「永远别开」——两件不一样的事。
   */
  async function forget(scheme: string, expected: AppLinkSchemeChoice): Promise<void> {
    setBusy(scheme)
    try {
      await saveState.run(() => onForget(scheme, expected))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-group">
      <header><span>Remembered app links</span><small>{remembered.length}</small></header>
      <p className="settings-group-note">
        Your choices apply to each link type across all sites. Forget a choice to be asked again next time.
      </p>
      <ul className="app-link-scheme-list">
        {remembered.map(([scheme, choice]) => (
          <li key={scheme}>
            <code>{scheme}:</code>
            <span className={`app-link-scheme-choice app-link-scheme-choice--${choice}`}>
              {choice === 'allow' ? 'Opens in your system' : 'Never opened'}
            </span>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void forget(scheme, choice)}
            >{busy === scheme ? 'Forgetting…' : 'Forget'}</Button>
          </li>
        ))}
      </ul>
      {saveState.error ? <p className="settings-inline-error" role="alert">{saveState.error}</p> : null}
    </section>
  )
}
