import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import type { AppConfig } from '../../../../shared/contracts'

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
  onSave: (copyPathsAsAbsolute: boolean, expected: boolean) => Promise<void>
}) {
  // 缺席 / `false` 都是默认档（缩写）；只有显式 `true` 是绝对路径档。
  const saved = copyPathsAsAbsolute === true
  const draft = useSettingDraft(saved)
  const absolute = draft.value, setAbsolute = draft.setValue
  const saveState = useSettingsSave()


  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">Choose how file paths look when you copy them. Use <code>~</code> for shorter local paths, or keep the full address.</p>
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
            <small>By default, <code>proj/app</code> abbreviates your own home directory. Remote paths and paths belonging to another user always stay complete. Applies to every Copy Path action.</small>
          </span>
        </label>
      </section>
      <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save" onSave={() => void save()} />
    </div>
  )
}
