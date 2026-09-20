import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useState } from 'react'
import type { AppLinkSchemeChoice, BrowserConfig } from '../../../../shared/contracts'
import { useSettingDraft } from './use-setting-draft'

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
export function BrowserSettingsPane({ browser, onSave, onForget }: {
  browser: BrowserConfig
  onSave: (enabled: boolean, expected: boolean) => Promise<void>
  onForget: (scheme: string, expected: AppLinkSchemeChoice) => Promise<void>
}) {
  const saved = browser.agentAutomation === true
  const draft = useSettingDraft(saved)
  const saveState = useSettingsSave()

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">Let agents work alongside you on the web. Choose whether they can read and act on pages in your open browsers.</p>
      <section className="settings-group">
        <header><span>Agent automation</span><small>Saved: {saved ? 'On' : 'Off'}</small></header>
        <label className="browser-automation-toggle">
          <input
            type="checkbox"
            checked={draft.value}
            onChange={(event) => draft.setValue(event.target.checked)}
          />
          <span>
            <strong>Let agents interact with browser pages</strong>
            <small>Off by default. When enabled, agents can read pages, follow links and submit forms using your signed-in accounts, including actions that spend money. This applies to all open browsers.</small>
          </span>
        </label>
      </section>
      <AppLinkSchemes browser={browser} onForget={onForget} />
      <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save browser" onSave={() => void save()} />
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
            <button
              className="small-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void forget(scheme, choice)}
            >{busy === scheme ? 'Forgetting…' : 'Forget'}</button>
          </li>
        ))}
      </ul>
      {saveState.error ? <p className="settings-inline-error" role="alert">{saveState.error}</p> : null}
    </section>
  )
}
