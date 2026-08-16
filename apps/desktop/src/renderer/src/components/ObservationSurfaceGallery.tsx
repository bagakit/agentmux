import { useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { AgentMarkdown } from './AgentMarkdown'
import { ComposerTextarea } from './ComposerTextarea'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { StatusDot } from './StatusDot'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

const workingStatus: SessionSnapshot['status'] = {
  state: 'working',
  source: 'native-hook',
  observedAt: 0
}

const degradedNotice: RenderableServiceNotice = {
  kind: 'process-degraded',
  notice: {
    step: 'Prompt readiness did not complete',
    mode: 'The Agent is still alive; work can continue while readiness is degraded',
    restore: 'Retry readiness when the session is idle'
  }
}

export function ObservationSurfaceGallery() {
  const [draft, setDraft] = useState('')
  return (
    <section className="observation-gallery" aria-label="Existing observation surfaces">
      <header className="observation-gallery__heading">
        <span className="observation-gallery__eyebrow">Existing surface language</span>
        <h2>对话、状态和服务窗</h2>
        <p>复用原有组件的事实边界，用 Workflow 的层级、密度和观察节奏呈现。</p>
      </header>
      <div className="observation-gallery__grid">
        <article className="observation-sample observation-sample--conversation">
          <div className="observation-sample__label">Agent answer</div>
          <div className="observation-sample__body">
            <AgentMarkdown content={'Review completed.\n\n- `ActivityView` keeps the same timeline spine.\n- Failures remain visible for recovery.'} />
          </div>
        </article>
        <article className="observation-sample">
          <div className="observation-sample__label">Live status</div>
          <div className="observation-sample__status"><StatusDot status={workingStatus} withLabel /> <span>持续观察中</span></div>
          <ServiceWindowNotice notice={degradedNotice} />
        </article>
        <article className="observation-sample observation-sample--composer">
          <div className="observation-sample__label">Composer</div>
          <ComposerTextarea value={draft} onValueChange={setDraft} placeholder="补充一条 steer…" aria-label="Gallery composer" />
          <small>{draft ? '草稿已输入，交付仍由宿主负责。' : '受控输入与 IME 处理仍由原有组件负责。'}</small>
        </article>
      </div>
    </section>
  )
}
