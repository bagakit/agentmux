import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, scratchWorkspace, customMoteId } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { prepareMoteCooperationDraft } from '../src/renderer/src/lib/mote-cooperation'
import { prepareMoteIdeaDraft } from '../src/renderer/src/lib/mote-idea-request'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
let app: MoteAppFixture
const root = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const scope = () => ({ workspace: scratchWorkspace, topic: moteTopics[0]!, rootPath: root })
const read = (params: FileReadParams, revision = 'sha256:' + 'a'.repeat(64)): FileReadResult => ({
  resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + root, path: root + '/' + params.path },
  result: { status: 'read', document: { path: root + '/' + params.path, content: 'Selected saved source', revision } }
})
beforeEach(() => { app = createMoteApp(); vi.spyOn(api.files, 'create').mockResolvedValue(undefined) })
afterEach(async () => { await app.dispose() })
for (const count of [1, 10, 100]) it(`keeps unrelated actual create mutations independent of a ${count}-object catalog`, async () => {
  const topics = Array.from({ length: count }, (_, index) => ({ ...moteTopics[0]!, id: 'launcher:cost-' + index, title: 'Mote ' + index,
    directoryPath: scratchTopicDirectoryName('launcher:cost-' + index) }))
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  vi.mocked(api.scratch.listTopics).mockClear(); vi.mocked(api.scratch.readTopic).mockClear()
  // Original Store producer bumps the Workspace revision. Original roster consumer then reacts.
  await useAppStore.getState().createPath({ path: 'unrelated-note.md', kind: 'file' }, SCRATCH_WORKSPACE_ID)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID)
  expect(api.files.create).toHaveBeenCalledOnce()
  expect(api.scratch.listTopics).not.toHaveBeenCalled(); expect(api.scratch.readTopic).not.toHaveBeenCalled()
  await useAppStore.getState().createPath({ path: topics[0]!.directoryPath + '/SOUL.md', kind: 'file' }, SCRATCH_WORKSPACE_ID)
  expect(api.scratch.readTopic).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, topics[0]!.id)
  expect(api.scratch.listTopics).not.toHaveBeenCalled()
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.map(topic => topic.id)).toEqual(topics.map(topic => topic.id))
})
it('discovers structural membership, preserves last facts on failed target refresh, and honors confirmed kind transitions', async () => {
  vi.mocked(api.scratch.readTopic).mockRejectedValueOnce(new Error('Selected detail temporarily unavailable'))
  await useAppStore.getState().createPath({ path: root + '/SOUL.md', kind: 'file' }, SCRATCH_WORKSPACE_ID)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics).toEqual(moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, readError: expect.stringContaining('temporarily unavailable') } : topic))
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toContain('temporarily unavailable')
  const target = moteTopics.find(topic => topic.id !== PMO_TEAMS_TOPIC_ID && topic.soul)!
  vi.mocked(api.scratch.readTopic).mockResolvedValueOnce({ ...target, soul: undefined, moteArchive: undefined, kind: 'topic' })
  await useAppStore.getState().createPath({ path: target.directoryPath + '/SOUL.md', kind: 'file' }, SCRATCH_WORKSPACE_ID)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.find(topic => topic.id === target.id)?.kind).toBe('topic')
  vi.mocked(api.scratch.listTopics).mockClear()
  await useAppStore.getState().createPath({ path: scratchTopicDirectoryName('launcher:new-object'), kind: 'directory' }, SCRATCH_WORKSPACE_ID)
  expect(api.scratch.listTopics).toHaveBeenCalledOnce()
})
for (const mode of ['cooperation', 'idea'] as const) it(`keeps ${mode} preparation after an unrelated actual file mutation and rechecks selected closed sources`, async () => {
  let finish!: (value: FileReadResult) => void, selected!: FileReadParams
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => read(params))
    .mockImplementationOnce(params => { selected = params; return new Promise(resolve => { finish = resolve }) })
  const otherPath = scratchTopicDirectoryName(customMoteId) + '/topic.md'
  const otherTab = createWorkbenchTab('unrelated-file-tab', { kind: 'file', regionId: 'unrelated-file-region', workspaceId: SCRATCH_WORKSPACE_ID, path: otherPath })
  const key = documentKey(SCRATCH_WORKSPACE_ID, otherPath)
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [otherTab.id]: otherTab }, documents: { ...state.documents, [key]: { path: otherPath, content: 'Before unrelated save', revision: 'old' } },
    documentGenerations: { ...state.documentGenerations, [key]: 0 }, dirtyDocuments: { ...state.dirtyDocuments, [key]: false } }))
  vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved-unrelated' })
  vi.spyOn(api.files, 'move').mockResolvedValue({ status: 'moved' } as Awaited<ReturnType<typeof api.files.move>>)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  const pending = mode === 'cooperation'
    ? prepareMoteCooperationDraft(scope(), undefined, { question: 'Original user question' }, () => true)
    : prepareMoteIdeaDraft(scope(), undefined, { direction: 'Original user direction', includeDiscussion: false }, null, () => true)
  await useAppStore.getState().createPath({ path: 'unrelated-during-read.md', kind: 'file' }, SCRATCH_WORKSPACE_ID)
  useAppStore.getState().updateDocument(otherTab.id, 'Unrelated saved title', 'unrelated-file-region')
  await useAppStore.getState().saveDocument(otherTab.id, 'unrelated-file-region')
  await useAppStore.getState().renamePath(scratchTopicDirectoryName(customMoteId) + '/note.md', scratchTopicDirectoryName(customMoteId) + '/renamed-note.md', SCRATCH_WORKSPACE_ID)
  finish(read(selected))
  const result = await pending
  const selection = 'selection' in result ? result.selection : result
  expect(useAppStore.getState().agentComposerDrafts[selection.regionId]).toContain('Original user')
  expect(api.files.readPublic).toHaveBeenCalledTimes(2)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
