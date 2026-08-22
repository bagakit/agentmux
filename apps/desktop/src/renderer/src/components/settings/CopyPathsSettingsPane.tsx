import { useEffect, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import { presentError } from '../../lib/error-presentation'

/**
 * 复制路径的表示风格：默认把当前用户家目录缩写成 `~`，可切回绝对路径。
 *
 * 用户原话：「默认是波浪线，但也可以支持用户配置这种绝对地址」，所以默认档是缩写，这个开关是 opt-out。
 * 缩写只对本机路径生效、只按真实 home 值判边界——那些约束在产路径的各处（`copy-path-display`）守，
 * 这一节只负责让用户翻这个开关。
 *
 * 本地草稿 + 单个 Save + `presentError`（同 AgentSettingsPane）：翻开关不立即落盘，Save 时才写，
 * 失败出声而不是静默。
 */
export function CopyPathsSettingsPane({ copyPathsAsAbsolute, onSave }: {
  copyPathsAsAbsolute: boolean | undefined
  onSave: (copyPathsAsAbsolute: boolean) => Promise<void>
}) {
  // 缺席 / `false` 都是默认档（缩写）；只有显式 `true` 是绝对路径档。
  const saved = copyPathsAsAbsolute === true
  const [absolute, setAbsolute] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setAbsolute(saved), [saved])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave(absolute)
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">When you copy a path, the part that is your own home directory is machine notation for both people and Agents. Abbreviating it to <code>~</code> keeps the copied text short, works in any shell, and leaves your user name out of what you paste.</p>
      <section className="settings-group">
        <header><span>Home directory in copied paths</span><small>{saved ? 'Absolute' : 'Abbreviated'}</small></header>
        <label className="browser-automation-toggle">
          <input
            type="checkbox"
            checked={absolute}
            onChange={(event) => setAbsolute(event.target.checked)}
          />
          <span>
            <strong>Copy the full absolute path instead of <code>~</code></strong>
            <small>Off by default, so a copied path reads <code>~/proj/app</code> rather than the full home path. Only your own home directory on this machine is shortened — a path under another user or on a remote host is copied in full, because <code>~</code> would then point somewhere that does not exist.</small>
          </span>
        </label>
      </section>
      <div className="settings-pane-actions">
        {error ? <span className="settings-inline-error">{error}</span> : <span>Applies to every Copy Path action — file tree, editor, tabs, and project rows.</span>}
        <button className="primary-button" disabled={saving || absolute === saved} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
