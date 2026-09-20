import { ChevronDown, Plus, Trash2 } from 'lucide-react'
// 走 `/provider-id` 窄子路径而不是根 barrel：这是 renderer 里少有的对 core 的**值**导入（别处都是
// `import type`，编译期就擦掉了）。根 barrel 会 re-export `agent-native-locator.js`，那个文件 import
// `node:path`，于是 renderer 打包时 rollup 报「"isAbsolute" is not exported by __vite-browser-external」。
// vitest 与 tsc 都不会报——只有真正打 renderer 的那一步会。同文件的 SettingsPanel.tsx 取同一个符号也走这条。
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import type { AppConfig, ComposerShortcut } from '../../../../shared/contracts'
import { resolveComposerShortcuts } from '../../../../shared/composer-shortcut-library'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { ComposerTextarea } from '../ComposerTextarea'
import { agentProviderLabel } from '../AgentProviderIcon'
import { useResourceDrafts } from './use-resource-drafts'

/**
 * 本地 prompt 库的设置页。
 *
 * 这一族此前写死在渲染层代码里（两条 `COMPOSER_SHORTCUT_PRESETS`），于是「快捷指令」有两套而用户
 * 一条都改不了。用户的判断是「应该只有一套，而且配置页面要支持用户自定义」——所以正文归用户，
 * 内置那两条只是 `DEFAULT_CONFIG` 里的默认项，可改可删，删掉即永久没有。
 *
 * 草稿模式（本地 state + 一次 Save）照 AgentSettingsPane 走：逐字保存会在用户还在打字时把半句正文
 * 写上盘，而 keyword 半途的状态可能与另一条撞名。
 */
