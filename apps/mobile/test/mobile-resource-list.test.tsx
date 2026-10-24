import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { button, click, fixture, mount, mounted } from './conversation-fixture'

afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } })
it('keeps compact anonymous resource rows, meaningful groups and exact Launcher identity without creating on disclosure', async () => {
  const f = fixture(), create = vi.fn(), open = vi.fn()
  const tab = (id: string, name: string, regionIds: string[]) => ({ tabId: id, zoneId: 'original-zone', workspaceId: 'original-workspace', name, regionIds })
  const catalog = { spaces: [{ spaceId: 'original-space', kind: 'folder', name: '资料协作', hostId: 'original-host', directoryPath: '', projectId: null }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', hostId: 'original-host', kind: 'home', directoryPath: '', branch: null }],
    bindings: [{ spaceId: 'original-space', zoneId: 'original-zone' }], locations: [],
    tabs: [tab('launch-tab','',['launch']),tab('file-tab','',['file']),tab('duplicate-tab','',['duplicate']),tab('named-tab','合作资料',['named']),tab('multiple-tab','',['browser','terminal']),tab('missing-tab','',['unobserved']),tab('named-duplicate','NOTES.md',['named-same'])],
    regions: [{ tabId: 'launch-tab', regionId: 'launch', kind: 'launcher' },
      ...[['file-tab','file'],['duplicate-tab','duplicate'],['named-tab','named'],['named-duplicate','named-same']].map(([tabId,regionId])=>({tabId,regionId,kind:'file',file:{path:'NOTES.md',workspaceId:'original-workspace'}})),
      {tabId:'multiple-tab',regionId:'browser',kind:'browser',browserId:'original-browser'}, {tabId:'multiple-tab',regionId:'terminal',kind:'terminal'}] }
  const rpc = vi.fn().mockResolvedValue({catalog}); Object.assign(f.client,{forwardRpc:rpc})
  const view = await mount(<MobileSpatialNavigation home="space" client={f.client} connected sessions={[]} openSession={open} onCreateAgent={create} />)
  await click(view.element.querySelector('.mobile-space-row')!)
  const headings = [...view.element.querySelectorAll('.mobile-spatial-tab > h3')].map(node=>node.textContent)
  expect(headings).toEqual(['合作资料','多个工作面','内容待确认'])
  expect(view.element.textContent).not.toContain('未命名 Tab')
  expect([...view.element.querySelectorAll('.mobile-spatial-tab strong')].filter(node=>node.textContent==='NOTES.md')).toHaveLength(4)
  expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  await click(button(view.element,'在此启动位新建 Agent'))
  expect(create).toHaveBeenCalledExactlyOnceWith({spaceId:'original-space',zoneId:'original-zone',tabId:'launch-tab',regionId:'launch'})
  expect(rpc).toHaveBeenCalledExactlyOnceWith('space.ls',{target:{},presentation:true})
  expect(f.submit).not.toHaveBeenCalled()
})
