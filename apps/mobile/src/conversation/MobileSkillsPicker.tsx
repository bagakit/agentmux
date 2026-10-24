import { useEffect, useRef, useState } from 'react'
import type { AgentMuxAgentSession, AgentSkill } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { encodeSemanticReference, semanticReferenceKind, semanticReferenceLabel } from '@agentmux/client-ui/composer-semantic-reference'
import { TextInput } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { ComposerToolMenu } from '@agentmux/client-ui/components/ComposerToolMenu'

/** A demand-driven reader of the original Session's public skill discovery. */
export function MobileSkillsPicker({ client, session, scope, connected, visible, onSelect }: {
  client: AgentMuxHostedClient | null; session: AgentMuxAgentSession | null; scope: string
  connected: boolean; visible: boolean; onSelect(item: ComposerSuggestion): void
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [retry, setRetry] = useState(0)
  const [reading, setReading] = useState<{ client: AgentMuxHostedClient | null; scope: string; skills: AgentSkill[]; loading: boolean; issue: string }>({ client: null, scope: '', skills: [], loading: false, issue: '' })
  const current = useRef({ client, scope, visible }); current.current = { client, scope, visible }
  useEffect(() => { setOpen(false); setQuery('') }, [client, scope, visible])
  useEffect(() => {
    if (!open || !visible) return
    let active = true
    const original = { client, scope }
    const isCurrent = () => active && current.current.client === original.client && current.current.scope === original.scope && current.current.visible
    const previousSkills = (value: typeof reading) => value.client === client && value.scope === scope ? value.skills : []
    setReading(value => ({ client, scope, skills: previousSkills(value), loading: true, issue: '' }))
    void (async () => {
      try {
        if (!client?.forwardRpc || !session || !connected) throw new Error('原 Host 的 Skills 读取暂不可用；原草稿仍可编辑，可重试读取。')
        const page = await client.forwardRpc('skill.ls', { hostId: 'local', agentSessionId: session.agentSessionId })
        if (page.agentSessionId !== session.agentSessionId || page.hostId !== 'local' || page.sourceHostId !== session.hostId ||
          page.providerId !== session.providerId || page.workspacePath !== session.workspacePath) throw new Error('返回的 Skills 不属于原 Agent 与工作区；原草稿保留。')
        if (isCurrent()) setReading({ client, scope, skills: page.skills, loading: false, issue: '' })
      } catch (error) {
        if (isCurrent()) setReading(value => ({ client, scope, skills: previousSkills(value), loading: false,
          issue: `Skills 读取未确认：${error instanceof Error ? error.message : String(error)}` }))
      }
    })()
    return () => { active = false }
  }, [client, session?.agentSessionId, session?.hostId, session?.providerId, session?.workspacePath, scope, connected, visible, open, retry])
  const own = reading.client === client && reading.scope === scope ? reading : null
  const matching = (own?.skills ?? []).filter(skill => `${skill.name} ${skill.description} ${skill.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <ComposerToolMenu open={open && visible} onOpenChange={setOpen} label="Skills" className="mobile-posture-menu mobile-command-menu" trigger={
    <button type="button" className="composer-tool" aria-label="选择 Skill" aria-expanded={open}>
      <SemanticIcon name="object.skill" size={14} /><span className="composer-tool__label">Skills</span>
    </button>}>
      <TextInput value={query} onChange={event => setQuery(event.target.value)} placeholder="查找 Skills…" aria-label="查找 Skills" />
      {own?.issue && <p className="mobile-command-menu__empty" role="status">{own.issue}<button type="button" onClick={() => setRetry(value => value + 1)}>重试读取 Skills</button></p>}
      <div className="mobile-command-menu__list">{matching.map(skill => <button key={`${skill.source}:${skill.path}`} type="button" role="menuitem" className="mobile-posture-menu__item"
        onClick={() => {
          const kind = semanticReferenceKind(skill.path)
          onSelect({ id: `skill:${skill.source}:${skill.path}`, text: `$${skill.name}`, label: skill.name, description: skill.description,
            insertText: encodeSemanticReference({ token: `$${skill.name}`, label: semanticReferenceLabel(skill.name), kind,
              reference: kind === 'subcommand' ? skill.path : `@${skill.path}` }) })
          setOpen(false); setQuery('')
        }}><strong>{skill.name}</strong><small>{skill.description || skill.path}</small></button>)}</div>
      {own?.loading ? <p className="mobile-command-menu__empty" role="status">读取原工作区 Skills…</p> : !own?.issue && !matching.length && <p className="mobile-command-menu__empty" role="status">{query ? '无匹配 Skill' : '原 Provider 目录中未发现 Skill'}</p>}
  </ComposerToolMenu>
}
