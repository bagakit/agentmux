import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// T-001 竖切闭合检查。
//
// `buildTopicBoardRows` 是纯函数，纯函数的测试全绿也证明不了 Scratch 的 Board 上真的出现了
// Topic 行——那需要渲染面确实调用它。这里用源码断言钉住接线的三个关键点，因为它们各自都是
// "改回去仍然全绿"的缺口：
//
//   1. Board 组件确实按 Workspace 分叉出 Topic 行来源（接回硬编码 Branch 会红）；
//   2. Topic Inbox 带着 Topic 上下文起 Agent，且走既有的 openScratchTopic 绑定路径
//      （另写一份 topicId 推导会红）；
//   3. 列定义与状态归类仍然只有一份（复制第二份会红）。
//
// 用源码断言而非渲染，是因为这三条要证的正是"某段代码接到了某处"，而不是渲染结果长什么样。

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const board = read('../src/renderer/src/components/WorkspaceBoard.tsx')
const boardRows = read('../src/renderer/src/hooks/useBoardRows.ts')
const canvas = read('../src/renderer/src/components/BoardDiscussionCanvas.tsx')
const store = read('../src/renderer/src/store.ts')
const projectBoard = read('../src/renderer/src/lib/project-board.ts')

describe('T-001 Topic rows are wired into the one Board', () => {
  it('renders Topic rows from the parameterized row source on a Scratch workspace', () => {
    // 行来源住在 useBoardRows：Board 主视图与 Board 工具面板都调它，因此"这个 Board 有哪些行"
    // 只有一份答案。分叉本身仍然只发生一次，只是不再住在渲染组件里。
    expect(boardRows).toContain('buildTopicBoardRows(topics, scratch, sessions)')
    expect(boardRows).toContain('buildProjectBranchLanes(snapshot, project.workspaces, sessions)')
    // 消费方吃的是同一个 rows；分叉之后没有第二次按 kind 的判断。
    expect(board).toContain('const { rows } = useBoardRows()')
    expect(board).toContain('filterBoardRows(rows, query, column, binding)')
    // 渲染组件不得再自己构造行——那正是"两份答案"重新长出来的样子。
    expect(board).not.toContain('buildTopicBoardRows(')
    expect(board).not.toContain('buildProjectBranchLanes(')
  })

  it('reuses the Topic panel’s own ordering preference rather than a second order', () => {
    expect(boardRows).toContain('orderTopics(built.map((row) => row.id), topicOrder)')
  })

  it('launches a Topic Inbox Agent through the existing Topic binding path', () => {
    // Canvas 把 Topic 身份交给 store，不自己拼 workspacePath 或 scratchTopicId。
    expect(canvas).toContain('launchBoardAgent(anchor.id, executorId, prompt.trim(), row.id)')
    // store 复用 openScratchTopic 完成绑定——不是第二条 Topic 绑定路径。
    expect(store).toContain('if (topicId) await get().openScratchTopic(topicId)')
    // 绑定没落到预期 Topic 上就失败关闭，不静默起一个不带 Topic 的 Agent。
    expect(store).toContain("throw new Error('Scratch Topic View is unavailable')")
  })

  it('keeps one definition of the columns and one status mapping', () => {
    expect(projectBoard.match(/export const PROJECT_BOARD_COLUMNS/g)).toHaveLength(1)
    expect(projectBoard.match(/export function sessionBoardColumn/g)).toHaveLength(1)
    // 两种行来源都经同一个投影函数产出 runsByColumn。
    expect(projectBoard.match(/boardRowProjection\(\{/g)).toHaveLength(2)
    // 渲染面不自己再判一次状态归类。
    expect(board).not.toContain('sessionBoardColumn')
  })

  it('reuses the shared Topic ownership judgement instead of a second derivation', () => {
    expect(projectBoard).toContain('scratchTopicIdFromWorkspacePath(scratch.path, session.workspacePath)')
    expect(projectBoard).toContain('workspaceOwnsSessionPath(scratch, session)')
  })
})
