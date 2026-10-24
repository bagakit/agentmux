import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import type { CapsuleInspection, CapsuleInteraction } from '@agentmux/core/capsule'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { CapsuleQuestionReply } from './CapsuleQuestionReply'

const QuestionsIcon = semanticIconComponent('object.collaboration')
const RefreshIcon = semanticIconComponent('action.refresh')

export function CapsuleInteractionChrome({ capsuleId, active, visible = true, toolbarHost }: {
  capsuleId: string; active: boolean; visible?: boolean; toolbarHost: HTMLElement | null
}) {
  const [page, setPage] = useState<CapsuleInspection | null>(null)
  const [questions, setQuestions] = useState<CapsuleInteraction[] | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const observed = ++generation.current
    setLoading(true)
    try {
      const [inspection, result] = await Promise.all([api.capsules.call('capsule.inspect', { capsuleId }), api.capsules.call('capsule.interaction.ls', { capsuleId })])
      if (generation.current !== observed) return
      setPage(inspection)
      setQuestions(current => {
        const known = new Map(current?.filter(question => question.capsuleId === capsuleId).map(question => [question.interactionId, question]))
        for (const question of result.interactions) {
          const previous = known.get(question.interactionId)
          if (!previous || question.revision >= previous.revision) known.set(question.interactionId, question)
        }
        return [...known.values()]
      })
      setNotice(result.issues.map(issue => issue.message).join(' '))
    } catch (error) { if (generation.current === observed) setNotice(`Page requests could not be refreshed. Existing questions and drafts are retained. ${presentError(error)}`) }
    finally { if (generation.current === observed) setLoading(false) }
  }, [capsuleId])
  useEffect(() => { if (visible) void refresh(); return () => { generation.current++ } }, [visible, refresh])
  const pending = questions?.filter(question => question.status === 'pending' || question.reply?.phase === 'prepared').length
  const updated = (value: CapsuleInteraction): void => setQuestions(current => current?.map(question => question.interactionId === value.interactionId && value.revision >= question.revision ? value : question) ?? [value])
  const mode = page ? page.record.mode === 'injected' ? 'Injected' : 'Isolated' : 'Capsule'
  return <>
    {toolbarHost ? createPortal(<button type="button" className="capsule-toolbar__button" aria-label="Page questions" aria-expanded={open}
      title={`${page?.record.title ?? 'Saved page'} · ${mode} · ${pending ?? 'Unconfirmed'} pending questions`} onClick={() => {
        if (!open) void refresh()
        setOpen(value => !value)
      }}><QuestionsIcon size={13} /><span className="capsule-toolbar__name">{page?.record.title ?? 'Saved page'}</span>
      <span className="capsule-toolbar__mode">{mode}</span>{pending ? <span className="capsule-toolbar__count">{pending}</span> : null}</button>, toolbarHost) : null}
    <section className="capsule-chrome" aria-label="Capsule page requests" hidden={!open} inert={!open || !visible}>
      <div className="capsule-chrome__heading"><div><strong>{page?.record.title ?? 'Saved page'} · Page questions</strong><span>{mode} · Answers go to the original Agent through this App.</span></div>
        <button type="button" className="small-button" disabled={loading} onClick={() => void refresh()}><RefreshIcon size={12} />{loading ? 'Refreshing…' : 'Refresh'}</button></div>
      {!active ? <p className="capsule-chrome__notice">Browsing another site · saved requests retained</p> : null}
      {notice ? <p className="capsule-chrome__notice" role="status">{notice}</p> : null}
      {questions?.length === 0 ? <p className="capsule-chrome__empty">No saved questions. Refresh after the page creates a request.</p> : null}
      {questions === null && loading ? <p className="capsule-chrome__empty" role="status">Reading the original page requests…</p> : null}
      {questions?.map(question => <CapsuleQuestionReply key={question.interactionId} interaction={question} onUpdated={updated} />)}
      <details className="capsule-chrome__source"><summary>Page identity and source</summary><code>{formatAmuxObjectLink({ kind: 'capsule', capsuleId })}</code>
        {page ? <><code>{page.record.contentRoot}</code>{page.endpoint.status === 'available' ? <code>{page.endpoint.url}</code> : <p>{page.endpoint.issue.message}</p>}</> : null}</details>
    </section>
  </>
}
