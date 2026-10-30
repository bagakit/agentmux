import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MoteInputInspection, MoteInputObservation } from '@agentmux/core'
import type { ConversationRef } from '@agentmux/core/conversation'
import { moteInputNoticeInspectionMatches, type MoteInputNotice } from '@agentmux/core/mote-input-notice'
import { useClientUiPlatform, useMoteInputReader, type MoteInputNoticeOwner } from '../platform.js'
import { SemanticIcon } from '../theme/icons.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'

function inputSummary(input: MoteInputObservation['input']): string {
  switch (input) {
    case 'admitted': return '成员已接收新输入'
    case 'launch-carried': return '恢复启动已携带消息，Agent 是否接收未确认'
    case 'terminal-confirmed': return '新输入已送入终端，是否采用待确认'
    case 'interaction-confirmed': return '原请求答复已记录'
    case 'waiting': return '原输入仍在等待'
    case 'stopped': return '原输入已停止等待'
    case 'not-applied': return '原输入未应用'
    default: return '原输入状态尚未确认'
  }
}

function resultSummary(result: NonNullable<MoteInputNotice['result']>): string {
  if (result.kind === 'native-turn') return result.status === 'completed' ? '成员本轮已结束'
    : result.status === 'interrupted' ? '成员本轮已中断' : '成员本轮未能完成'
  const answer = result.responseKind === 'permission' ? '权限答复' : '问题答复'
  return result.nativeCompleted ? `${answer}对应的原请求已结束`
    : result.delivery === 'bytes-accepted' ? `${answer}已送入终端，采用待确认`
    : result.delivery === 'hook-written' ? `${answer}已写入原请求通道`
    : result.delivery === 'acp-acknowledged' ? `${answer}已获原协议确认`
    : result.delivery === 'saved' ? `${answer}已保存，送达待确认` : `${answer}的送达尚未确认`
}

/** Readable evidence from a qualified original notice; opening it never answers or repeats input. */
export function ConversationMoteNotice({ identity, notice, scope, routeHostId, active = true, time }: {
  identity: object; notice: MoteInputNotice; scope?: ConversationRef | undefined; active?: boolean
  routeHostId?: string | undefined
  time?: ReactNode
}) {
  const platform = useClientUiPlatform()
  const read = useMoteInputReader()
  const target = useMemo<MoteInputNoticeOwner | undefined>(() => scope && routeHostId
    ? { routeHostId, sourceHostId: scope.hostId, recipientAgentSessionId: scope.agentSessionId } : undefined,
  [scope?.hostId, scope?.agentSessionId, routeHostId])
  const owner = useMemo(() => ({}), [identity, read, target, notice.observationId, notice.phase,
    notice.memberAgentSessionId, JSON.stringify(notice.source), JSON.stringify(notice.origin)])
  const [opened, setOpened] = useState<object | null>(null)
  const open = opened === owner
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ owner: object; attempt: number; reading?: boolean; inspection?: MoteInputInspection; error?: string }>({ owner, attempt })
  const current = state.owner === owner ? state : undefined
  const member = target ? platform.moteMemberName?.(target, notice.memberAgentSessionId) ?? notice.memberAgentSessionId : notice.memberAgentSessionId
  const summary = notice.result ? resultSummary(notice.result) : inputSummary(notice.input)
  useEffect(() => {
    if (!active || !open || !read || !target || current?.inspection && current.attempt === attempt) return
    let retained = true
    setState(previous => {
      if (previous.owner !== owner) return { owner, attempt, reading: true }
      const { error: _error, ...retained } = previous
      return { ...retained, reading: true }
    })
    const failed = (error: string) => setState(previous => ({ owner, attempt, error,
      ...(previous.owner === owner && previous.inspection ? { inspection: previous.inspection } : {}) }))
    void Promise.resolve().then(() => read(target, notice.memberAgentSessionId, notice.observationId))
      .then(inspection => {
        if (!retained) return
        if (!inspection) failed('尚未取得原观察；准确来源仍保留。')
        else if (!moteInputNoticeInspectionMatches(notice, inspection, target.recipientAgentSessionId)) failed('返回记录未匹配原成员、主 Agent 或来源；原通知仍保留。')
        else setState({ owner, attempt, inspection })
      }, error => { if (retained) failed(error instanceof Error ? error.message : '原观察暂不可读。') })
    return () => { retained = false }
  }, [owner, active, open, attempt])
  const inspection = current?.inspection
  const detailsIdentity = useMemo(() => ({}), [owner, inspection?.observation.revision])
  const result = inspection?.observation.result
  return <section className="conversation-mote-notice" aria-label="Mote coordination update" data-mote-observation={notice.observationId}>
    <div className="conversation-mote-notice__head">
      <span className="conversation-mote-notice__mark" aria-hidden="true"><SemanticIcon name="action.reply" size={15} /></span>
      <div className="conversation-mote-notice__event"><span className="conversation-mote-notice__member" title={notice.memberAgentSessionId}>{member}</span><p>{summary}</p></div>
      {time}
    </div>
    <details className="conversation-mote-notice__original" open={open} onToggle={event => setOpened(event.currentTarget.open ? owner : null)}>
      <summary>查看原决定与结果</summary>
      <div className="conversation-mote-notice__body">
        {inspection ? <>
          {inspection.inputText === null ? null : <blockquote>{inspection.inputText}</blockquote>}
          <p>{inputSummary(inspection.observation.input)}{result ? ` · ${resultSummary(result)}` : ''}</p>
          {result?.kind === 'native-turn' ? <details className="conversation-mote-notice__records"><summary>本轮原记录 · {result.records.length}</summary>
            <ConversationToolPayload text={JSON.stringify(result.records, null, 2)} identity={detailsIdentity} sourceIdentity={detailsIdentity} copyLabel="Copy original result references" />
          </details> : null}
          {inspection.observation.issue ? <p role="status">{inspection.observation.issue}</p> : null}
        </> : null}
        {current?.reading ? <p role="status">正在读取原观察…</p> : null}
        {current?.error || !target || !read ? <p role="status">{current?.error ?? (!target ? '原通知的读取位置或主 Agent 未确认；准确来源仍保留。' : '此客户端暂不能读取原观察；准确来源仍保留。')}</p> : null}
        {read && target ? <button type="button" className="small-button" disabled={current?.reading} onClick={() => setAttempt(value => value + 1)}>刷新原观察</button> : null}
        <p className="conversation-mote-notice__qualification">这是成员操作的回流记录；送达和轮次结束不代表任务验收。</p>
      </div>
    </details>
  </section>
}
