import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronUp, GripVertical, Plus, X } from 'lucide-react'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { GoalsCommonActionRef } from '../../../shared/contracts'
import { resolveComposerShortcuts } from '../../../shared/composer-shortcut-library'
import bannerUrl from '../../../../resources/settings-banner.png'
import { commonActionKey, commonActionsDirectory, createCommonActionPrompt, DEFAULT_GOALS_COMMON_ACTIONS, resolveGoalsCommonAction, type GoalsCommonAction } from '../lib/goals-common-actions'
import { saveGoalsCommonActions } from '../lib/goals-common-actions-config'
import { goalExplorationPending, goalExplorationProject, startGoalExploration, subscribeGoalExploration } from '../lib/goals-entry-actions'
import { useAppStore } from '../store'
import { ComposerTextarea } from './ComposerTextarea'
import { SettingsNavigation } from './SettingsNavigation'
import { useResourceDrafts } from './settings/use-resource-drafts'

const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
function RequestBody({ action }: { action: GoalsCommonAction }) {
  const emphasis = action.ref.kind === 'builtin' ? action.ref.id === 'understand' ? '了解我并给我建议吗？' : action.ref.id === 'ideas' ? '开始尝试一个项目' : '建议我下一步应该做什么' : ''
  return <span className="goals-entry__request">{emphasis && action.body.endsWith(emphasis) ? <>{action.body.slice(0, -emphasis.length)}<strong>{emphasis}</strong></> : action.body}</span>
}
function TargetFacts({ action }: { action: GoalsCommonAction }) {
  return <span className="goals-common__facts">
    {action.project ? <small title={`${action.project.id} · ${action.project.hostId} · ${action.project.path}`}>{action.project.source === 'recent' ? '最近项目' : '当前项目'} · {action.project.name}</small> : null}
    <small>{action.executor ? `Agent · ${action.executor.label}` : action.reason ?? '在对话中选择 Agent'}</small>
  </span>
}
function DirectoryRow({ action, selected, saving, index, count, dirty, onSelect, onMove, onRemove }: {
  action: GoalsCommonAction; selected: boolean; saving: boolean; index: number; count: number; dirty: boolean
  onSelect(): void; onMove(to: number): void; onRemove(): void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: action.key, disabled: saving })
  return <div ref={setNodeRef} className="goals-common__directory-row" style={{ transform: CSS.Transform.toString(transform), transition }} data-common-ref={action.key}>
    <button type="button" className="goals-common__icon goals-common__drag" disabled={saving} aria-label={`拖动排序 ${action.label}`} {...attributes} {...listeners}><GripVertical size={14} /></button>
    <button type="button" className="goals-common__directory-item" data-common-select={action.key} aria-pressed={selected} onClick={onSelect}>
      <span>{action.label}{selected ? <Check size={12} /> : null}</span><small>{dirty ? '正文尚未保存' : action.ref.kind === 'builtin' ? action.conditional ? '有项目时显示' : '默认操作' : action.reason && !action.body ? '失效引用' : '指令库'}</small>
    </button>
    <span className="goals-common__row-tools"><button type="button" className="goals-common__icon" aria-label={`上移 ${action.label}`} disabled={saving || index === 0} onClick={() => onMove(index - 1)}><ArrowUp size={12} /></button><button type="button" className="goals-common__icon" aria-label={`下移 ${action.label}`} disabled={saving || index === count - 1} onClick={() => onMove(index + 1)}><ArrowDown size={12} /></button><button type="button" className="goals-common__icon" aria-label={`移出常用 ${action.label}`} disabled={saving} onClick={onRemove}><X size={12} /></button></span>
  </div>
}

