import { Bot, FileCode2, Globe2, Sparkles, SquareTerminal } from 'lucide-react'
import type { WorkbenchTabMark } from '../lib/workbench-tab-marks'
import { AgentAvatar } from './AgentAvatar'

/**
 * 标签上的标记簇：把 `workbenchTabMarks` 算出的标记序列画出来。
 *
 * 为什么单独一个文件、而不是留在 `WorkspaceWorkbench` 里：那个文件经 `api.ts` 依赖一个 vite define
 * （`__AGENTMUX_WEB_PREVIEW__`），在 node 里 import 不了，于是这段渲染**无法被任何测试执行到**。实测把
 * `if (true) return null` 插进标记组件的第一行——整个图标簇一个都不画，用户看到的东西完全消失——而
 * workbench 那 50 条测试照旧全绿。搬到这里之后 `workbench-tab-marks.test.ts` 能真渲染它，那次变异才会红。
 *
 * 这里只做「标记 → 图标」的映射，不做任何取值判断：画哪几个标记、要不要去重，全部由
 * `workbenchTabMarks` 决定（见那边的注释）。分开是为了让"该画什么"可被纯函数测试，而这里不留任何能
 * 悄悄偏离它的判断。
 */
export function WorkbenchTabMarks({ marks }: { marks: WorkbenchTabMark[] }) {
  return (
    <span className="workbench-tab__marks">
      {marks.map((mark) => (
        <WorkbenchTabMarkIcon key={mark.regionId} mark={mark} />
      ))}
    </span>
  )
}

/**
 * 一个标记画成哪个图标。
 *
 * 为什么是 `switch` + `default` 里的 never 断言、而不是一条 if 链加裸兜底：实测给 `WorkbenchTabMark`
 * 加一个种类时，原先那条 if 链让 tsc **一个错都不报**——新种类静默走进兜底，画成 launcher 的星星，与
 * 「未知」不可区分。而映射的另一半（`surfaceMark` 的 surface→mark）本来就被 tsc 守着（显式返回类型 +
 * strict，加 surface 种类会报 TS2366）。两侧都由编译器守，这两份清单才不会漂。
 *
 * 为什么 never 断言不能省：本仓没开 `noImplicitReturns`，所以 switch 少一支时 tsc 只是把返回类型放宽成
 * 含 `undefined`，不报错。这一句才是真正让漏掉的种类编译不过的东西。
 */
function WorkbenchTabMarkIcon({ mark }: { mark: WorkbenchTabMark }) {
  switch (mark.kind) {
    case 'agent':
      return (
        <i className="workbench-tab__agent-mark">
          <AgentAvatar providerId={mark.providerId} sessionId={mark.sessionId} executorId={mark.executorId} appearance={mark.appearance} state={mark.status.state} detail={mark.status.detail} size={16} />
        </i>
      )
    case 'terminal':
      return <SquareTerminal size={12} />
    case 'file':
      return <FileCode2 size={12} />
    case 'browser':
      // 被 Agent 驱动的那一格画 Bot，不是地球——它与旁边闲着的 Browser 必须一眼分得开，这正是
      // 这个标记存在的全部理由（页面内角标只在人看着那一页时成立）。`title` 让悬停也说得出来。
      return mark.driving
        ? <Bot size={12} className="workbench-tab__driving-mark"><title>Agent driving</title></Bot>
        : <Globe2 size={12} />
    case 'launcher':
      return <Sparkles size={12} />
    default: {
      const unhandled: never = mark
      throw new Error(`Unhandled workbench tab mark: ${JSON.stringify(unhandled)}`)
    }
  }
}
