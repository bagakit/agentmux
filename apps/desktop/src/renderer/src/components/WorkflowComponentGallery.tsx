import { useState } from 'react'
import { SemanticIcon } from './semantic-icons'
import { WorkflowCard, WorkflowDock, WorkflowToolRow } from './workflow'
import { ObservationSurfaceGallery } from './ObservationSurfaceGallery'
import {
  completedWorkflow,
  failedWorkflow,
  killedWorkflow,
  largeWorkflow,
  legacyDaemonWorkflow,
  pausedWorkflow,
  runningWorkflow
} from './workflow/fixtures'

type ThemeMode = 'light' | 'dark' | 'system'

function applyTheme(mode: ThemeMode): void {
  if (mode === 'system') delete document.documentElement.dataset.appearance
  else document.documentElement.dataset.appearance = mode
}

export function WorkflowComponentGallery() {
  const [theme, setTheme] = useState<ThemeMode>('dark')
  const setThemeMode = (mode: ThemeMode): void => {
    setTheme(mode)
    applyTheme(mode)
  }
  return (
    <main className="wf-gallery">
      <header className="wf-gallery__bar">
        <div className="wf-gallery__brand">Workflow 时间线组件 <span>· reusable gallery</span></div>
        <div className="wf-gallery__theme" role="group" aria-label="主题切换">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => setThemeMode(mode)}>
              {mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}
            </button>
          ))}
        </div>
      </header>
      <section className="wf-gallery__intro">
        <div className="wf-gallery__intro-mark"><SemanticIcon name="workflow" size={18} /></div>
        <h1>Reusable Workflow surfaces</h1>
        <p>只展示组件公开 props；不读取 Chat Store、Provider 或 Runtime。先把观察组件炼化，再决定聊天页的接入边界。</p>
      </section>
      <nav className="wf-gallery__map" aria-label="Gallery 内容导航">
        <a href="#workflow-context"><SemanticIcon name="context" />上下文</a>
        <a href="#workflow-states"><SemanticIcon name="completed" />终态与恢复</a>
        <a href="#workflow-scale"><SemanticIcon name="scale" />规模与降级</a>
        <a href="#workflow-dock"><SemanticIcon name="dock" />输入框上方 dock</a>
        <a href="#existing-surfaces"><SemanticIcon name="branch" />聊天表面</a>
        <a href="#composer-details"><SemanticIcon name="message-tools" />Composer 细节</a>
      </nav>
      <section id="workflow-context" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="context" /><b>A · 时间线上下文</b><span>Workflow 与普通 tool 行共用低干扰的时间线语言。</span></p>
        <div className="wf-gallery__timeline">
          <div className="wf-gallery__message">我先看一下事件定义，然后跑一轮 review。</div>
          <WorkflowToolRow title="Read docs/events.md" workflowName="review-changes" status="running" duration="0m 18s" notice="" />
          <WorkflowToolRow title="Bash git status" workflowName="review-changes" status="completed" duration="0m 03s" notice="" />
          <WorkflowCard workflow={runningWorkflow} />
          <WorkflowToolRow title="Read app/web/src/lib/run-workflow-summary.ts" workflowName="review-changes" status="completed" duration="0m 02s" notice="" />
        </div>
      </section>
      <section id="workflow-states" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="completed" /><b>B · 终态与恢复</b><span>终态默认收成摘要，失败项保留可见状态。</span></p>
        <div className="wf-gallery__stack">
          <WorkflowCard workflow={completedWorkflow} defaultExpanded={false} />
          <WorkflowCard workflow={failedWorkflow} />
          <WorkflowCard workflow={killedWorkflow} defaultExpanded={false} />
          <WorkflowCard workflow={pausedWorkflow} defaultExpanded={false} />
        </div>
      </section>
      <section id="workflow-scale" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="scale" /><b>C · 规模与旧 daemon</b><span>超过 8 个 Agent 自动分栏，安静尾部可反复收起；没有阶段事实就退化成普通 tool 行。</span></p>
        <div className="wf-gallery__stack">
          <WorkflowCard workflow={largeWorkflow} />
          <WorkflowToolRow title="Bash npm --prefix app/web run build" workflowName={legacyDaemonWorkflow.name} status="running" duration={legacyDaemonWorkflow.duration} notice={legacyDaemonWorkflow.legacyNotice ?? ''} />
        </div>
      </section>
      <section id="workflow-dock" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="dock" /><b>D · 输入框上方 dock</b><span>同一 WorkflowCard 的 dock 密度变体，内部滚动不复制状态。</span></p>
        <WorkflowDock workflow={runningWorkflow} />
      </section>
      <div id="existing-surfaces"><ObservationSurfaceGallery /></div>
    </main>
  )
}