for (const mode of ['cooperation', 'idea'] as const) it(`rejects changed closed selected source before ${mode} admission and keeps original drafts`, async () => {
  vi.spyOn(api.files, 'readPublic').mockImplementationOnce(async params => read(params))
    .mockImplementation(async params => read(params, 'sha256:' + 'b'.repeat(64)))
  const before = useAppStore.getState()
  const pending = mode === 'cooperation'
    ? prepareMoteCooperationDraft(scope(), undefined, { question: 'Keep my original question' }, () => true)
    : prepareMoteIdeaDraft(scope(), undefined, { direction: 'Keep my original direction', includeDiscussion: false }, null, () => true)
  await expect(pending).rejects.toThrow('changed')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('retains an original open published after an older full catalog read began', async () => {
  let finish!: (topics: typeof moteTopics) => void
  vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = moteTopics.find(topic => topic.id === customMoteId)!
  const fresh = { ...old, title: 'Confirmed after discovery began' }
  vi.mocked(api.scratch.readTopic).mockResolvedValueOnce(fresh)
  const pending = useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  await useAppStore.getState().openScratchTopic(customMoteId, SCRATCH_WORKSPACE_ID, { reveal: false })
  finish(moteTopics)
  await pending
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.find(topic => topic.id === customMoteId)?.title).toBe(fresh.title)
})
it('keeps a catalog discovery failure visible through a successful targeted refresh', async () => {
  const partial = Object.assign([...moteTopics], { issues: ['An unclaimed directory is not readable'] })
  vi.mocked(api.scratch.listTopics).mockResolvedValueOnce(partial)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  vi.mocked(api.scratch.readTopic).mockResolvedValueOnce(moteTopics[0]!)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true, moteTopics[0]!.id)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toContain('unclaimed directory')
  vi.mocked(api.scratch.listTopics).mockResolvedValueOnce(moteTopics)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toBeNull()
})

for (const mode of ['cooperation','idea'] as const) for (const action of ['later-input','navigation-return'] as const) it(`rejects ${mode} ${action} during final selected-source verification`,async()=>{
 let release!:()=>void;let readingSecond=false,stillCurrent=true,calls=0
 vi.spyOn(api.files,'readPublic').mockImplementation(async params=>{calls++;if(calls===2){readingSecond=true;await new Promise<void>(resolve=>{release=resolve})}return read(params)})
 const before=useAppStore.getState()
 const pending=mode==='cooperation'?prepareMoteCooperationDraft(scope(),undefined,{question:'Earlier original question'},()=>stillCurrent):prepareMoteIdeaDraft(scope(),undefined,{direction:'Earlier original direction',includeDiscussion:false},null,()=>stillCurrent)
 // Attach rejection immediately so no intentionally rejected original preparation becomes unhandled.
 const outcome=pending.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}))
 await vi.waitFor(()=>expect(readingSecond).toBe(true))
 if(action==='later-input')stillCurrent=false
 else{useAppStore.setState({mainSurface:'board'});useAppStore.setState({mainSurface:before.mainSurface})}
 release();const result=await outcome
 expect(result.ok).toBe(false)
 if(!result.ok)expect(String(result.error)).toContain('changed')
 expect(useAppStore.getState().tabs).toBe(before.tabs)
 expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 expect(app.launch).not.toHaveBeenCalled();expect(app.send).not.toHaveBeenCalled()
})

it('keeps failed original target B observation visible after successful unrelated target A refresh',async()=>{
 const a=moteTopics[0]!,b=moteTopics[1]!
 vi.mocked(api.scratch.readTopic).mockRejectedValueOnce(new Error('Original B selected read remains unconfirmed'))
 await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true,b.id)
 expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toContain('Original B')
 vi.mocked(api.scratch.readTopic).mockResolvedValueOnce(a)
 await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true,a.id)
 expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toContain('Original B')
 expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.some(topic=>topic.id===b.id)).toBe(true)
 vi.mocked(api.scratch.readTopic).mockResolvedValueOnce(b)
 await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true,b.id)
 expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toBeNull()
})

it('reads the new original resource scope while the older scope discovery is pending and refuses the old publication',async()=>{
 let finish!:(topics:typeof moteTopics)=>void
 const moved={...scratchWorkspace,path:_hygiene_fixturePath("topics-new")}
 vi.mocked(api.scratch.listTopics).mockClear().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValueOnce(moteTopics.map(topic=>({...topic,title:'New original scope'})))
 const old=useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true)
 useAppStore.setState(state=>({config:{...state.config!,workspaces:state.config!.workspaces.map(workspace=>workspace.id===SCRATCH_WORKSPACE_ID?moved:workspace)}}))
 // This is the maintained useScratchTopics scope-effect call, without forcing a manual retry.
 const fresh=useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID)
 finish(moteTopics);await Promise.all([old,fresh])
 expect(api.scratch.listTopics).toHaveBeenCalledTimes(2)
 expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.scope).toBe(scratchTopicsScope(moved))
 expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics![0]!.title).toBe('New original scope')
})
