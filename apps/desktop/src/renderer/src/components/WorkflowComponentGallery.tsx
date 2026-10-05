import { useEffect, useRef, useState } from 'react'
import { InlineRenameField } from '@agentmux/client-ui/components/InlineRenameField'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { APP_APPEARANCE_IDS, type AppAppearanceId } from '../../../shared/contracts'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { SemanticIcon } from '@agentmux/client-ui/icons'
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

const ThemeFileTextIcon = semanticIconComponent('file.text')
const ThemeActionEditIcon = semanticIconComponent('action.edit')


const APPEARANCE_LABELS = { light: '浅色', dark: '深色', system: '跟随系统' } satisfies Record<AppAppearanceId, string>

function InlineRenameExample() {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [name, setName] = useState('README.md'), [value, setValue] = useState(name)
  const [editing, setEditing] = useState(false), [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const begin = () => { setValue(name); setError(null); setEditing(true) }
  return <div className="wf-gallery__rename-example">
    <div className="wf-gallery__rename-row">
      <ThemeFileTextIcon size={14} />
      {editing ? <InlineRenameField label="Rename example file" value={value} pending={pending} error={error}
        selectionEnd={name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length}
        onValueChange={next => { setValue(next); setError(null) }}
        onCancel={() => { setEditing(false); setError(null) }}
        onCommit={async next => {
          setPending(true)
          await new Promise(resolve => setTimeout(resolve, 180))
          if (!mounted.current) return
          setPending(false)
          if (!next.trim() || next.includes('/') || next.includes('\\')) { setError('Enter a file name without a path.'); return }
          if (next.trim() === 'package.json') { setError('A file named package.json already exists.'); return }
          setName(next.trim()); setEditing(false)
        }} />
        : <button className="wf-gallery__rename-name" onClick={begin} onDoubleClick={begin} onKeyDown={event => {
          if (event.key === 'F2') { event.preventDefault(); begin() }
        }}>{name}<ThemeActionEditIcon size={12} /></button>}
    </div>
    <p>同一原位改名组件。Enter 保存，Esc 取消；输入 package.json 可体验冲突恢复。示例不会改动磁盘。</p>
  </div>
}

export function WorkflowComponentGallery() {
  const [theme, setTheme] = useState<AppAppearanceId>('dark')
  useEffect(() => mountThemeRuntime(), [])
  useEffect(() => { updateThemeSelection({ appAppearance: theme }) }, [theme])
  return (
    <main className="wf-gallery">
      <header className="wf-gallery__bar">
        <div className="wf-gallery__brand">Workflow 时间线组件 <span>· reusable gallery</span></div>
        <div className="wf-gallery__theme" role="group" aria-label="主题切换">
          {APP_APPEARANCE_IDS.map((mode) => (
            <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => setTheme(mode)}>
              {APPEARANCE_LABELS[mode]}
            </button>
          ))}
        </div>
      </header>
      <section className="wf-gallery__intro">
        <div className="wf-gallery__intro-mark"><SemanticIcon name="object.workflow" size={18} /></div>
        <h1>Reusable Workflow surfaces</h1>
        <p>只展示组件公开 props；不读取 Chat Store、Provider 或 Runtime。先把观察组件炼化，再决定聊天页的接入边界。</p>
      </section>
      <nav className="wf-gallery__map" aria-label="Gallery 内容导航">
        <a href="#workflow-context"><SemanticIcon name="object.context" />上下文</a>
        <a href="#workflow-states"><SemanticIcon name="status.completed" />终态与恢复</a>
        <a href="#workflow-scale"><SemanticIcon name="layout.scale" />规模与降级</a>
        <a href="#workflow-dock"><SemanticIcon name="layout.dock" />输入框上方 dock</a>
        <a href="#existing-surfaces"><SemanticIcon name="object.branch" />聊天表面</a>
        <a href="#composer-details"><SemanticIcon name="conversation.message-tools" />Composer 细节</a>
        <a href="#inline-rename"><ThemeActionEditIcon size={13} />原位改名</a>
      </nav>
      <section id="workflow-context" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="object.context" /><b>A · 时间线上下文</b><span>Workflow 与普通 tool 行共用低干扰的时间线语言。</span></p>
        <div className="wf-gallery__timeline">
          <div className="wf-gallery__message">我先看一下事件定义，然后跑一轮 review。</div>
          <WorkflowToolRow title="Read docs/events.md" workflowName="review-changes" status="running" duration="0m 18s" notice="" />
          <WorkflowToolRow title="Bash git status" workflowName="review-changes" status="completed" duration="0m 03s" notice="" />
          <WorkflowCard workflow={runningWorkflow} />
          <WorkflowToolRow title="Read app/web/src/lib/run-workflow-summary.ts" workflowName="review-changes" status="completed" duration="0m 02s" notice="" />
        </div>
      </section>
      <section id="workflow-states" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="status.completed" /><b>B · 终态与恢复</b><span>终态默认收成摘要，失败项保留可见状态。</span></p>
        <div className="wf-gallery__stack">
          <WorkflowCard workflow={completedWorkflow} defaultExpanded={false} />
          <WorkflowCard workflow={failedWorkflow} />
          <WorkflowCard workflow={killedWorkflow} defaultExpanded={false} />
          <WorkflowCard workflow={pausedWorkflow} defaultExpanded={false} />
        </div>
      </section>
      <section id="workflow-scale" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="layout.scale" /><b>C · 规模与旧 daemon</b><span>超过 8 个 Agent 自动分栏，安静尾部可反复收起；没有阶段事实就退化成普通 tool 行。</span></p>
        <div className="wf-gallery__stack">
          <WorkflowCard workflow={largeWorkflow} />
          <WorkflowToolRow title="Bash npm --prefix app/web run build" workflowName={legacyDaemonWorkflow.name} status="running" duration={legacyDaemonWorkflow.duration} notice={legacyDaemonWorkflow.legacyNotice ?? ''} />
        </div>
      </section>
      <section id="workflow-dock" className="wf-gallery__section">
        <p className="wf-gallery__caption"><SemanticIcon name="layout.dock" /><b>D · 输入框上方 dock</b><span>同一 WorkflowCard 的 dock 密度变体，内部滚动不复制状态。</span></p>
        <WorkflowDock workflow={runningWorkflow} />
      </section>
      <div id="existing-surfaces"><ObservationSurfaceGallery /></div>
      <section id="inline-rename" className="wf-gallery__section">
        <p className="wf-gallery__caption"><ThemeActionEditIcon size={13} /><b>原位改名</b><span>名称、选区、等待和错误共用一套交互。</span></p>
        <InlineRenameExample />
      </section>
    </main>
  )
}
