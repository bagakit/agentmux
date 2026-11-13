import { ConversationMessage } from './ConversationMessage.js'
import { HUMAN_SPEAKER_ID } from '../lib/conversation-speaker.js'
import '../styles/mote-first-message.css'

/** What the original start receipt says about this first message, from the owner's own records only. */
export type MoteFirstMessageStage = 'sending' | 'delivered' | 'unconfirmed'

/**
 * The first message of a Main that is still being created, drawn where the conversation will draw it:
 * the person's own message in the conversation's message row, with one line under it about the Main.
 * It is only a presentation of the frozen first message; the original start owns creation and delivery.
 */
export function MoteFirstMessage({ messageId, prompt, name, stage, action }: {
  messageId: string; prompt: string; name: string | undefined; stage: MoteFirstMessageStage
  /** The one in-band way forward for an unconfirmed stage, such as checking the same request. */
  action?: { label: string; onClick(): void; disabled?: boolean } | undefined
}) {
  const label = (typeof name === 'string' ? name.trim() : '') || 'Mote'
  return <section className="mote-first-message" data-stage={stage} aria-label="首条消息">
    <ConversationMessage messageId={messageId} content={prompt} speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} showInputSource={false} />
    <p className="mote-first-message__status" role="status" aria-live="polite">
      <span className="mote-first-message__mark" aria-hidden="true" />
      <span>{stage === 'unconfirmed' ? '送达尚未确认，不会重复发送' : stage === 'delivered' ? `${label} 已收到，正在接上主对话…` : `${label} 正在准备…`}</span>
      {stage === 'unconfirmed' && action ? <button type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button> : null}
    </p>
  </section>
}
