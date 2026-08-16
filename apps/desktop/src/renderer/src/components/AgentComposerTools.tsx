import { useState } from 'react'
import { Camera, LoaderCircle } from 'lucide-react'
import type { AgentCatalogEntry, AgentSkill } from '@agentmux/core'
import { presentError } from '../lib/error-presentation'
import * as DropdownMenu from './HoverDropdownMenu'
import { SemanticIcon } from './semantic-icons'

type ToolDockPhase = 'current' | 'collapsed' | 'restored' | 'expanded'

/**
 * 三态循环。改变的是**输入区自身的形态**，不是「露出更多工具」——后者是这枚键此前的语义，
 * 用户明确否掉了（设计 SSOT：agentmux-desktop-interaction.md「Message Tools 三态」）：
 *   collapsed = 收起成一行（工具整排隐藏，只留这枚键与主动作）
 *   current / restored = 两行常态（输入行 + 一排工具）
 *   expanded = 大输入框（输入区放高供长文编辑，工具排仍在）
 * 形态由 `.composer` 上按 data-mode 命中的 CSS 承担（composer.css），组件只报当前档位——
 * 三态是这枚键的**唯一**入口，绝对定位的第二个 disclosure 已废止。
 */
export function nextToolDockPhase(phase: ToolDockPhase): ToolDockPhase {
  switch (phase) {
    case 'current': return 'collapsed'
    case 'collapsed': return 'restored'
    case 'restored': return 'expanded'
    case 'expanded': return 'collapsed'
  }
}

/** 下一次点击会把输入区变成什么形态——按钮的可访问名说的是这件事，而不是当前档位。 */
const NEXT_SHAPE: Record<ToolDockPhase, string> = {
  current: 'Collapse the composer to one line',
  collapsed: 'Show the message tool row',
  restored: 'Grow the input box for long text',
  expanded: 'Collapse the composer to one line'
}

export function AgentComposerTools({ disabled, commands, loadSkills, onChooseSkill, onCommand, onCapture, reportError }: {
  disabled: boolean
  commands: NonNullable<AgentCatalogEntry['composer']>['commands']
  loadSkills(): Promise<AgentSkill[]>
  onChooseSkill(skill: AgentSkill): void
  onCommand(text: string): void
  onCapture?: () => Promise<void>
  reportError(error: unknown): void
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  // 静息即一行（interaction SSOT「Composer 静息形态与主操作」：用户「一上来是一行」）。默认档位就是
  // collapsed——两行与大输入框是用户主动点出来的档位，不是默认。`current`（两行常态）从此不再是初始档位，
  // 循环 collapsed→restored→expanded→collapsed 会经由 restored 回到两行常态，两者视觉同为 mode='current'。
  const [phase, setPhase] = useState<ToolDockPhase>('collapsed')
  const mode = phase === 'collapsed' ? 'collapsed' : phase === 'expanded' ? 'expanded' : 'current'
  return <span className="composer-tools" data-mode={mode}>
    <button type="button" className="composer-tool composer-tool--mode" disabled={disabled}
      aria-label={NEXT_SHAPE[phase]}
      title={NEXT_SHAPE[phase]}
      onClick={() => setPhase(nextToolDockPhase)}><SemanticIcon name="message-tools" size={14} /></button>
    {mode === 'collapsed' ? null : <>
    {onCapture ? <button type="button" className="composer-tool" disabled={disabled || capturing}
      title="Capture a screen region" onClick={() => {
        setCapturing(true)
        void onCapture().catch(reportError).finally(() => setCapturing(false))
      }}>{capturing ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />} Capture</button> : null}
    <DropdownMenu.Root onOpenChange={(open) => {
      // Opening the menu triggers discovery; discoverAgentSkills memoizes on the skill roots' mtimes, so
      // a re-open with unchanged folders is served from cache — the "同一份结果不得反复重算" constraint
      // (design SSOT) is met at the discovery layer, which is the only layer that can tell whether the
      // folders actually changed. This component cannot: its inputs (workspace/provider) mutate in place
      // in the launcher without a remount, so per-open caching here would show a stale set after a switch.
      if (!open) return
      setLoading(true); setError('')
      void loadSkills().then(setSkills).catch((cause) => {
        setError(presentError(cause))
      }).finally(() => setLoading(false))
    }}>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled}><SemanticIcon name="skill" size={14} /> Skills</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        <DropdownMenu.Label className="composer-menu__hint">Choose a skill to reference</DropdownMenu.Label>
        {loading ? <div className="composer-menu__hint">Loading skills…</div> : error ? <div className="composer-menu__hint" role="status">{error}</div> : skills.length === 0 ? <div className="composer-menu__hint">No skills found in this Agent’s skill folders.</div> : skills.map((skill) =>
          <DropdownMenu.Item key={skill.path} className="tab-context-menu__item composer-menu__item" title={`${skill.description}\n${skill.path}`} onSelect={() => onChooseSkill(skill)}>
            <SemanticIcon name={/(^|[\\/])components?([\\/]|$)/i.test(skill.path) ? 'component' : 'skill'} size={13} /><span>{skill.name}<small>{skill.source} · {skill.description || skill.path}</small></span>
          </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {commands.length ? <DropdownMenu.Root>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled}><SemanticIcon name="subcommand" size={14} /> Commands</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        {commands.map((command) => <DropdownMenu.Item key={command.text} className="tab-context-menu__item composer-menu__item" onSelect={() => onCommand(command.text)}>
          <SemanticIcon name="subcommand" size={13} /><span>{command.text}<small>{command.description}</small></span>
        </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : null}
    </>}
  </span>
}
