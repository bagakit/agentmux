import { errorIdentity } from '../lib/error-presentation'
import type { ReactNode } from 'react'
import { useId } from 'react'
import { AtSign, ArrowUp, Copy, Paperclip, Square } from 'lucide-react'
import type { AgentPostureControl } from '@agentmux/core'
import { composerKeywordAtCaret } from '../../../shared/composer-shortcut-library'
import { isImeOwnedKeyboardEvent } from '../lib/ime-composition-keyboard-event'
import { PosturePicker } from './PosturePicker'
import { InlineComposer } from './InlineComposer'
import { SemanticIcon } from './semantic-icons'
import type { ComposerSemanticReference } from '../lib/composer-semantic-reference'

/**
 * 候选浮层里的一条。四类候选（`/` 命令、`$` 技能、`@` 引用、裸词识别词）共用这一个形状。
 *
 * `group` 决定分段标题，是**数据**而不是从 description 反推：Shortcut 与 Agent 原生命令混在同一个
 * `/` 列表里（设计 SSOT「同一个 `/` 列表，但按来源分组并带组标题」），而"这条是谁提供的"只有上游
 * 知道。按 description 的后缀去猜会在文案一改时静默失效。缺席即不分段——另外三类都只有单一来源。
 */
export type ComposerSuggestion = { text: string; description: string; group?: string }

export type ComposerQueuedMessage = {
  id: string
  text: string
  // `deferred` 是「我们这次没投出去，Agent 还好着，还在等下一次机会」。它必须与 `queued` 分开，
  // 否则角标会照 healthy 路径念「queued for delivery」，把一次降级静默放行（store.ts 的
  // AgentSteerQueueEntry 记了为什么这一档要在模型里有名字）。
  status: 'queued' | 'deferred' | 'failed'
  deliverable: boolean
  sending?: boolean
  error?: string
}

export type AgentComposerProps = {
  value: string
  disabled: boolean
  placeholder: string
  activeFile?: string
  contextUsage?: ReactNode
  // The queued prompts themselves, not a count. A bare number reads as a bug — you cannot tell a real
  // pending queue from a stuck counter without seeing what is in it. Count is derived (`.length`), so
  // the badge and the list can never disagree.
  queued?: readonly ComposerQueuedMessage[]
  onRemoveQueued?: (id: string) => void
  onSendQueued?: (id: string) => void
  onActivateSemanticReference?: (reference: ComposerSemanticReference) => void
  // Copy the undeliverable queue out. Absence hides the button rather than rendering a dead one: the
  // clipboard exit (lib/clipboard-copy) requires an error reporter by design, and a shell that has no
  // reporter to give must not offer an action that could fail silently. The card only names copying as
  // the remedy when this is wired.
  onCopyQueued?: (text: string) => void
  tools?: ReactNode
  commands?: ComposerSuggestion[]
  skills?: ComposerSuggestion[]
  references?: ComposerSuggestion[]
  onSelectSuggestion?: (text: string, kind: 'command' | 'skill' | 'reference' | 'keyword') => string | void
  // 识别词：用户自己的 prompt，`text` 是裸 keyword（无 `/`），`description` 说明它是什么。
  // 打出裸词时开候选、在正文里加下划线、Tab 就地替换成正文，三处共用这一份。
  promptKeywords?: ComposerSuggestion[]
  // Which action the primary button performs. `stop` while a turn is in flight, `send` otherwise. This is
  // a SEPARATE question from whether Enter submits: a working Agent shows Stop yet still takes a steer, so
  // this must not gate the Enter handler — that was the bug where one `isWorking` flag did both jobs.
  primaryAction?: 'send' | 'stop'
  identity?: { name: string; avatar: ReactNode; context?: string }
  feedback?: ReactNode
  postureControl?: AgentPostureControl
  // Shell-style history recall on the up/down arrows. The shell owns the keys; the semantics (line
  // boundary + the recall reducer) live in the adapter so they stay unit-testable — this component cannot
  // run its own handlers under this repo's node-env vitest. Returns the value to place in the box, or null
  // to let the arrow fall through to normal caret movement. direction: 'older' = ArrowUp, 'newer' = ArrowDown.
  onHistoryRecall?: (direction: 'older' | 'newer', draft: string, caret: number) => string | null
  onChange(value: string): void
  onSubmit?: () => void
  onQueue?: () => void
  onInterrupt?: () => void
  onReferenceActiveFile?: () => void
  onAttach?: () => void
  onPasteImage?: (image: { bytes: Uint8Array; extension: string }) => void
  onSetPosture?: (modeId: string) => void
}

