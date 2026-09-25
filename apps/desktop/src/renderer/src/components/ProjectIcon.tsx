import { useEffect, useState } from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { api } from '../lib/api'
import { projectMonogram } from '../lib/project-monogram'
import { folderIconRecency } from '../lib/space-folder-icon-recency'

type Appearance = { kind: 'repository' | 'directory'; icon: string | null }

export function ProjectIcon({ workspaceId, name, lastActivityAt, visible = true }: {
  workspaceId: string; name: string; lastActivityAt?: number | null | undefined; visible?: boolean | undefined
}) {
  // `null` means "not probed yet" — kept distinct from a probed `{icon: null}` (confirmed-absent).
  // The distinction has a visible consequence: on first paint we render the slot but NO glyph, so a
  // project that DOES have an icon never flashes a folder before its real icon arrives (principle 11:
  // unknown is not the same as known-absent, and must not be rendered as the absent state).
  const [appearance, setAppearance] = useState<Appearance | null>(null)
  const [, setNow] = useState(Date.now)
  useEffect(() => {
    let active = true
    setAppearance(null)
    void api.workspaces.appearance(workspaceId).then((value) => { if (active) setAppearance(value) }).catch(() => {})
    return () => { active = false }
  }, [workspaceId])
  useEffect(() => {
    if (!appearance?.icon || lastActivityAt === undefined || lastActivityAt === null || !visible) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      const { nextBoundaryAt } = folderIconRecency(lastActivityAt, now)
      if (nextBoundaryAt !== null) timer = setTimeout(() => { setNow(Date.now()); schedule() }, nextBoundaryAt - now)
    }
    const updateVisibility = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
      schedule()
    }
    schedule()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [appearance?.icon, lastActivityAt, visible])
  const recency = lastActivityAt === undefined ? undefined : folderIconRecency(lastActivityAt, Date.now())
  const activityLabel = recency?.tone === 'full' ? 'Agent activity within 1 hour'
    : recency?.tone === 'subdued' ? 'Agent activity 1–12 hours ago'
      : recency?.tone === 'quiet' ? 'Agent activity over 12 hours ago'
        : 'Agent activity time unknown'
  // 确认没有图标时画一枚确定性的字母牌，而不是让所有项目共用同一枚灰字形——Rail 上十个项目就是
  // 十枚一模一样的图标，这一列区分不了任何东西，只占宽度（同 host 那条「本机不占位」的规矩）。
  //
  // 只在**探测完成且确认无图标**时才画（`appearance` 非 null 且 `icon` 为 null）：未探测态继续什么都
  // 不画，否则有图标的项目会先闪一枚字母牌再换成真图标——那正是上面那条 class-3 约束要避免的事。
  // 名字给不出可显示的字素时（空名、纯空白）monogram 为空串，如实退回图形字形，不编一个假首字母。
  const monogram = appearance && !appearance.icon ? projectMonogram(name) : ''
  return <span
    className="project-rail-row__icon"
    data-space-icon-source="automatic"
    title={appearance ? `${appearance.kind === 'repository' ? 'Git project' : 'Project folder'}${appearance.icon && recency ? ` · ${activityLabel}` : ''}` : undefined}
    {...(monogram ? { 'data-monogram': '' } : {})}
  >
    {appearance === null ? null
      : appearance.icon ? <img src={appearance.icon} alt="Project icon" data-folder-icon-recency={recency?.tone} onError={() => setAppearance({ ...appearance, icon: null })} />
      : monogram ? <span aria-hidden="true">{monogram}</span>
      : appearance.kind === 'repository' ? <GitBranch size={15} /> : <Folder size={15} />}
  </span>
}