/** The Goals directory points at the same authored prompt library used by Settings and Composer. */
export function GoalsCommonActions() {
  const config = useAppStore(state => state.config)
  const focus = useAppStore(state => state.agentFocus)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const project = useMemo(() => goalExplorationProject(config, focus, activeWorkspaceId), [config, focus, activeWorkspaceId])
  const directory = commonActionsDirectory(config)
  const savedPrompts = useMemo(() => Object.fromEntries(resolveComposerShortcuts(config).map(prompt => [prompt.id, prompt])), [config?.composerShortcuts])
  const resource = useResourceDrafts(savedPrompts)
  const actions = useMemo(() => directory.items.map(ref => resolveGoalsCommonAction(ref, config, project)), [directory, config, project])
  const visibleActions = actions.filter(action => !action.conditional)
  const pending = useSyncExternalStore(subscribeGoalExploration, goalExplorationPending, goalExplorationPending)
  const [manage, setManage] = useState(false)
  const [view, setView] = useState<'library' | 'editor' | 'add'>('library')
  const [selected, setSelected] = useState<GoalsCommonActionRef | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [settingsRequested, setSettingsRequested] = useState(false)
  const navigation = useContext(SettingsNavigation)
  const manageButton = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const library = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const focusRef = useRef<string | 'add' | null>(null)
  const focusEditor = useRef(false)
  const mounted = useRef(true)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const selectedKey = selected ? commonActionKey(selected) : null
  const prompt = selected?.kind === 'prompt' ? resource.value[selected.id] : undefined
  const selectedAction = selected ? resolveGoalsCommonAction(selected, config, project) : null
  const existing = selected?.kind === 'prompt' && Object.hasOwn(resource.expected, selected.id)
  const promptDirty = Boolean(prompt && (!existing || prompt.body !== resource.expected[prompt.id]?.body))
  const displayedActions = expanded ? visibleActions : visibleActions.slice(0, 3)
  const available = [...DEFAULT_GOALS_COMMON_ACTIONS.items, ...resolveComposerShortcuts(config).map(prompt => ({ kind: 'prompt' as const, id: prompt.id }))]
    .filter(ref => !directory.items.some(item => commonActionKey(item) === commonActionKey(ref)))

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (focusRef.current && manage && view === 'library') {
      const target = focusRef.current === 'add' ? addButton.current : [...(library.current?.querySelectorAll<HTMLButtonElement>('[data-common-select]') ?? [])].find(button => button.dataset.commonSelect === focusRef.current)
      ;(target ?? addButton.current)?.focus(); focusRef.current = null
    }
    if (focusEditor.current && manage && view === 'editor') { editor.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); focusEditor.current = false }
  }, [manage, view, directory, selectedKey])

  function closeManage() { setManage(false); setSettingsRequested(false); queueMicrotask(() => manageButton.current?.focus()) }
  function select(ref: GoalsCommonActionRef) { setSelected(ref); setView('editor'); setSettingsRequested(false); focusEditor.current = true }
  function back() { focusRef.current = selectedKey ?? 'add'; setView('library'); setSettingsRequested(false) }
  function continueToSettings(value = resource.value, committed = resource.expected) {
    const dirty = Object.values(value).find(prompt => !committed[prompt.id] || prompt.body !== committed[prompt.id]!.body)
    if (dirty) { setSelected({ kind: 'prompt', id: dirty.id }); setView('editor'); setSettingsRequested(true); focusEditor.current = true }
    else { setSettingsRequested(false); navigation?.open('prompts') }
  }
  function add() {
    const fresh = createCommonActionPrompt('', Object.values(resource.value))
    resource.setValue(value => ({ ...value, [fresh.id]: fresh })); select({ kind: 'prompt', id: fresh.id })
  }
  function cancelPrompt() {
    if (selected?.kind !== 'prompt') return
    const id = selected.id
    resource.setValue(value => {
      const next = { ...value }
      if (Object.hasOwn(resource.expected, id)) next[id] = resource.expected[id]!
      else delete next[id]
      return next
    })
    setSaveError(null)
    if (!existing) { setSelected(null); focusRef.current = 'add'; setView('library') }
    if (settingsRequested) {
      const next = { ...resource.value }
      if (Object.hasOwn(resource.expected, id)) next[id] = resource.expected[id]!
      else delete next[id]
      continueToSettings(next)
    }
  }
  async function savePrompt() {
    if (!prompt || !prompt.body.trim() || saving) return
    const normalized = existing ? prompt : { ...createCommonActionPrompt(prompt.body, Object.values(resource.value).filter(candidate => candidate.id !== prompt.id), prompt.id) }
    const submitted = resource.beginSave({ ...resource.expected, [prompt.id]: normalized })
    const ref: GoalsCommonActionRef = { kind: 'prompt', id: prompt.id }
    const items = directory.items.some(item => commonActionKey(item) === commonActionKey(ref)) ? directory.items : [...directory.items, ref]
    setSaving(true); setSaveError(null)
    try {
      const saved = await saveGoalsCommonActions({ directory: { ...directory, items }, expectedDirectory: config?.goalsCommonActions,
        prompts: { value: Object.values(submitted.value), expected: Object.values(submitted.expected) } })
      const committed = Object.fromEntries(resolveComposerShortcuts(saved).map(prompt => [prompt.id, prompt]))
      submitted.finish(committed)
      if (settingsRequested) continueToSettings({ ...resource.value, [prompt.id]: normalized }, committed)
    } catch (cause) { submitted.finish(undefined); setSaveError(errorText(cause)) }
    finally { setSaving(false) }
  }
  async function saveDirectory(items = directory.items, collapsed = directory.collapsed, focusAfter?: string | 'add') {
    if (saving) return
    setSaving(true); setSaveError(null)
    try {
      await saveGoalsCommonActions({ directory: { items, collapsed }, expectedDirectory: config?.goalsCommonActions })
      if (focusAfter) { focusRef.current = focusAfter; setSelected(items.find(ref => commonActionKey(ref) === focusAfter) ?? null); setView('library') }
    } catch (cause) { setSaveError(errorText(cause)) }
    finally { setSaving(false) }
  }
  function move(key: string, to: number) {
    const from = directory.items.findIndex(item => commonActionKey(item) === key)
    if (from < 0 || to < 0 || to >= directory.items.length || from === to) return
    const items = [...directory.items]; const [item] = items.splice(from, 1); items.splice(to, 0, item!)
    void saveDirectory(items, directory.collapsed, key)
  }
  function remove(key: string) {
    const at = directory.items.findIndex(item => commonActionKey(item) === key)
    const items = directory.items.filter(item => commonActionKey(item) !== key)
    const next = items[Math.min(at, items.length - 1)]
    void saveDirectory(items, directory.collapsed, next ? commonActionKey(next) : 'add')
  }
  function start(action: GoalsCommonAction) {
    if (pending || action.reason || !action.body) return
    setLaunchError(null)
    void startGoalExploration(action.body, action.project, action.executor?.id).catch(cause => {
      if (mounted.current && useAppStore.getState().mainSurface === 'board') setLaunchError(errorText(cause))
    })
  }
  function openSettings() { continueToSettings() }

  return <section className={`goals-entry goals-common${manage ? ' goals-common--managing' : ''}`} aria-label="常用操作" aria-busy={saving || pending} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && manage) { event.stopPropagation(); closeManage() }
  }}>
    <div className="goals-common__column">
      <header className="goals-common__heading"><h2>常用操作</h2><div><button ref={manageButton} type="button" className="goals-common__text-button" aria-expanded={manage} onClick={() => { setManage(!manage); setView('library'); setSettingsRequested(false); focusRef.current = selectedKey ?? 'add' }}>{manage ? '完成' : '管理'}</button><button type="button" className="goals-common__text-button" disabled={saving} aria-label={directory.collapsed ? '展开常用操作' : '收起常用操作'} aria-expanded={!directory.collapsed} onClick={() => void saveDirectory(directory.items, !directory.collapsed)}>{directory.collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button></div></header>
      {manage ? <div className="goals-common__manager" data-view={view} aria-label="管理常用操作">
        <p className="goals-common__hint">排序或移出不会删除指令，也不会发起对话。</p>
        <div className="goals-common__manage-body">
          <div className="goals-common__library" ref={library}>
            <div className="goals-common__manage-tools"><button ref={addButton} type="button" className="goals-common__text-button" disabled={saving} onClick={add}><Plus size={13} />新增操作</button><button type="button" className="goals-common__text-button" disabled={saving} onClick={() => setView('add')}>引用已有</button></div>
            <div className="goals-common__directory" role="region" aria-label="常用操作目录" tabIndex={0}>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => { if (event.over) move(String(event.active.id), directory.items.findIndex(item => commonActionKey(item) === String(event.over!.id))) }}>
                <SortableContext items={actions.map(action => action.key)} strategy={verticalListSortingStrategy}>
                  {actions.map((action, index) => <DirectoryRow key={action.key} action={action} selected={selectedKey === action.key} saving={saving} index={index} count={actions.length} dirty={action.ref.kind === 'prompt' && resource.value[action.ref.id]?.body !== resource.expected[action.ref.id]?.body} onSelect={() => select(action.ref)} onMove={to => move(action.key, to)} onRemove={() => remove(action.key)} />)}
                </SortableContext>
              </DndContext>
              {!actions.length ? <p className="goals-common__hint">还没有常用操作。可以新增一句指令，或引用已有指令。</p> : null}
              {Object.values(resource.value).filter(prompt => !Object.hasOwn(resource.expected, prompt.id)).map(prompt => <button type="button" key={prompt.id} className="goals-common__draft" data-common-select={`prompt:${prompt.id}`} aria-pressed={selectedKey === `prompt:${prompt.id}`} onClick={() => select({ kind: 'prompt', id: prompt.id })}><span>{prompt.body.trim().split('\n')[0] || '新操作'}</span><small>正文尚未保存</small></button>)}
            </div>
          </div>
          <div ref={editor} className="goals-common__editor">
            <button type="button" className="goals-common__text-button goals-common__back" onClick={back}><ArrowLeft size={13} />返回目录</button>
            {view === 'add' ? <section className="goals-common__available" aria-label="引用已有指令"><h3>添加到常用</h3><p className="goals-common__hint">正文继续保存在同一指令库。</p>{available.map(ref => { const action = resolveGoalsCommonAction(ref, config, project); return <button key={action.key} type="button" disabled={saving} onClick={() => void saveDirectory([...directory.items, ref], directory.collapsed, action.key)}><span>{action.label}</span><small>{action.body}</small><Plus size={13} /></button> })}{!available.length ? <p className="goals-common__hint">已有指令都在常用操作中了。</p> : null}</section> : prompt ? <section data-common-editor={prompt.id}>
              <label className="goals-common__body-label">想让 Agent 做什么？<ComposerTextarea value={prompt.body} onValueChange={body => resource.setValue(value => ({ ...value, [prompt.id]: { ...value[prompt.id]!, body } }))} rows={5} disabled={saving} placeholder="写下你会经常使用的一句指令…" /></label>
              <p className="goals-common__hint">{existing ? '编辑会同步更新这条指令在 Composer 和设置中的正文。' : '只需填写正文，名称和关键词会自动生成。'}</p>
              <div className="goals-common__preview"><small>保存后使用的完整请求</small><p>{prompt.body || '你的指令会显示在这里。'}</p><TargetFacts action={resolveGoalsCommonAction({ kind: 'prompt', id: prompt.id }, { ...config!, composerShortcuts: Object.values(resource.value) }, project)} /></div>
              {settingsRequested ? <p className="goals-common__hint" role="status">先保存或取消尚未提交的正文，再进入指令库设置。</p> : null}
              <footer className="goals-common__editor-footer"><button type="button" className="goals-common__text-button" disabled={saving} onClick={cancelPrompt}>取消编辑</button><button type="button" className="goals-button goals-button--primary" disabled={saving || !prompt.body.trim() || !promptDirty} onClick={() => void savePrompt()}>{saving ? '正在保存…' : '保存操作'}</button></footer>
            </section> : selectedAction ? <section className="goals-common__builtin-preview"><h3>{selectedAction.label}</h3><p>{selectedAction.body || selectedAction.reason}</p><p className="goals-common__hint">{selectedAction.ref.kind === 'builtin' ? '默认请求可移出、排序，或在“引用已有”中恢复。' : selectedAction.reason}</p></section> : <p className="goals-common__hint">选择一条操作查看正文，或新增自己的指令。</p>}
            {navigation ? <button type="button" className="goals-common__text-button goals-common__settings" disabled={saving} onClick={openSettings}>在设置中管理指令库</button> : null}
          </div>
        </div>
      </div> : !directory.collapsed ? <>
        <div className="goals-common__hero" aria-hidden="true"><img src={bannerUrl} alt="" /><div><strong>从一句话开始</strong><span>和 Agent 一起，找到下一步。</span></div></div>
        <div className="goals-entry__actions goals-common__reading" role="region" aria-label="阅读常用操作完整请求" tabIndex={0} aria-busy={pending}>
          {displayedActions.map(action => <button key={action.key} type="button" data-goals-entry-action={action.ref.id} data-common-action={action.key} disabled={pending || Boolean(action.reason) || !action.body} onClick={() => start(action)}>
            <span className="goals-common__request-line"><RequestBody action={action} /><ArrowRight size={15} aria-hidden="true" /></span><TargetFacts action={action} />
          </button>)}
          {!displayedActions.length ? <p className="goals-common__empty">你的常用操作可以放在这里。<button type="button" className="goals-common__text-button" onClick={() => { setManage(true); setView('library'); focusRef.current = 'add' }}>添加操作</button></p> : null}
        </div>
        {visibleActions.length > 3 ? <button type="button" className="goals-common__all goals-common__text-button" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); const active = document.activeElement; queueMicrotask(() => (active as HTMLElement)?.focus()) }}>{expanded ? '收起更多' : `全部操作（${visibleActions.length}）`}{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button> : null}
      </> : null}
      {pending ? <p className="goals-entry__preparing" role="status">正在准备对话…</p> : null}
      {saveError ? <p className="goals-service" role="alert">保存未完成，正文草稿已保留。<span>{saveError}</span></p> : null}
      {launchError ? <p className="goals-service" role="status">对话准备未确认。原请求与工作面保留，请查看对话中的准备状态。<span>{launchError}</span></p> : null}
    </div>
  </section>
}
