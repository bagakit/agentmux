import { useId } from 'react'
import { CONVERSATION_DETAIL_LEVELS, CONVERSATION_DETAIL_LABELS, isConversationDetailLevel, resolveConversationDetailLevel } from '@agentmux/client-ui/conversation-detail-level'
import { CONVERSATION_CONFIRMED_SEND_RECEIPTS, resolveConversationConfirmedSendReceipt, resolveConversationShowSendReceipts } from '@agentmux/client-ui/conversation-send-receipts'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { InAppConversationPreview } from './InAppConversationPreview'

export type InAppConversationValues = { level: unknown; showReceipts: unknown; confirmedReceipt: unknown }
const receiptLabels = { keep: { title: 'Keep the card', description: 'Leave the lightweight receipt open.' }, compact: { title: 'Quiet line', description: 'Keep a single line. Expand to read the original.' }, hide: { title: 'Hide the receipt', description: 'Let the confirmed message take its place.' } }

export function InAppConversationPreferences({ value, onChange, active }: { value: InAppConversationValues; onChange<K extends keyof InAppConversationValues>(key: K, value: InAppConversationValues[K]): void; active: boolean }) {
  const id = useId(), level = resolveConversationDetailLevel(value.level)
  const showReceipts = resolveConversationShowSendReceipts(value.showReceipts), confirmedReceipt = resolveConversationConfirmedSendReceipt(value.confirmedReceipt)
  return <>
    <section className="inapp-conversation__reading-detail" data-settings-field="reading-detail">
      <h3>Conversation detail</h3>
      <p className="settings-group-note">Keep the conversation in focus. Each choice adds another part of the execution record.</p>
      <fieldset className="inapp-reading-choices"><legend className="sr-only">Conversation detail</legend>
        <LiquidSelectionSurface selected={value.level !== undefined && !isConversationDetailLevel(value.level) ? null : level} active={active} targetAttribute="data-reading-choice" />
        {CONVERSATION_DETAIL_LEVELS.map((option, index) => <label key={option} data-reading-choice={option} data-selected={level === option && (value.level === undefined || isConversationDetailLevel(value.level))}>
          <input type="radio" name={`${id}-detail`} value={option} checked={level === option && (value.level === undefined || isConversationDetailLevel(value.level))} onChange={() => onChange('level', option)} />
          <span>{CONVERSATION_DETAIL_LABELS[option].title}<small>{index === 0 ? 'Messages, tools & usage' : index === 1 ? '+ Reply copies' : index === 2 ? '+ Subagent messages' : '+ Raw system records'}</small></span>
        </label>)}
      </fieldset>
      <p className="inapp-reading-description">{CONVERSATION_DETAIL_LABELS[level].description} Errors and requests for your input stay visible in every view.</p>
      {value.level !== undefined && !isConversationDetailLevel(value.level) ? <p className="settings-inline-error" role="status">The saved detail choice is unsupported. All details remain visible until you choose and save a supported option.</p> : null}
      <InAppConversationPreview level={level} showReceipts={showReceipts} confirmedReceipt={confirmedReceipt} active={active} kind="reading" />
    </section>
    <section className="inapp-conversation__receipts" data-settings-field="send-receipts">
      <h3>Send receipts</h3>
      <label className="inapp-receipt-toggle"><input type="checkbox" checked={showReceipts} onChange={event => onChange('showReceipts', event.target.checked)} /><span>Show a lightweight receipt for messages I send</span></label>
      <fieldset className="inapp-receipt-options" disabled={!showReceipts}><legend>After the Agent confirms receipt</legend>
        <div className="inapp-reading-choices inapp-reading-choices--receipts">
        <LiquidSelectionSurface selected={confirmedReceipt} active={active && showReceipts} targetAttribute="data-receipt-choice" />
        {CONVERSATION_CONFIRMED_SEND_RECEIPTS.map(option => <label key={option} data-receipt-choice={option} data-selected={confirmedReceipt === option}>
          <input type="radio" name={`${id}-receipt`} value={option} checked={confirmedReceipt === option} onChange={() => onChange('confirmedReceipt', option)} /><span>{receiptLabels[option].title}{option === 'compact' ? <small>Default</small> : null}</span>
        </label>)}</div>
      </fieldset>
      <p className="inapp-reading-description">{showReceipts ? receiptLabels[confirmedReceipt].description : 'Normal send receipts are hidden.'} Delivery issues and the original message remain available.</p>
      <InAppConversationPreview level={level} showReceipts={showReceipts} confirmedReceipt={confirmedReceipt} active={active} kind="receipts" />
    </section>
  </>
}
