import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { editGoalDraft } from '../../../src/renderer/src/lib/goal-edit-drafts'
import type { goalSpacePreview } from './space'

/** Private preview DTOs. Actual App/Goal/Focus consumers own all rendering. */
export function goalHierarchyPreview(space: ReturnType<typeof goalSpacePreview>, render: () => void) {
  return {
    seed(scene: 'empty' | 'saved-plan' | 'long-pending' | 'team-unknown' | 'pending-draft') {
      const basic = space.seed(scene === 'saved-plan' ? 'saved-plan' : scene === 'long-pending' ? 'long-title' : 'empty')
      const state = useAppStore.getState(), original = state.demands[basic.id]!
      let goal = original
      if (scene === 'long-pending' || scene === 'pending-draft') goal = { ...goal, alignment: {
        revision: 1, confirmedAt: null,
        summary: '建立语义一致的主题和图标系统，保留每个原始工作面及未保存内容。',
        criteria: [{ id: 'readable', text: 'Light 与复古未来主题下，长中英标题、真实状态和下一步在宽窄工作面均可读。' },
          { id: 'preserve', text: '主题与布局变化保全原 Goal、Session、请求与逐字草稿，不用装饰判断控制状态。' }],
        openQuestions: []
      } }
      let sessions = state.sessions, config = state.config!, names = state.agentNames
      if (scene === 'team-unknown') {
        const source = state.sessions.find(session => session.kind === 'agent')!
        const actor = (id: string, hostId: string, agentSessionId: string) => ({ ...source, id, hostId,
          control: { ...source.control, hostId, agentSessionId, run: { runId: `${id}-original-run` } } })
        const atlas = actor('team-atlas-view', 'team-main-host', 'team-atlas')
        const ambiguous = [actor('team-ambiguous-a-view', 'team-host-a', 'ambiguous-team'), actor('team-ambiguous-b-view', 'team-host-b', 'ambiguous-team')]
        sessions = [...sessions, atlas, ...ambiguous]
        names = { ...names, [atlas.id]: 'Atlas · 主题与语义图标负责人 / Theme and semantic icons',
          [ambiguous[0]!.id]: 'Earlier Agent · Host A', [ambiguous[1]!.id]: 'Earlier Agent · Host B' }
        const hosts = ['team-main-host', 'team-host-a', 'team-host-b']
        config = { ...config, hosts: [...config.hosts.filter(host => !hosts.includes(host.id)),
          ...hosts.map(id => ({ id, kind: 'ssh' as const, hostname: `${id}.invalid`, label: id }))] }
        goal = { ...goal, supervisorSessionId: 'team-atlas', assigneeSessionIds: ['team-atlas'], sessionIds: ['team-atlas', 'ambiguous-team'] }
      }
      flushSync(() => {
        useAppStore.setState({ demands: { ...state.demands, [goal.id]: goal }, sessions, config, agentNames: names,
          goalEditDrafts: {}, selectedDemandId: goal.id, mainSurface: 'board' })
        if (scene === 'pending-draft') editGoalDraft(goal.id, 'title', '尚未确认的原标题草稿 / Original title draft')
        render()
      })
      return { id: goal.id, title: goal.title, description: goal.description, plan: goal.plan ?? null, alignment: goal.alignment ?? null }
    },
    facts: space.facts
  }
}
