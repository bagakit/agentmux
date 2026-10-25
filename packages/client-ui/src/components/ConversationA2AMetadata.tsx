import type { DurableAgentMuxMessage } from '@agentmux/core'
import { formatClock } from '../lib/conversation-time.js'

type Props = {
  message: DurableAgentMuxMessage
  notificationId?: string | undefined
  timeFormatter?: ((timestamp: number) => string) | undefined
}

const validTime = (at: number) => Number.isFinite(new Date(at).getTime())
const fullTime = (at: number) => !validTime(at) ? `时间值无法显示（${at}）` : new Date(at).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' })

/** A historical card never borrows the message's later notification. */
function originalNotice({ message, notificationId }: Props) {
  const notice = message.notification
  return notificationId && notice?.notificationId === notificationId && notice.state !== 'unassociated' ? notice : undefined
}

function modeLabel(notice: ReturnType<typeof originalNotice>) {
  return notice?.mode === 'idle' ? '空闲后通知' : notice?.mode === 'steer' ? '立即通知' : '模式未记录'
}

function notificationLabel(notice: ReturnType<typeof originalNotice>) {
  if (!notice) return '通知信息未关联'
  if (notice.state === 'submitted') return notice.resultRecordedAt == null ? '通知时间未记录' : '通知确认'
  if (notice.state === 'unconfirmed') return '通知待核实'
  if (notice.state === 'not-applied') return '本次未通知'
  return '等待通知'
}

function RecordedTime({ at, renderClock, withDate = false }: { at: number; renderClock: (at: number) => string; withDate?: boolean }) {
  const date = new Date(at)
  if (!validTime(at)) return <span title={String(at)}>时间值无法显示</span>
  return <time dateTime={date.toISOString()} title={fullTime(at)}>
    {withDate ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` : ''}{renderClock(at)}
  </time>
}

export function ConversationA2ATiming(props: Props & { onRefresh?: (() => void) | undefined; refreshing?: boolean; readIssue?: string | undefined }) {
  const notice = originalNotice(props), sentAt = props.message.envelope.createdAt
  const confirmedAt = notice?.state === 'submitted' ? notice.resultRecordedAt : undefined
  const renderClock = props.timeFormatter ?? formatClock
  const differentDay = confirmedAt != null && new Date(sentAt).toDateString() !== new Date(confirmedAt).toDateString()
  return <div className="conversation-a2a-timing" aria-label="消息时间与通知模式">
    <span className="conversation-a2a-timing__stage" title="原消息创建记录时间，不是接收 Agent 阅读时间">
      <span>发送</span><RecordedTime at={sentAt} renderClock={renderClock} withDate={differentDay} />
    </span>
    <span className="conversation-a2a-timing__stage" data-notification-state={notice?.state ?? 'unassociated'}
      title="原通知结果的记录时间；通知确认不表示 Agent 已阅读或接受任务">
      <span>{notificationLabel(notice)}</span>
      {confirmedAt == null ? null : <RecordedTime at={confirmedAt} renderClock={renderClock} withDate={differentDay} />}
    </span>
    <span className="conversation-a2a-timing__mode" title={notice?.mode === 'idle' ? '默认策略：入箱后等待确认空闲的机会' : notice?.mode === 'steer' ? '这次是显式立即通知；不改写原信发送意图' : '这次通知的模式没有可核对记录'}>{modeLabel(notice)}</span>
    {props.onRefresh && (notice?.state !== 'submitted' || props.readIssue) ? <button type="button" className="conversation-a2a-timing__refresh"
      aria-label="核对通知状态" aria-busy={props.refreshing || undefined} title="只读核对这次通知，不重发消息" onClick={props.onRefresh}>{props.refreshing ? '正在核对…' : '核对通知'}</button> : null}
    {props.readIssue ? <span className="conversation-a2a-timing__issue" role="status">通知核对失败 · {props.readIssue}</span> : null}
  </div>
}

export function ConversationA2ADetails(props: Props & { hostId: string }) {
  const notice = originalNotice(props), message = props.message
  const execution = message.execution === 'default' ? '默认发送' : message.execution === 'immediate' ? '立即执行请求' : '未记录'
  return <section className="conversation-a2a-metadata" aria-label="原消息与通知记录">
    <dl>
      <dt>发送记录</dt><dd>{fullTime(message.envelope.createdAt)}<small>原消息创建时间</small></dd>
      <dt>原发送意图</dt><dd>{execution}{message.deliveryMode === 'reference' ? ' · 入箱后引用通知' : ''}</dd>
      <dt>通知模式</dt><dd>{modeLabel(notice)}</dd>
      <dt>通知准备</dt><dd>{notice?.preparedAt == null ? '未记录' : fullTime(notice.preparedAt)}</dd>
      <dt>通知结果</dt><dd>{notificationLabel(notice)}{notice?.resultRecordedAt == null ? null : <small>结果记录于 {fullTime(notice.resultRecordedAt)}</small>}</dd>
      {notice?.reason ? <><dt>结果说明</dt><dd>{notice.reason}</dd></> : null}
      <dt>原消息 ID</dt><dd><code>{message.envelope.messageId}</code></dd>
      <dt>原通知 ID</dt><dd><code>{props.notificationId ?? '未关联'}</code></dd>
      <dt>Host</dt><dd>{props.hostId}</dd>
    </dl>
    <p>通知确认表示输入提交结果已记录，不代表 Agent 已阅读、接单或完成。默认策略不表示发送方曾显式选择该模式。</p>
  </section>
}