export function ShortcutSettingsPane({ config, onSave }: {
  config: AppConfig
  onSave: (prompts: ComposerShortcut[], expected: ComposerShortcut[]) => Promise<void>
}) {
  const resource = useResourceDrafts(Object.fromEntries(resolveComposerShortcuts(config).map((prompt) => [prompt.id, prompt])))
  const drafts = Object.values(resource.value)
  const setDrafts = (update: (current: ComposerShortcut[]) => ComposerShortcut[]) => resource.setValue((current) =>
    Object.fromEntries(update(Object.values(current)).map((prompt) => [prompt.id, prompt])))
  const saveState = useSettingsSave()
  const dirty = resource.dirty

  function update(id: string, patch: Partial<ComposerShortcut>): void {
    setDrafts((current) => current.map((prompt) => prompt.id === id ? { ...prompt, ...patch } : prompt))
  }

  /**
   * 绑定/解绑 Provider。解绑必须**删掉这个 key**，不是把它设成 undefined——`exactOptionalPropertyTypes`
   * 下后者根本不合法，而语义上也只有「缺席」才表示通用（取值层按 `providerId === undefined` 判）。
   * 存一个空串会让这条 prompt 既不通用、也匹配不上任何 Provider，成为一条谁都看不见的 prompt。
   */
  function bindProvider(id: string, providerId: string): void {
    setDrafts((current) => current.map((prompt) => {
      if (prompt.id !== id) return prompt
      const { providerId: _dropped, ...rest } = prompt
      return providerId ? { ...rest, providerId } : rest
    }))
  }

  function add(): void {
    // id 只需在本库内唯一且稳定，不面向用户——所以用时间戳而不是让用户填一个。keyword 留空由
    // 下面那条校验挡住：一条没有 keyword 的 prompt 既补全不了也识别不了裸词。
    setDrafts((current) => [...current, { id: `prompt-${Date.now()}`, keyword: '', label: '', body: '' }])
  }

  // 两个都是「存下来也不会工作」的形状，所以在保存前拦住而不是让 zod 在主进程里整块判失败：
  // 那样用户看到的是一条关于配置文件的错误，而问题其实是这一行少填了一格。
  const blank = drafts.filter((prompt) => !prompt.keyword.trim() || !prompt.body.trim())
  const duplicated = drafts.filter((prompt, index) =>
    drafts.findIndex((other) => other.keyword.trim() === prompt.keyword.trim()) !== index)
  const problem = blank.length > 0
    ? 'Every prompt needs a keyword and a body — one without either would never fire.'
    : duplicated.length > 0
      ? `Two prompts share the keyword “${duplicated[0]!.keyword.trim()}”. Typing it could only ever reach one of them.`
      : ''

  async function save(): Promise<void> {
    const submitted = resource.beginSave()
    const normalized = Object.values(submitted.value).map((prompt) => ({
      ...prompt,
      keyword: prompt.keyword.trim(),
      label: prompt.label.trim() || prompt.keyword.trim(),
      body: prompt.body
    }))
    const committed = await saveState.run(() => onSave(normalized, Object.values(submitted.expected)))
    submitted.finish(committed ? Object.fromEntries(normalized.map((prompt) => [prompt.id, prompt])) : undefined)
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">Type <code>/</code> to choose one in the composer, or use its keyword in your draft. You decide what to send.</p>
      <div className="settings-pane-toolbar">
        <button className="small-button" onClick={add}><Plus size={13} /> Add prompt</button>
      </div>
      <div className="agent-settings-list">
        {drafts.map((prompt) => (
          <details className="agent-settings-card prompt-settings-card" key={prompt.id}>
            <summary>
              <span><strong>{prompt.label.trim() || prompt.keyword.trim() || 'Untitled prompt'}</strong><small>{prompt.keyword.trim() ? `/${prompt.keyword.trim()}` : 'No keyword yet'}{prompt.providerId ? ` · ${agentProviderLabel(prompt.providerId)} only` : ''}</small></span>
              <ChevronDown className="settings-disclosure-icon" size={14} />
            </summary>
            <div className="agent-settings-fields">
              <label><span>Keyword</span><input value={prompt.keyword} onChange={(event) => update(prompt.id, { keyword: event.target.value })} placeholder="eli5" /><small>Both the <code>/</code> candidate and the bare word underlined in your message.</small></label>
              <label><span>Name</span><input value={prompt.label} onChange={(event) => update(prompt.id, { label: event.target.value })} placeholder="Explain simply" /></label>
              <label>
                <span>Agent</span>
                <select
                  value={prompt.providerId ?? ''}
                  onChange={(event) => bindProvider(prompt.id, event.target.value)}
                >
                  <option value="">Every Agent</option>
                  {BUILT_IN_AGENT_PROVIDER_IDS.map((id) => <option key={id} value={id}>{agentProviderLabel(id)}</option>)}
                  {prompt.providerId && !BUILT_IN_AGENT_PROVIDER_IDS.some((id) => id === prompt.providerId)
                    ? <option value={prompt.providerId}>{agentProviderLabel(prompt.providerId)}</option>
                    : null}
                </select>
                <small>Leave this on Every Agent unless the wording only makes sense for one of them.</small>
              </label>
              <label><span>Prompt</span><ComposerTextarea value={prompt.body} onValueChange={(value) => update(prompt.id, { body: value })} placeholder="Explain this like I am five, then name what the simplification leaves out." rows={5} /></label>
              <button type="button" className="small-button" onClick={() => setDrafts((current) => current.filter((candidate) => candidate.id !== prompt.id))}><Trash2 size={13} /> Delete prompt</button>
            </div>
          </details>
        ))}
      </div>
      {drafts.length === 0 ? <div className="agent-catalog__empty">No prompts. Add one, or leave this empty — the composer just won’t offer any.</div> : null}
      {problem ? <p className="settings-inline-error">{problem}</p> : null}
      <SettingsSaveBar save={saveState} dirty={dirty} disabled={problem !== ''} label="Save prompts" onSave={() => void save()} />
    </div>
  )
}
