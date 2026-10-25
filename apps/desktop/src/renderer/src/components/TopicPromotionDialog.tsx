import * as Dialog from '@agentmux/client-ui/components/Modal'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { mintObjectId } from '@agentmux/core/object-id'
import type { TopicPromotionReceipt } from '@agentmux/core/control'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { refreshTopicSpatial } from '../lib/topic-knowledge-actions'
import { useAppStore } from '../store'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import topicArt from '../assets/mote-origin/topic-work.png'
import moteArt from '../assets/mote-origin/grown-team.png'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { MoteIcon } from './MoteIcon'
import '../styles/topic-promotion.css'

export type TopicPromotionTarget = { topicId: string; title: string }
type Props = { target: TopicPromotionTarget | null; onClose(): void; onPromoted(receipt: TopicPromotionReceipt): void }

export function TopicPromotionDialog({ target, ...props }: Props) {
  return target ? <Promotion key={target.topicId} target={target} {...props} /> : null
}

/** The Host keeps the operation. Dismissing this view never cancels or replays a write. */
function Promotion({ target, onClose, onPromoted }: Props & { target: TopicPromotionTarget }) {
  const [receipt, setReceipt] = useState<TopicPromotionReceipt | null>(null)
  const [phase, setPhase] = useState<'reading' | 'ready' | 'writing' | 'unknown'>('reading')
  const [error, setError] = useState<string | null>(null)
  const operation = useRef(mintObjectId()), alive = useRef(true), writing = useRef(false)
  const invoker = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const content = useRef<HTMLDivElement>(null)

  async function observe() {
    setPhase('reading'); setError(null)
    try {
      // Read-only discovery on this exact Topic also resolves a concurrent original
      // operation. A proposed client ID never prevents finding the Host's receipt.
      const result = await api.topics.call('topic.promote.inspect', { topicId: target.topicId })
      if (!alive.current) return
      if (result.promotion) operation.current = result.promotion.operationId
      setReceipt(result.promotion); setPhase('ready')
      if (result.promotion?.state === 'complete') await complete(result.promotion)
    } catch (cause) {
      if (alive.current) { setError(presentError(cause)); setPhase('unknown') }
    }
  }
  useEffect(() => {
    alive.current = true
    void observe()
    return () => { alive.current = false }
  }, [])

  async function complete(result: TopicPromotionReceipt) {
    // Refresh the exact content and graph projections. Selection, drafts and layouts retain their owners.
    try {
      await refreshTopicSpatial()
      await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true, target.topicId)
    } catch (cause) {
      useAppStore.getState().reportError(new Error(`晋升已经保存，界面尚未刷新。${presentError(cause)}`))
    }
    if (alive.current) { onPromoted(result); onClose() }
  }

  async function promote() {
    if (writing.current || phase !== 'ready') return
    writing.current = true; setPhase('writing'); setError(null)
    try {
      const result = await api.topics.call('topic.promote.apply', { topicId: target.topicId, operationId: operation.current })
      if (result.promotion?.state === 'complete') await complete(result.promotion)
      else if (alive.current) {
        if (result.promotion) operation.current = result.promotion.operationId
        setReceipt(result.promotion); setPhase(result.promotion ? 'ready' : 'unknown')
        if (!result.promotion) setError('晋升结果尚未确认。原来的工作仍然保留，请查看结果。')
      }
    } catch (cause) {
      if (alive.current) { setError(presentError(cause)); setPhase('unknown') }
    } finally { writing.current = false }
  }

  const busy = phase === 'writing', reading = phase === 'reading', partial = receipt?.state === 'partial'
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim topic-promotion-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface topic-promotion-dialog" data-phase={phase}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const active = document.activeElement
          if (active === document.body || active === null || content.current?.contains(active)) invoker.current?.isConnected && invoker.current.focus()
        }}>
        <div className="topic-promotion__scene" aria-hidden="true">
          <img className="topic-promotion__art topic-promotion__art--before" src={topicArt} alt="" draggable={false} />
          <img className="topic-promotion__art topic-promotion__art--after" src={moteArt} alt="" draggable={false} />
          <span className="topic-promotion__journey"><span>TOPIC</span><span className="topic-promotion__line" /><MoteIcon size={15} /><span>MOTE</span></span>
        </div>
        <div className="topic-promotion__body">
          <span className="topic-promotion__eyebrow">从一起做事，到长期相伴</span>
          <Dialog.Title className="topic-promotion__title">{target.title}</Dialog.Title>
          <p className="topic-promotion__invitation">让这个方向，成为有自己人格的伙伴。</p>
          <Dialog.Description className="topic-promotion__continuity">原来的 Agent、对话和资料都会保留。</Dialog.Description>
          {partial || error ? <div className="topic-promotion__recovery" role="status">
            <strong>{partial ? '晋升尚未完成' : '结果待确认'}</strong>
            <p>原来的工作仍可继续。{partial ? '可以接着完成这次晋升。' : '先查看这次操作的结果。'}</p>
            <details><summary>查看详情</summary><p>{error ?? receipt?.unavailable.map(issue => issue.message).join(' ')}</p></details>
          </div> : null}
          <footer className="topic-promotion__actions">
            <button type="button" className="small-button topic-promotion__cancel" onClick={onClose}>{busy || partial || phase === 'unknown' ? '稍后查看' : '暂时不用'}</button>
            {phase === 'unknown' ? <button type="button" className="primary-button topic-promotion__submit" onClick={() => void observe()}>查看结果</button>
              : <button type="button" className="primary-button topic-promotion__submit" disabled={busy || reading} onClick={() => void promote()}>
                <MoteIcon size={17} />{busy ? '正在晋升…' : reading ? '正在读取…' : partial ? '继续晋升' : '晋升为 Mote'}
              </button>}
          </footer>
          {busy ? <p className="topic-promotion__progress" role="status">正在延续原来的工作。关闭后也可回来查看。</p> : null}
        </div>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
