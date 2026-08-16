import { useState } from 'react'
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
        <h1>Reusable Workflow surfaces</h1>
        <p>只展示组件公开 props；不读取 Chat Store、Provider 或 Runtime。先把观察组件炼化，再决定聊天页的接入边界。</p>
      </section>
      <section className="wf-gallery__section">
        <p className="wf-gallery__caption"><b>A · 时间线上下文</b>　Workflow 与普通 tool 行共用低干扰的时间线语言。</p>
        <div className="wf-gallery__timeline">
          <div className="wf-gallery__message">我先看一下事件定义，然后跑一轮 review。</div>
          <WorkflowToolRow title="Read docs/events.md" workflowName="review-changes" status="running" duration="0m 18s" notice="" />
          <WorkflowToolRow title="Bash git status" workflowName="review-changes" status="completed" duration="0m 03s" notice="" />
          <WorkflowCard workflow={runningWorkflow} />
          <WorkflowToolRow title="Read app/web/src/lib/run-workflow-summary.ts" workflowName="review-changes" status="completed" duration="0m 02s" notice="" />
        </div>
      </section>
      <section className="wf-gallery__section">
        <p className="wf-gallery__caption"><b>B · 终态与恢复</b>　终态默认收成摘要，失败项保留可见状态。</p>
        <div className="wf-gallery__stack">
          <WorkflowCard workflow={completedWorkflow} defaultExpanded={false} />
          <WorkflowCard workflow={failedWorkflow} />
          <WorkflowCard workflow={killedWorkflow} defaultExpanded={false} />
          <WorkflowCard workflow={pausedWorkflow} defaultExpanded={false} />
        </div>
      </section>
      <section className="wf-gallery__section">
        <p className="wf-gallery__caption"><b>C · 规模与旧 daemon</b>　超过 8 个 Agent 自动分栏，安静尾部可反复收起；没有阶段事实就退化成普通 tool 行。</p>
        <div className="wf-gallery__stack">
          <WorkflowCard workflow={largeWorkflow} />
          <WorkflowToolRow title="Bash npm --prefix app/web run build" workflowName={legacyDaemonWorkflow.name} status="running" duration={legacyDaemonWorkflow.duration} notice={legacyDaemonWorkflow.legacyNotice ?? ''} />
        </div>
      </section>
      <section className="wf-gallery__section">
        <p className="wf-gallery__caption"><b>D · 输入框上方 dock</b>　同一 WorkflowCard 的 dock 密度变体，内部滚动不复制状态。</p>
        <WorkflowDock workflow={runningWorkflow} />
      </section>
      <ObservationSurfaceGallery />
    </main>
  )
}
