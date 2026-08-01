import { afterEach, describe, expect, it, vi } from 'vitest'

const fileApi = vi.hoisted(() => {
  const writes: Array<{
    workspaceId: string
    input: { path: string; content: string; expectedRevision: string | null }
    resolve(value: unknown): void
  }> = []
  return {
    writes,
    api: {
      files: {
        write(
          workspaceId: string,
          input: { path: string; content: string; expectedRevision: string | null }
        ) {
          return new Promise((resolve) => writes.push({ workspaceId, input, resolve }))
        },
        read: () => new Promise(() => {}),
        observe: async () => {},
        unobserve: async () => {},
        onInvalidated: () => () => {}
      }
    }
  }
})

vi.mock('../src/renderer/src/lib/api.js', () => ({ api: fileApi.api }))

import type { AppConfig, FileDocument, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  documentKey,
  fileTabId,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 保存一份 Scratch Topic 文档也必须让文件树的失效计数前进。
//
// 为什么单独一个文件：`workspace-file-revision.test.ts` 那族行为断言只跑到了三个写入面
// （建 Topic / 改标题 / 建笔记），另两个从来没被执行过——实测把 `store.ts:1138` 这处的实参
// 换成 `{}`（清掉别人的计数）、传错 workspace id、或者整段删掉，那 8 条断言全绿。
// 「同一个函数算得对」加上「源码里有那行字」，仍然不等于「这个调用点被执行过、且算得对」。
//
// 分文件的原因是 mock 面不同：那一族用的是 web-preview 的真 api（要让 createScratchTopic
// 真的落地），而这条必须掌控 `api.files.write` 的时序才能走到 `status: 'written'` 那一支。
// 同一个文件里 `vi.mock` 是模块级的，两者不能共存。
//
// 症状：用户在编辑器里改完 Topic 正文按 Cmd+S，盘上写成功了，而文件树里那个文件的大小/时间
// 不更新——直到别的写入面碰巧 bump 一次。同一形状在 #266 复审里已经被抓到过一次。
// ---------------------------------------------------------------------------

const BYSTANDER_REVISION = 41
const TARGET_REVISION = 7

const TOPIC_ID = 'launcher:20260903-120000'
/** Scratch Topic 正文的真实路径形状：`topic--<日期>--<后缀>/topic.md`。 */
const TOPIC_DOCUMENT_PATH = `${scratchTopicDirectoryName(TOPIC_ID)}/topic.md`

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
  fileApi.writes.splice(0)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for the file Store operation')
}

/**
 * 摆一个打开着的 Scratch Topic 文档，并给失效计数摆上两格。
 *
 * 旁观者那格取一个**非零且不相邻**的数：写成常量、把整张表换成 `{}`、或者 bump 到错的键，
 * 都会让它变成 undefined 或 1，与 41 一眼可分。
 */
function seedScratchTopicDocument(path: string = TOPIC_DOCUMENT_PATH): {
  tab: WorkbenchTab
  key: string
} {
  const workspace: WorkspaceRecord = {
    id: SCRATCH_WORKSPACE_ID,
    name: 'Scratch',
    hostId: 'local',
    path: '/scratch',
    kind: 'folder'
  }
  const config: AppConfig = {
    version: 7,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces: [workspace, { id: 'bystander', name: 'Other', hostId: 'local', path: '/other', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }
  const document: FileDocument = { path, content: 'before', revision: 'revision-before' }
  const tabId = fileTabId(workspace.id, path)
  const tab = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'file',
    workspaceId: workspace.id,
    path
  })
  const key = documentKey(workspace.id, path)
  useAppStore.setState({
    config,
    activeWorkspaceId: workspace.id,
    tabs: { [tab.id]: tab },
    documents: { [key]: document },
    dirtyDocuments: { [key]: false },
    documentGenerations: { [key]: 0 },
    documentObservationGenerations: { [key]: 0 },
    documentIssues: {},
    savingDocuments: {},
    layouts: {
      [workspace.id]: createWorkspaceLayout('scratch-pane', [tab.id]),
      bystander: createWorkspaceLayout('other-pane')
    },
    workspaceFileRevisions: {
      [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
      bystander: BYSTANDER_REVISION
    }
  })
  return { tab, key }
}

function revisions(): Record<string, number> {
  return useAppStore.getState().workspaceFileRevisions
}

/** 把一次保存跑到底：改内容 → 保存 → 让 write 回一个成功回执。 */
async function saveOnce(tab: WorkbenchTab, content: string): Promise<void> {
  useAppStore.getState().updateDocument(tab.id, content)
  const saving = useAppStore.getState().saveDocument(tab.id)
  await waitFor(() => fileApi.writes.length === 1)
  fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-after' })
  await saving
}

describe('保存 Scratch Topic 文档让文件树失效', () => {
  it('前提自检：fixture 真的把两格都摆上了，判据没有从零开始', () => {
    // 初值是 undefined 时，「+1 之后是 8」会退化成「是 1」，而常量实现也给 1。
    seedScratchTopicDocument()
    expect(revisions()).toEqual({
      [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
      bystander: BYSTANDER_REVISION
    })
  })

  it('前提自检：这次保存真的走到了写成功那一支', async () => {
    // 保存被前面的守卫拦掉（不脏、有冲突、tab 不见了）时，「计数没动」会与「漏 bump」
    // 完全同形。所以先钉住这次写确实发生、且落的是我们给的路径。
    const { tab, key } = seedScratchTopicDocument()
    await saveOnce(tab, 'after')

    expect(fileApi.writes).toHaveLength(1)
    expect(fileApi.writes[0]!.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(fileApi.writes[0]!.input.path).toBe(TOPIC_DOCUMENT_PATH)
    expect(useAppStore.getState().documents[key]!.revision).toBe('revision-after')
  })

  it('目标 Workspace +1，旁观者分毫不动', async () => {
    const { tab } = seedScratchTopicDocument()
    await saveOnce(tab, 'after')

    expect(
      revisions()[SCRATCH_WORKSPACE_ID],
      '保存 Topic 正文没有让文件树失效——树会一直显示旧的文件信息'
    ).toBe(TARGET_REVISION + 1)
    expect(revisions().bystander, '别的 Workspace 的计数被动了').toBe(BYSTANDER_REVISION)
  })

  it('连保两次就前进两格——不是「设成某个常量」', async () => {
    // 单看一次调用，`+ 1` 与「写成 8」无法区分。
    const { tab } = seedScratchTopicDocument()
    await saveOnce(tab, 'after')
    fileApi.writes.splice(0)
    await saveOnce(tab, 'after again')

    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(TARGET_REVISION + 2)
  })

  it('保存 Scratch 里一份普通文件不 bump——这条 bump 是 Topic 专属的', async () => {
    // 反向边界。判据故意落在**同一个 Workspace**：若实现改成「只要在 scratch 里就 bump」，
    // 上面那条正向断言照旧绿，只有这条会红。Topic 正文之外的文件由文件树自己的观察者管，
    // 这里多 bump 一次是每次按 Cmd+S 都让整棵树重扫。
    const { tab } = seedScratchTopicDocument('notes/plain.md')
    await saveOnce(tab, 'after')

    expect(fileApi.writes).toHaveLength(0 + 1)
    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(TARGET_REVISION)
  })
})