export function AgentComposer({
  value,
  disabled,
  placeholder,
  activeFile,
  tools,
  contextUsage,
  queued = [],
  onRemoveQueued,
  onSendQueued,
  onActivateSemanticReference,
  onCopyQueued,
  commands = [],
  skills = [],
  references = [],
  onSelectSuggestion,
  primaryAction = 'send',
  identity,
  feedback,
  postureControl,
  onChange,
  onSubmit,
  onQueue,
  onInterrupt,
  onReferenceActiveFile,
  onAttach,
  onPasteImage,
  onSetPosture,
  onHistoryRecall,
  promptKeywords = []
}: AgentComposerProps) {
  const canSubmit = !disabled && Boolean(onSubmit) && Boolean(value.trim())

  const explicitTrigger = value.match(/(?:^|\s)([\/$@][^\s]*)$/)?.[1] ?? ''
  // 裸词识别：光标前那个词是某条 prompt keyword 的前缀（含正好相等）时也开候选。
  //
  // 显式 `/$@` 优先——它是用户明说的意图。两者不会同时命中：`/review` 里 `review` 前面是 `/`，
  // 既不是行首也不是空白，下面这条正则本就匹配不上。
  //
  // 至少两个字符才开口：一个字母会让几乎每句话都弹候选，那种噪声比没有这个功能更糟。
  // ponytail: 阈值 2 是拍的，若真机发现仍吵再往上调
  const bareWord = explicitTrigger ? '' : (value.match(/(?:^|\s)([A-Za-z0-9_-]{2,})$/)?.[1] ?? '')
  const keywordSuggestions = bareWord
    // **不**沿用下面 `item.text !== trigger` 那条排除：打全整个 keyword 之后候选必须还在，
    // 否则用户刚打完词、候选正好消失，Tab 与点击都无从下手（这正是 acceptance 点名的那一条）。
    ? promptKeywords.filter((item) => item.text.startsWith(bareWord))
    : []
  const trigger = explicitTrigger || (keywordSuggestions.length ? bareWord : '')
  const suggestionKind = trigger.startsWith('/') ? 'command' : trigger.startsWith('$') ? 'skill' : trigger.startsWith('@') ? 'reference' : trigger ? 'keyword' : null
  const source = suggestionKind === 'command' ? commands : suggestionKind === 'skill' ? skills : suggestionKind === 'reference' ? references : []
  const suggestions = suggestionKind === 'keyword'
    ? keywordSuggestions
    : source.filter((item) => item.text.startsWith(trigger) && item.text !== trigger)
  const keywordTexts = promptKeywords.map((item) => item.text)
  // 候选按 group 收成有序分段。用 Map 而不是先 sort 再 reduce：Map 保插入序，于是段序就是上游
  // 拼装候选的顺序，不需要第二份「哪个 group 排前面」的清单（那份清单会和上游漂开）。
  // 无 group 的候选归到一个空键段里，渲染时不加标题——skill / reference / keyword 三类都只有
  // 单一来源，它们照旧是一条平铺的列表。
  const grouped = new Map<string, ComposerSuggestion[]>()
  for (const item of suggestions) {
    const key = item.group ?? ''
    grouped.set(key, [...(grouped.get(key) ?? []), item])
  }
  const suggestionGroups = [...grouped]
  return (
    <div className="composer" data-agent-composer="true">
      {/* The maintained editor owns composition, selection and undo; the host owns the draft. */}
      <InlineComposer
        aria-label="Message Agent"
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        onKeyDown={(event, caret) => {
          // No !isWorking guard: a running Agent can be steered. Enter submits whenever the surface allows
          // a submit and there is text; delivery (and codex's mid-turn refusal) is Core's call, not the
          // renderer's. Stop stays a click on the button, so mid-turn Enter never risks an accidental stop.
          // IME candidate confirmation also arrives as Enter. Let the IME commit first; otherwise the
          // composer submits the pre-conversion draft and the user sees missing/replaced characters in
          // the Agent conversation (#609). 判据必须走 SSOT 的四路谓词：此前这里手抄了两路
          // (`nativeEvent?.isComposing || keyCode === 229`)，漏掉顶层 `isComposing` 与
          // `nativeEvent.keyCode`。只标记那两路的输入法照旧会把半转换草稿提交上去。
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length && !isImeOwnedKeyboardEvent(event)) {
            event.preventDefault()
            const buttons = [...((event.target as HTMLElement).closest('.composer')?.querySelectorAll<HTMLButtonElement>('.composer__suggestions button') ?? [])]
            const current = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
            const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length
            buttons[next]?.focus()
            return
          }
          if (event.key === 'Escape' && suggestions.length) {
            event.preventDefault();
            (event.target as HTMLElement).focus()
            return
          }
          // Shell-style history recall. Suggestions win the arrows (their block above returns first), so
          // this only runs with no open list. The adapter decides everything testable — line boundary and
          // the recall reducer — and returns the value to place, or null to let the arrow move the caret
          // normally (the multiline resolution: bare ArrowUp only recalls when the caret is on the first
          // line, ArrowDown only on the last line; otherwise the caret just moves). #609 IME guard applies.
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !suggestions.length && onHistoryRecall && !isImeOwnedKeyboardEvent(event)) {
            const recalled = onHistoryRecall(event.key === 'ArrowUp' ? 'older' : 'newer', value, caret)
            if (recalled !== null) {
              event.preventDefault()
              onChange(recalled)
            }
            return
          }
          // Tab 一键替换识别词。**只在光标正停在某个识别词末尾时**接管，否则一律放行——Tab 是焦点
          // 遍历键，无条件 preventDefault 会把用户永久困在输入框里（照既有 onHistoryRecall 返回
          // null 就让箭头正常移动的纪律）。命中判定与下划线共用 composerKeywordAtCaret，两处不许各算
          // 一次：分开算就会出现"划了线却按不动"。
          if (event.key === 'Tab' && !event.shiftKey && !isImeOwnedKeyboardEvent(event)) {
            const hit = composerKeywordAtCaret(value, caret, keywordTexts)
            if (hit) {
              event.preventDefault()
              const replacement = onSelectSuggestion?.(hit, 'keyword') ?? hit
              onChange(`${value.slice(0, caret - hit.length)}${replacement}${value.slice(caret)}`)
            }
            return
          }
          // 两个 Enter 意图，绝不能互相退化（interaction SSOT「Cmd+Enter 直接 steer」）：
          // Bare Enter follows the parent's queue intent, including a pending interaction. Stop is
          // a separate action and must not decide whether a waiting/blocked Agent can retain a draft.
          // Cmd/Ctrl+Enter follows immediate submission when available; Shift+Enter and IME stay editing.
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !isImeOwnedKeyboardEvent(event) && onQueue && value.trim()) {
            event.preventDefault()
            onQueue()
            return
          }
          if (event.key === 'Enter'  && !event.shiftKey && !isImeOwnedKeyboardEvent(event) && canSubmit) {
            event.preventDefault()
            onSubmit?.()
          }
        }}
        keywords={keywordTexts}
        {...(onPasteImage ? { onPasteImage } : {})}
        {...(onActivateSemanticReference ? { onActivateReference: onActivateSemanticReference } : {})}
        placeholder={placeholder}
      />
      <div className="composer__toolbar">
        <div>
          {tools}
          {identity ? <span className="composer__identity" title={identity.context ? `${identity.name} · ${identity.context}` : identity.name}>
            {identity.avatar}<span>{identity.name}</span>
          </span> : null}
          <button
            type="button"
            className="composer-tool"
            disabled={disabled || !onAttach}
            onClick={onAttach}
            aria-label="Reference files for the Agent to read" title="Reference files for the Agent to read"
          >
            <Paperclip size={14} /> <span className="composer-tool__label">Files</span>
          </button>
          {/* A shortcut to the file already open, not a second way to attach — so it appears only
              when there is one, rather than sitting permanently greyed out. */}
          {activeFile && onReferenceActiveFile ? (
            <button
              type="button"
              className="composer-tool"
              disabled={disabled}
              onClick={onReferenceActiveFile}
              aria-label={`Reference ${activeFile}`} title={`Reference ${activeFile}`}
            >
              <AtSign size={14} /> <span className="composer-tool__label">{activeFile.split('/').at(-1)}</span>
            </button>
          ) : null}
          {/* Absence hides: only a Provider that declared an addressable posture control renders this,
              and only while the composer can write to the live process. */}
          {onSetPosture ? (
            <PosturePicker control={postureControl} disabled={disabled} onSet={onSetPosture} />
          ) : null}
          {/* The queue indicator lives with the bottom-left affordance cluster, not beside the primary
              action — it is a status of the pending work, kin to the tools, not a second send button.
              It opens: a bare count is indistinguishable from a stuck counter, so the messages
              themselves have to be reachable. Same native `popover` as the context chip, for the same
              reason — the composer clips `overflow: hidden`, and the top layer escapes it. */}
          {queued.length > 0 ? (
              <QueuedMessages queued={queued}
              {...(onRemoveQueued ? { onRemove: onRemoveQueued } : {})}
              {...(onSendQueued ? { onSend: onSendQueued } : {})}
              {...(onCopyQueued ? { onCopy: onCopyQueued } : {})} />
          ) : null}
        </div>
        <div>
          {contextUsage}
          {primaryAction === 'stop' ? (
            // Send 与 Interrupt 收成图标（interaction SSOT「Send 与 Interrupt 收成图标」）。两者仍
            // 必须可区分：破坏性动作收成图标 ≠ 收掉这个区分。区分靠两处，都不是文字——
            //   · 图形：↑（推进/steer）对 ■（停/破坏性），本就是两个不同符号；
            //   · 颜色语汇（Design Control Language：绿=推进、红=破坏性）：steer 走 --secondary 的绿，
            //     Interrupt 走 --working 的红。
            // ■ 中断的是**这一轮**（onInterrupt → Core semantic interrupt），不结束整个 Run；结束会话是
            // Tabbar 里另一个动作，故它的可访问名/tooltip 说「current turn」，把两个对象分开。
            <span className="composer-send-group">
            <button
              type="button"
              className="composer-send composer-send--secondary"
              disabled={!canSubmit}
              onClick={onSubmit}
              aria-label="Send steer"
              title="Send this steer while the current turn continues"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-send composer-send--working"
              disabled={disabled || !onInterrupt}
              onClick={onInterrupt}
              aria-label="Interrupt the current turn"
              title="Interrupt the current turn — the session keeps running"
            >
              <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </button>
            </span>
          ) : (
            <button
              type="button"
              className="composer-send"
              disabled={!canSubmit}
              onClick={onSubmit}
              aria-label="Send"
              title="Send"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {feedback}
      <QueueDeliveryNotice queued={queued} canCopy={Boolean(onCopyQueued)} />
      {suggestions.length && !disabled ? <div className="composer__suggestions" role="listbox" aria-label={`Agent ${suggestionKind ?? 'suggestions'}`}>
        {/* 按 group 分段并给每段一个标题。分组只在**确实有两个以上来源**时出现：单一来源时加一个
            标题等于给一份列表起个多余的名字。段序由候选自身的顺序决定（先出现的 group 先排），
            不另外写一张 group 名字的优先级表——那张表会和上游的拼装顺序漂开。
            `role="group"` + `aria-label` 让分段对读屏是真的分段，而不只是视觉上多了一行字。 */}
        {suggestionGroups.map(([group, items]) => {
          const options = items.map((command) => <button type="button" role="option" aria-selected="false" key={command.text}
            onClick={() => { const replacement = onSelectSuggestion?.(command.text, suggestionKind!) ?? command.text; onChange(`${value.slice(0, value.length - trigger.length)}${replacement} `) }}>{command.text}<small>{command.description}</small></button>)
          if (!group || suggestionGroups.length < 2) return options
          return <div className="composer__suggestion-group" role="group" aria-label={group} key={group}>
            <h4>{group}</h4>{options}
          </div>
        })}
      </div> : null}
    </div>
  )
}

