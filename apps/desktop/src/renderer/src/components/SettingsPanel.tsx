import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import * as DropdownMenu from './HoverDropdownMenu'
import { Check, ChevronDown, Bell, Bot, FolderGit2, Globe, LayoutDashboard, MessageSquareText, Palette, Search, Server, Settings2, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentExecutorConfig, AppConfig, AppearanceConfig, ComposerShortcut, HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { api } from '../lib/api'
import { BrandIcon } from './BrandIcon'
import { useAppStore } from '../store'
import { AgentSettingsPane } from './settings/AgentSettingsPane'
import { AppearanceSettingsPane } from './settings/AppearanceSettingsPane'
import { BrowserSettingsPane } from './settings/BrowserSettingsPane'
import { ShortcutSettingsPane } from './settings/ShortcutSettingsPane'
import { GeneralSettingsPane } from './settings/GeneralSettingsPane'
import { HostSettingsPane } from './settings/HostSettingsPane'
import { NotificationSettingsPane } from './settings/NotificationSettingsPane'
import { WorkspaceSettingsPane } from './settings/WorkspaceSettingsPane'
import { SettingsOverviewPane } from './settings/SettingsOverviewPane'

export type SettingsSectionId = 'general' | 'appearance' | 'notifications' | 'agents' | 'hosts' | 'workspaces' | 'browser' | 'prompts'
export type SettingsPageId = 'overview' | SettingsSectionId
type SettingsGroupId = 'preferences' | 'resources'

// Daily preferences lead; reusable resources remain separate. Both sidebar and
// compact menu consume this same order, including when search filters it.
const GROUPS: { id: SettingsGroupId; title: string }[] = [
  { id: 'preferences', title: 'Preferences' },
  { id: 'resources', title: 'Resources' }
]

/**
 * Agents 这一节的搜索词里，Provider 名从 Core 的 id 全集派生，不手抄。
 *
 * 手抄那份真的漂过：它停在最早的 9 家，而内置已经是 13 家，于是在设置搜索框里打 `kimi`、
 * `droid`、`copilot`、`opencode` 一条都搜不出来——Agents 这一节明明就管着它们。id 本身正是
 * 用户会输入的词（`traex`、`opencode`），所以直接用 id，不必再引一张展示名表。
 *
 * 搜索比对走 `.toLowerCase().includes()`，故这里也小写；id 已经全小写，`toLowerCase()` 只是
 * 让「id 里出现大写」的将来不至于静默搜不到。
 */
const AGENT_PROVIDER_KEYWORDS = BUILT_IN_AGENT_PROVIDER_IDS.map((id) => id.toLowerCase()).join(' ')

const SECTIONS = [
  { id: 'appearance' as const, group: 'preferences' as const, title: 'Appearance', description: 'Theme, typography, and terminal colors.', icon: Palette, keywords: 'theme color palette terminal tui composer input background font size typography' },
  { id: 'notifications' as const, group: 'preferences' as const, title: 'Notifications', description: 'Choose when and how agents get your attention.', icon: Bell, keywords: 'notification alert attention dwell duration banner needs you done error until dismiss sound audio silent mute chime' },
  { id: 'browser' as const, group: 'preferences' as const, title: 'Browser', description: 'Choose how agents interact with your pages.', icon: Globe, keywords: 'browser agent automation drive page script run snapshot click permission enable disable' },
  { id: 'general' as const, group: 'preferences' as const, title: 'General', description: 'Copied paths, local data, and diagnostics.', icon: Settings2, keywords: 'copy path clipboard home directory ~ tilde abbreviate absolute full shorten core runtime terminal tmux ssh show crash log session recovery' },
  { id: 'agents' as const, group: 'resources' as const, title: 'Agents', description: 'Reusable executors for your next agent session.', icon: Bot, keywords: `${AGENT_PROVIDER_KEYWORDS} executor command args env installed provider` },
  { id: 'prompts' as const, group: 'resources' as const, title: 'Prompts', description: 'Keep your everyday instructions close at hand.', icon: MessageSquareText, keywords: 'prompt preset shortcut keyword slash command snippet template library review changes summarize progress eli5 custom' },
  { id: 'workspaces' as const, group: 'resources' as const, title: 'Workspaces', description: 'Project folders and their worktrees.', icon: FolderGit2, keywords: 'project folder repo branch worktree create run on agent' },
  { id: 'hosts' as const, group: 'resources' as const, title: 'Hosts', description: 'Local and SSH connections for your workspace.', icon: Server, keywords: 'ssh remote hostname user port key test connection' }
]

/**
 * 搜索框过滤出的可见 section。
 *
 * 导出是为了让守卫能直接质询它：`query` 是组件内部 state，静态渲染改不到，于是「打 kimi 能不能
 * 搜出 Agents」这件事在组件外无从观察。抽出来之后，组件里只剩一句转发（见 `visibleSections`），
 * 那一句自身的在场由「壳里恰好只有转发这一句」这类判据去守，不靠这个函数。
 */
export function visibleSettingsSections(query: string): typeof SECTIONS {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return SECTIONS
  return SECTIONS.filter((section) =>
    `${section.title} ${section.description} ${section.keywords}`.toLowerCase().includes(normalized)
  )
}

/**
 * 侧栏导航的完整取值：按分组切开、丢掉空分组，一次算完。
 *
 * 为什么连"按 group 分组"也搬出来：原先壳里留着一句 `visibleSections.filter(…group…)`，那一句
 * 才是侧栏真正渲染用的列表。守卫当时按源文本数 `\bSECTIONS\.filter` 出现几次，于是把那一句改成
 * `[...SECTIONS].filter(…)`（中间隔了个 `]`，正则失配）就完全绕过——侧栏从此**永不随搜索词过滤**，
 * 而 4 条测试全绿。这是"数符号名守不住别的拼法"的又一次现形：只要壳里还留着一句过滤，就总有
 * 另一种拼法能把它换成不读 query 的版本。
 *
 * 所以这里不再去猜拼法，而是消除分岔本身：分组也归这个函数算，壳里一句 `.filter(` 都不该剩。
 * 判据随之变成"壳里没有任何 `.filter(` 调用"——与怎么拼无关（记忆 extracting-to-lib-only-fixes-half：
 * 抽进函数只解决一半，"壳里恰好只有转发"才是另一半）。
 */
export function settingsNavGroups(
  query: string
): { id: SettingsGroupId; title: string; items: typeof SECTIONS }[] {
  const visible = visibleSettingsSections(query)
  return GROUPS.flatMap((group) => {
    const items = visible.filter((section) => section.group === group.id)
    return items.length === 0 ? [] : [{ ...group, items }]
  })
}

export function SettingsPanel({ onClose, initialSection = 'overview', executorId }: {
  onClose: () => void
  initialSection?: SettingsPageId
  executorId?: string | undefined
}) {
  const config = useAppStore((state) => state.config)
  const [active, setActive] = useState<SettingsPageId>(initialSection)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [visited, setVisited] = useState<SettingsSectionId[]>(initialSection === 'overview' ? [] : [initialSection])

  function clearSearch(): void {
    setQuery('')
    searchInput.current?.focus()
  }

  useEffect(() => {
    setQuery('')
    setActive(initialSection)
  }, [initialSection, executorId])
  useEffect(() => {
    if (active === 'overview') return
    setVisited((current) => current.includes(active) ? current : [...current, active])
  }, [active])
  const visibleSections = useMemo(() => visibleSettingsSections(query), [query])
  // 侧栏渲染用的分组列表也从纯函数来。壳里不留任何过滤，否则那一句总能被换成不读 query 的拼法
  // （实测 `[...SECTIONS].filter(…)` 绕过了按符号名计数的守卫，侧栏从此永不过滤而 4 条全绿）。
  const navGroups = useMemo(() => settingsNavGroups(query), [query])

  useEffect(() => {
    if (!query.trim()) return
    if (visibleSections.some((section) => section.id === active)) return
    const first = visibleSections[0]
    if (first) setActive(first.id)
  }, [active, query, visibleSections])

  useEffect(() => {
    const opener = document.activeElement
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (query) { setQuery(''); return }
      if (event.target instanceof HTMLSelectElement) return
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, query])

  if (!config) return null
  const currentSection = SECTIONS.find((candidate) => candidate.id === active)
  const section = active === 'overview' ? { title: 'Overview', description: '' } : currentSection!
  const groupTitle = currentSection ? GROUPS.find((group) => group.id === currentSection.group)!.title : 'Settings'
  const overviewGroups = settingsNavGroups('')

  async function saveExecutors(executors: Record<string, AgentExecutorConfig>, expected: Record<string, AgentExecutorConfig>): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save({ ...current, executors }, { ...current, executors: expected })
  }

  async function saveAppearance(appearance: AppearanceConfig, expected: AppearanceConfig): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save({ ...current, appearance }, { ...current, appearance: expected })
  }

  async function saveNotifications(notifications: NonNullable<AppConfig['notifications']>, expected: NonNullable<AppConfig['notifications']>): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save({ ...current, notifications }, { ...current, notifications: expected })
  }

  async function saveHosts(hosts: HostConfig[], workspaces: WorkspaceRecord[], expected: Pick<AppConfig, 'hosts' | 'workspaces'>): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save({ ...current, hosts, workspaces }, { ...current, ...expected })
  }

  async function saveBrowser(agentAutomation: boolean, expected: boolean): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save(
      { ...current, browser: { ...current.browser, agentAutomation } },
      { ...current, browser: { ...current.browser, agentAutomation: expected } }
    )
  }

  async function saveCopyPathsAsAbsolute(copyPathsAsAbsolute: boolean, expected: boolean): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save({ ...current, copyPathsAsAbsolute }, { ...current, copyPathsAsAbsolute: expected })
  }

  // 空列表照样写：`[]` 是「用户把默认那两条都删了」这个事实。写成按长度判会让删光静默变回默认，
  // 而缺席不回填这条纪律的全部意义就是删掉即永久没有。
  async function saveComposerShortcuts(composerShortcuts: ComposerShortcut[], expected: ComposerShortcut[]): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    await api.config.save({ ...current, composerShortcuts }, { ...current, composerShortcuts: expected })
  }

  return (
    <div className="settings-page" data-settings-page={active}>
      <div className="window-drag-region" />
      <aside className="settings-sidebar">
        <header>
          {active === 'overview'
            ? <div className="settings-sidebar__brand"><Settings2 size={24} aria-hidden="true" /><span><strong>Settings</strong></span></div>
            : <div className="settings-sidebar__brand"><BrandIcon size={26} /><span><strong>AgentMux</strong><small>Settings</small></span></div>}
        </header>
        <label className="settings-search"><Search size={14} /><input ref={searchInput} aria-label="Search settings" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" />{query ? <button aria-label="Clear settings search" onClick={clearSearch}><X size={12} /></button> : null}</label>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="settings-section-picker" aria-label="Settings section" disabled={!visibleSections.length}>{visibleSections.length ? section.title : 'No matches'}<ChevronDown size={13} /></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="settings-section-menu" align="end" sideOffset={6} collisionPadding={{ top: 34, right: 8, bottom: 40, left: 8 }} onEscapeKeyDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => {
              // Keep focus the user has already moved to another control.
              const focused = document.activeElement
              if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
                && !focused.closest('[hidden], [inert]')
                && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
            }}>
              <DropdownMenu.RadioGroup value={active} onValueChange={(value) => setActive(value as SettingsPageId)}>
                {!query.trim() ? <DropdownMenu.RadioItem value="overview" className="settings-section-menu__item" data-settings-target="overview"><span><DropdownMenu.ItemIndicator><Check size={13} /></DropdownMenu.ItemIndicator></span>Overview</DropdownMenu.RadioItem> : null}
                {navGroups.map((group) => <Fragment key={group.id}>
                  <DropdownMenu.Label className="settings-section-menu__label">{group.title}</DropdownMenu.Label>
                  {group.items.map((item) => <DropdownMenu.RadioItem key={item.id} value={item.id} className="settings-section-menu__item">
                    <span><DropdownMenu.ItemIndicator><Check size={13} /></DropdownMenu.ItemIndicator></span>{item.title}
                  </DropdownMenu.RadioItem>)}
                </Fragment>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <nav aria-label="Settings sections">
          {!query.trim() ? <button type="button" className={active === 'overview' ? 'selected' : ''} aria-current={active === 'overview' ? 'page' : undefined} data-settings-target="overview" data-settings-overview-nav onClick={() => setActive('overview')}><LayoutDashboard size={15} /><span><strong>Overview</strong></span></button> : null}
          {navGroups.map((group) => (
            <Fragment key={group.id}>
              <p>{group.title}</p>
              {group.items.map((item) => {
                const Icon = item.icon
                return <button key={item.id} className={active === item.id ? 'selected' : ''} aria-current={active === item.id ? 'page' : undefined} title={item.description} data-settings-target={item.id} onClick={() => setActive(item.id)}><Icon size={15} /><span><strong>{item.title}</strong></span></button>
              })}
            </Fragment>
          ))}
        </nav>
      </aside>
      <main className="settings-content">
        <header className="settings-content__header">
          <div className="settings-content__title">
            <div>
              <div className="settings-content__breadcrumb"><span>{groupTitle}</span></div>
              <h2>{section.title}</h2>
              {section.description ? <p>{section.description}</p> : null}
            </div>
          </div>
          <div className="settings-content__actions">
            <span className="settings-content__hint"><kbd>Esc</kbd><span>Close</span></span>
            <button className="settings-content__close icon-button" type="button" onClick={onClose} aria-label="Close settings" title="Close settings"><X size={16} /></button>
          </div>
        </header>
        {visibleSections.length === 0 ? <div className="settings-nav-empty" role="status">No settings match “{query}”. Try a different word.</div> : null}
        {active === 'overview' && visibleSections.length > 0 ? <SettingsOverviewPane config={config} groups={overviewGroups} onOpen={setActive} /> : null}
        {visited.map((pane) => (
        <div key={pane} className="settings-content__scroll" data-settings-pane={pane} hidden={active !== pane || visibleSections.length === 0} inert={active !== pane || visibleSections.length === 0}>
          {pane === 'general' ? <GeneralSettingsPane copyPathsAsAbsolute={config.copyPathsAsAbsolute} onSave={saveCopyPathsAsAbsolute} /> : null}
          {pane === 'appearance' ? <AppearanceSettingsPane appearance={config.appearance} onSave={saveAppearance} /> : null}
          {pane === 'notifications' ? <NotificationSettingsPane notifications={config.notifications} onSave={saveNotifications} /> : null}
          {pane === 'browser' ? <BrowserSettingsPane browser={config.browser} onSave={saveBrowser} onForget={api.browser.forgetAppLinkScheme} /> : null}
          {pane === 'prompts' ? <ShortcutSettingsPane config={config} onSave={saveComposerShortcuts} /> : null}
          {pane === 'agents' ? <AgentSettingsPane config={config} onSave={saveExecutors} executorId={active === 'agents' && visibleSections.length > 0 ? executorId : undefined} /> : null}
          {pane === 'hosts' ? <HostSettingsPane config={config} onSave={saveHosts} /> : null}
          {pane === 'workspaces' ? <WorkspaceSettingsPane config={config} onClose={onClose} /> : null}
        </div>
        ))}
      </main>
    </div>
  )
}
