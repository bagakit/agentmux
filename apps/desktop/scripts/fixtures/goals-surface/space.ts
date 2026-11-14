import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import type { goalPlanPreview } from './plan'

/** Preview DTOs only. The real App and Goal consumers own rendering and actions. */
export function goalSpacePreview(seed: (mode: string) => void, plan: ReturnType<typeof goalPlanPreview>, render: () => void) {
  return {
    seed(scene: 'empty' | 'saved-plan' | 'long-title') {
      if (scene === 'saved-plan') plan.seed()
      else seed('one')
      const state = useAppStore.getState(), id = scene === 'saved-plan' ? state.selectedDemandId! : Object.keys(state.demands)[0]!
      const original = state.demands[id]!
      const longTitle = '建立统一的主题系统与语义图标：Light、辐射4与复古未来 — Theme palette and semantic icons across every original workspace'
      const longIntent = '# 主题系统与语义图标\n\n' +
        '我们希望 Light、辐射4式的复古未来表达都能沿同一语义层工作：主题改变外观，原始对象、操作含义和工作面保持清楚。\n\n' +
        '## 一、主题与颜色 / Theme foundations\n\n阅读 `apps/desktop/src/renderer/src/styles/tokens.css` 与 `packages/client-ui/src/styles/palette.css`，区分画布、Surface、文字和强调色。不要用颜色推断 Agent 或请求是否完成。\n\n' +
        '## 二、语义图标 / Semantic icons\n\n- Goal、任务、原始来源与工作状态各有准确语义。\n- Light 与复古未来主题复用同一操作，不因为换外观而丢失未保存原文。\n- 窄工作面自然换行，代码路径与中英文长标题不缩字号。\n\n' +
        '## 三、可核查的最小尝试\n\n' + Array.from({ length: 10 }, (_, index) => `${index + 1}. 在当前主题检查完整 Goal、原 Session / Host 与尚未确认的请求；保留真实上下文，不制造已经完成的任务或进度。`).join('\n\n') +
        '\n\n## Four: Keep the original intent\n\nThe original Markdown remains readable and editable. A temporary Runtime outage must preserve the same workspace and every exact unsent word.'
      const goal = scene === 'long-title' ? { ...original, title: longTitle, description: longIntent } : original
      flushSync(() => {
        useAppStore.setState({ demands: { ...state.demands, [id]: goal }, selectedDemandId: id, mainSurface: 'board' })
        render()
      })
      return { id, title: goal.title, description: goal.description, plan: goal.plan ?? null }
    },
    facts() {
      const state = useAppStore.getState(), goal = state.demands[state.selectedDemandId!]!
      return { id: goal.id, title: goal.title, description: goal.description, plan: goal.plan ?? null,
        draft: state.goalEditDrafts[goal.id] ?? null, originalRequests: state.goalDiscussionRequests,
        runs: state.sessions.filter(session => session.kind === 'agent').map(session => session.control) }
    }
  }
}
