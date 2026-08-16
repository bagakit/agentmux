import { useEffect, useState } from 'react'
import type { BrowserConfig } from '../../../../shared/contracts'

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
export function BrowserSettingsPane({ browser, onSave }: {
  browser: BrowserConfig
  onSave: (browser: BrowserConfig) => Promise<void>
}) {
  const saved = browser.agentAutomation === true
  const [enabled, setEnabled] = useState(saved)
  const [saving, setSaving] = useState(false)

  useEffect(() => setEnabled(saved), [saved])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await onSave({ ...browser, agentAutomation: enabled })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">An Agent can drive an open Browser by running a program in it — reading the page, clicking elements by name, and reading the result. It acts on the page structure, never on screen coordinates, and never by synthesizing keystrokes.</p>
      <section className="settings-group">
        <header><span>Agent automation</span><small>{saved ? 'On' : 'Off'}</small></header>
        <label className="browser-automation-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            <strong>Let Agents run programs in an open Browser</strong>
            <small>Off by default. While off, <code>agentmux browser run</code> is refused and says so rather than failing quietly. A program runs in an isolated subprocess and cannot reach your files or the rest of AgentMux, but it can do anything on the page a person could — including submitting forms and spending money on a signed-in site.</small>
          </span>
        </label>
      </section>
      <div className="settings-pane-actions">
        <span>Applies to every Browser in every workspace, including ones already open.</span>
        <button className="primary-button" disabled={saving || enabled === saved} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save browser'}
        </button>
      </div>
      <AppLinkSchemes browser={browser} onSave={onSave} />
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
function AppLinkSchemes({ browser, onSave }: {
  browser: BrowserConfig
  onSave: (browser: BrowserConfig) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const remembered = Object.entries(browser.appLinkSchemes ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (remembered.length === 0) return null

  /**
   * 忘掉一个 scheme，于是它回到「没问过」那一档，下次再问一次。
   *
   * 删的是键本身，不是写一个别的值：缺席、`'allow'`、`'deny'` 是三档，把「忘掉」写成
   * `'deny'` 会把「下次问我」变成「永远别开」——两件不一样的事。
   */
  async function forget(scheme: string): Promise<void> {
    setBusy(scheme)
    try {
      const next = { ...(browser.appLinkSchemes ?? {}) }
      delete next[scheme]
      await onSave({ ...browser, appLinkSchemes: next })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-group">
      <header><span>App links you answered</span><small>{remembered.length}</small></header>
      <p className="settings-group-note">
        Remembered per scheme, not per site — <code>lark:</code> links behave the same wherever they
        appear, because the question was about the app they open, not the page they came from.
        Forget one to be asked again the next time it comes up.
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
              onClick={() => void forget(scheme)}
            >{busy === scheme ? 'Forgetting…' : 'Forget'}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
