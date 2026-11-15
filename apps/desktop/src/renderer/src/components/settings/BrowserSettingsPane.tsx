import { Switch, TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionField } from '../SelectionField'
import { BROWSER_NEW_PAGE_DESTINATIONS, resolveBrowserNewPagePlacement, type BrowserNewPageDestination } from '../../../../shared/browser-new-page-placement'
import { BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT, validBrowserProfileExitCheckUrl } from '../../../../shared/browser-profile-exit-check-url'
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
import { SettingsDisclosure } from './SettingsDisclosure'
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
  const exitCheckValid = validBrowserProfileExitCheckUrl(draft.value.exitCheckUrl.trim())
  const exitCheckHint = `Use an https:// address of up to ${BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT} characters without a user name or password.`

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return (
    <div className="settings-pane-stack settings-preference-surface settings-browser">
      <section className="settings-browser__preferences" aria-label="Browser preferences">
      <section className="settings-group" data-settings-field="new-page-placement">
        <header><span>New pages from websites</span></header>
        <p className="settings-browser__note">Choose where a website opens a separate page. Region opens a split within the current tab.</p>
        <div className="browser-new-page-placement">
          {newPageFields.map(field => <div key={field.scene} className="browser-new-page-placement__row" data-settings-field={`new-page-${field.scene}`}>
            <label htmlFor={`browser-new-page-${field.scene}`}>{field.label}</label>
            <SelectionField id={`browser-new-page-${field.scene}`} label={`New webpage in ${field.label}`}
              value={draft.value[field.key]} options={newPageOptions} searchable={false}
              onValueChange={value => draft.setField(field.key, value as BrowserNewPageDestination)} />
          </div>)}
        </div>
      </section>
      <section className="settings-group">
        <header><span>Idle pages</span>{draft.value.automaticMemoryRelease !== saved.automaticMemoryRelease ? <small>Saved: {saved.automaticMemoryRelease ? 'Automatic' : 'Manual'}</small> : null}</header>
        <label className="settings-browser__toggle" data-settings-field="automatic-memory-release">
          <span><strong>Automatically release safe idle pages</strong><small>Reduce memory use while keeping each page in its original workspace.</small></span>
          <Switch aria-label="Automatically release safe idle pages" checked={draft.value.automaticMemoryRelease} onChange={event => draft.setField('automaticMemoryRelease', event.target.checked)} />
        </label>
        <details className="settings-browser__help"><summary>What happens when I return?</summary><p>The page reloads in place. Forms and page state can be lost. Protected pages stay in use, and saving this preference does not release a page immediately.</p></details>
      </section>
      <section className="settings-group">
        <header><span>Agent access</span><small>Saved: {saved.agentAutomation ? 'On' : 'Off'}</small></header>
        <label className="settings-browser__toggle" data-settings-field="agent-automation">
          <span><strong>Let agents interact with browser pages</strong>
            <small>Agents can use your signed-in accounts to read pages and submit forms, including actions that spend money. Each Profile can restrict this access.</small></span>
          <Switch aria-label="Let agents interact with browser pages" checked={draft.value.agentAutomation}
            onChange={event => draft.setField('agentAutomation', event.target.checked)} />
        </label>
      </section>
      <SettingsDisclosure title="Network check" description="Optional address for testing a Profile’s connection.">
        <label className="browser-start-settings__field settings-browser__exit" data-settings-field="exit-check"><span>Check address</span>
          <TextInput aria-label="Exit check address" type="url" inputMode="url" placeholder="https://" value={draft.value.exitCheckUrl}
            aria-describedby={exitCheckHintId} aria-invalid={!exitCheckValid} onChange={event => draft.setField('exitCheckUrl', event.target.value)} /></label>
        <p id={exitCheckHintId} className="settings-browser__note">{exitCheckValid
          ? 'Run the check from Browser Profiles. It sends one request through that Profile and can display the exit IP if the service returns it.'
          : exitCheckHint}</p>
        {draft.value.exitCheckUrl !== saved.exitCheckUrl ? <p className="settings-browser__note">Saved: {saved.exitCheckUrl || 'Off'}</p> : null}
      </SettingsDisclosure>
      <SettingsSaveBar save={saveState} dirty={draft.dirty} resolution={draft} scopeLabel="Browser preferences" blocked={exitCheckValid ? undefined : exitCheckHint} label="Save browser" onSave={() => void save()} />
      </section>
      <AppLinkSchemes browser={browser} onForget={onForget} />
      <BrowserManagementSettings active={active} />
    </div>
  )
}

function BrowserManagementSettings({ active }: { active: boolean }) {
  const [managementOpen, setManagementOpen] = useState(false)
  const observing = active && managementOpen
  const directory = useBrowserDirectory(observing)
  const observation = usePerformanceObservation(api.toolkit, observing)
  return <SettingsDisclosure title="Browser management" description="Inspect open pages, shared tabs and selected files." onOpenChange={setManagementOpen}>
    <BrowserResources active={observing} directory={directory} app={observation.snapshot?.observation?.app} observationError={observation.error} />
    <ExternalBrowserConnections targets={directory.rows.map(row => row.target).filter(target => target.source === 'external')}
      observedIds={directory.observedIds} />
    <RetainedBrowserUploads active={observing} />
  </SettingsDisclosure>
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