function QueuedMessages({ queued, onCopy, onRemove, onSend }: {
  queued: readonly ComposerQueuedMessage[]
  onCopy?: (text: string) => void
  onRemove?: (id: string) => void
  onSend?: (id: string) => void
}) {
  const cardId = useId()
  const retryEntry = queued.find((entry) => entry.deliverable)
  const { unavailable, deferred, sending, label, state } = summarizeQueue(queued, Boolean(onCopy))
  return (
    <>
      <button type="button" className="composer__queued" data-state={state} aria-label={label}
        popoverTarget={cardId} popoverTargetAction="toggle">
        <SemanticIcon name={unavailable > 0 ? 'failed' : deferred.length > 0 ? 'paused' : 'message-queue'} size={12} /> {queued.length}
      </button>
      <div id={cardId} popover="auto" className="composer__queued-card" aria-label="Queued messages">
        <h3>{label}</h3>
        <ol>
          {queued.map((entry) => <li key={entry.id} data-state={entry.status}>
            <span>{entry.text}</span>
            {entry.sending ? <small>Sending. Waiting for delivery confirmation.</small>
              : !entry.deliverable ? <small>Not sent: this message targets a Run that is no longer available here.</small>
              : entry.error ? <small>{entry.error}</small> : null}
            <span className="composer__queued-actions">
              {onRemove ? <button type="button" className="composer-tool" disabled={entry.sending} onClick={() => onRemove(entry.id)}>Remove</button> : null}
            </span>
          </li>)}
        </ol>
        {onSend && retryEntry ? <button type="button" className="composer-tool" disabled={sending} onClick={() => onSend(retryEntry.id)}>Retry queue</button> : null}
        <p>Messages for the current Run are sent in order as soon as the Agent can accept them.</p>
        {onCopy ? <button type="button" className="composer-tool" onClick={() => onCopy(queued.map((entry) => entry.text).join('\n\n'))}>
          <Copy size={12} aria-hidden="true" /> Copy {queued.length === 1 ? 'message' : 'all'}
        </button> : null}
      </div>
    </>
  )
}

