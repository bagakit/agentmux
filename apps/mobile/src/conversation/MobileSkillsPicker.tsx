import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxAgentSession, AgentSkill } from '@agentmux/core'
import type { MobileConversationClient } from './mobile-conversation-client'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { encodeSemanticReference, semanticReferenceKind, semanticReferenceLabel } from '@agentmux/client-ui/composer-semantic-reference'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { SearchChoiceDialog } from '@agentmux/client-ui/components/SearchChoiceDialog'

/** A demand-driven reader of the original Session's public skill discovery. */
export function MobileSkillsPicker({ client, session, agentSessionId, scope, connected, visible, onSelect }: {
  client: MobileConversationClient | null; session: AgentMuxAgentSession | null; scope: string
  agentSessionId?: string | null
  connected: boolean; visible: boolean; onSelect(item: ComposerSuggestion): void
}) {
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0)
  const [reading, setReading] = useState<{ client: MobileConversationClient | null; scope: string; skills: AgentSkill[]; loading: boolean; issue: string }>({ client: null, scope: '', skills: [], loading: false, issue: '' })
  const current = useRef({ client, scope, visible }); current.current = { client, scope, visible }
  useEffect(() => { setOpen(false) }, [client, scope, visible])
  useEffect(() => {
    if (!open || !visible) return
    let active = true
    const original = { client, scope }
    const isCurrent = () => active && current.current.client === original.client && current.current.scope === original.scope && current.current.visible
    const previousSkills = (value: typeof reading) => value.client === client && value.scope === scope ? value.skills : []
    setReading(value => ({ client, scope, skills: previousSkills(value), loading: true, issue: '' }))
    void (async () => {
      try {
        const id = session?.agentSessionId ?? agentSessionId
        if (!client?.forwardRpc || !id || !connected) throw new Error('暂时读不到 Mac 上的 Skills，可以重试。草稿仍可编辑。')
        const page = await client.forwardRpc('skill.ls', { hostId: 'local', agentSessionId: id })
        if (page.agentSessionId !== id || page.hostId !== 'local' || session && (page.sourceHostId !== session.hostId ||
          page.providerId !== session.providerId || page.workspacePath !== session.workspacePath)) throw new Error('返回的 Skills 不属于这个 Agent 或工作区，没有采用。')
        if (isCurrent()) setReading({ client, scope, skills: page.skills, loading: false, issue: '' })
      } catch (error) {
        if (isCurrent()) setReading(value => ({ client, scope, skills: previousSkills(value), loading: false,
          issue: `Skills 读取未确认：${error instanceof Error ? error.message : String(error)}` }))
      }
    })()
    return () => { active = false }
  }, [client, session?.agentSessionId, session?.hostId, session?.providerId, session?.workspacePath, agentSessionId, scope, connected, visible, open, retry])
  const own = reading.client === client && reading.scope === scope ? reading : null
  return <SearchChoiceDialog open={open && visible} onOpenChange={setOpen} label="Skills" searchLabel="查找 Skills" clearLabel="清除 Skills 查询"
    className="mobile-posture-menu mobile-command-menu" trigger={<button type="button" className="composer-tool" aria-label="选择 Skill">
      <SemanticIcon name="object.skill" size={14} /><span className="composer-tool__label">Skills</span>
    </button>}>
      {(query, choose) => {
        const matching = (own?.skills ?? []).filter(skill => [skill.name, skill.description, skill.path].join(' ').toLocaleLowerCase().includes(query))
        return <>
          {own?.issue && <MobileNotice identity={[own.issue]} className="mobile-command-menu__empty" role="status">{own.issue}
            <button type="button" onClick={() => setRetry(value => value + 1)}>重试读取 Skills</button>
          </MobileNotice>}
          <div className="mobile-command-menu__list">{matching.map(skill => <button key={skill.source + ':' + skill.path}
            type="button" data-choice className="mobile-posture-menu__item" onClick={() => choose(() => {
              const kind = semanticReferenceKind(skill.path), token = '$' + skill.name
              onSelect({ id: 'skill:' + skill.source + ':' + skill.path, text: token, label: skill.name, description: skill.description,
                insertText: encodeSemanticReference({ token, label: semanticReferenceLabel(skill.name), kind,
                  reference: kind === 'subcommand' ? skill.path : '@' + skill.path }) })
            })}><strong>{skill.name}</strong><small>{skill.description || skill.path}</small></button>)}</div>
          {!own || own.loading ? <p className="mobile-command-menu__empty" role="status">正在读取工作区 Skills…</p>
            : !own.issue && !matching.length && <p className="mobile-command-menu__empty" role="status">
              {query ? '无匹配 Skill' : '这个 Agent 没有可用的 Skill'}
            </p>}
        </>
      }}
  </SearchChoiceDialog>
}
