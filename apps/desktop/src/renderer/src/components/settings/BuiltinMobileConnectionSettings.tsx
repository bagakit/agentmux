import { LockKeyhole, Smartphone } from 'lucide-react'
import { useContext, useId, useState } from 'react'
import { MOBILE_CONNECTION_STATUS_BAR_IDS, type MobileConnectionPreferences } from '../../../../shared/toolkit-preferences'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SettingsNavigation } from '../SettingsNavigation'
import { MOBILE_CONNECTION_TOOL_ID } from '../../../../shared/toolkit-preferences'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'

export function BuiltinMobileConnectionSettings({ preferences, active, onSave }: {
  preferences: MobileConnectionPreferences
  active: boolean
  onSave(value: MobileConnectionPreferences, expected: MobileConnectionPreferences): Promise<void>
}) {
  const id = useId()
  const navigation = useContext(SettingsNavigation)
  const [source, setSource] = useState(''), [sourceError, setSourceError] = useState('')
  const draft = useSettingDraftRecord(preferences)
  const save = useSettingsSave()
  async function submit() {
    const submitted = draft.beginSave()
    const committed = await save.run(() => onSave(submitted.value, submitted.expected))
    submitted.finish(committed)
  }
  return <div className="settings-pane-stack toolkit-settings settings-devices-pane">
    <section className="toolkit-settings__tool" aria-label="手机连接工具">
      <div className="toolkit-settings__identity">
        <span className="toolkit-settings__icon"><Smartphone size={24} strokeWidth={1.5} /></span>
        <div><span className="toolkit-settings__eyebrow">Built-in toolkit</span><h3>手机连接</h3><p>官方工具扩展 · 生成连接链接，查询设备状态。</p></div>
      </div>
      <div className="toolkit-settings__preview" aria-label="手机连接状态栏预览"><span>Workspace · Settings</span><span className="toolkit-settings__preview-tool" data-enabled={draft.value.enabled}><Smartphone size={15} />{draft.value.statusBar === 'label' && <span>手机连接</span>}</span></div>
      <label className="toolkit-settings__toggle"><span><strong>在状态栏显示手机连接</strong><small>右下角快速连接和查询状态。隐藏入口不会撤销已有授权。</small></span><input type="checkbox" checked={draft.value.enabled} onChange={event => draft.setField('enabled', event.target.checked)} /></label>
      <fieldset className="toolkit-settings__layout"><legend>状态栏显示</legend><div className="toolkit-settings__choices">
        <LiquidSelectionSurface selected={draft.value.statusBar} active={active} targetAttribute="data-settings-target" />
        {MOBILE_CONNECTION_STATUS_BAR_IDS.map(value => <label key={value} data-settings-target={value} data-selected={draft.value.statusBar === value}><input type="radio" name={`${id}-layout`} value={value} checked={draft.value.statusBar === value} onChange={() => draft.setField('statusBar', value)} /><Smartphone size={16} />{value === 'icon' ? '图标' : '图标与名称'}</label>)}
      </div></fieldset>
      <p className="toolkit-settings__locked"><LockKeyhole size={13} /><span>官方工具 · 连接与授权由本机 Host 管理。</span></p>
    </section>
    <SettingsSaveBar save={save} dirty={draft.dirty} label="保存手机连接显示" onSave={() => void submit()} />
    <section className="settings-group"><h3>工具内容</h3><p className="settings-hint">随应用交付的只读脚本。连接链接和设备查询通过公共 API 执行，结果保留在同一 Toolkit 记录中。</p><div className="settings-pane-toolbar"><button className="small-button" onClick={() => { void api.toolkit.script(MOBILE_CONNECTION_TOOL_ID).then(value => { setSource(value.text); setSourceError('') }).catch(cause => setSourceError(presentError(cause))) }}>查看官方脚本</button><button className="small-button" onClick={() => navigation?.open('devices')}>连接手机与管理设备</button></div>{source && <textarea className="toolkit-result__script" aria-label="官方手机连接脚本" value={source} readOnly />}{sourceError && <p role="status">{sourceError}</p>}</section>
  </div>
}