function summarizeQueue(queued: readonly ComposerQueuedMessage[], canCopy: boolean) {
  const unavailable = queued.filter((entry) => !entry.deliverable && !entry.sending).length
  const deferred = queued.filter((entry) => entry.deliverable && entry.status === 'deferred')
  const sending = queued.some((entry) => entry.sending)
  const label = unavailable > 0
    ? `${unavailable} of ${queued.length} messages cannot be sent to the current Run`
    : deferred.length > 0
    ? `${deferred.length} of ${queued.length} messages not delivered yet - still queued`
    : sending ? `Sending - ${queued.length} queued` : `${queued.length} message${queued.length === 1 ? '' : 's'} queued for delivery`
  const state = unavailable > 0 ? 'failed' : deferred.length > 0 ? 'deferred' : 'queued'
  // Delivery limitations remain visible beside the badge, even while the detail popover is closed.
  const notice = [
    unavailable > 0 ? `Some messages cannot be sent to this Run. They are kept here.${canCopy ? ' Open the queue to copy them.' : ''}` : '',
    deferred.length > 0 ? `${errorIdentity(deferred[0]?.error ?? 'Delivery is waiting.')} Kept in the queue; retries when the Agent or connection becomes ready. You can also retry from the queue.` : ''
  ].filter(Boolean).join(' ')
  return { unavailable, deferred, sending, label, state, notice }
}

function QueueDeliveryNotice({ queued, canCopy }: { queued: readonly ComposerQueuedMessage[]; canCopy: boolean }) {
  const { notice } = summarizeQueue(queued, canCopy)
  return notice ? <div className="composer__queue-notice" role="status">{notice}</div> : null
}
