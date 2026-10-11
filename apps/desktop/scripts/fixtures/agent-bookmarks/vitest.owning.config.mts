import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import shared from '../agent-input-recall/vitest.recall.config.mts'
const root=resolve(import.meta.dirname,'../../../../..')
export default defineConfig({ ...shared, cacheDir: '.tmp/agent-bookmarks/vitest',
  plugins:[...shared.plugins ?? [],{name:'agent-bookmark-consumers',enforce:'pre',transform(code,id){
    const path=relative(root,id.split('?')[0]!), mutation=process.env.AGENT_BOOKMARK_MUTATION
    let served=code
    const changes:Record<string,[string,string,string]>={
      multiple:['apps/desktop/src/renderer/src/lib/agent-information-preview.ts','...current.filter(item => item.pinned),','...[],'],
      subject:['apps/desktop/src/renderer/src/lib/agent-bookmark-reading.ts','bySubject.get(JSON.stringify([host, sid]))','bySubject.get(JSON.stringify(["neighbor-host", sid]))'],
      reading:['apps/desktop/src/renderer/src/components/AgentInformationReader.tsx','if (request.bookmark && !protectedNow && changedReading','if (request.bookmark && changedReading'],
      geometry:['apps/desktop/src/renderer/src/lib/use-agent-bookmark-window.ts','if (commit && changed && bookmark)','if (false && commit && changed && bookmark)'],
      cancel:['apps/desktop/src/renderer/src/lib/use-agent-bookmark-window.ts','markWindowOverlayDismissal(event); end(false)','markWindowOverlayDismissal(event); end(true)'],
      preference:['apps/desktop/src/renderer/src/lib/use-agent-bookmark-window.ts','if (commit && changed && bookmark)','if (commit && bookmark)'],
      focus:['apps/desktop/src/renderer/src/components/AgentInformationReader.tsx','onFocus={() => { cancelDeparture(); if (request.bookmark) agentBookmarks.bringToFront(request.bookmark.key) }}','onFocus={cancelDeparture}']
    }
    const change=mutation?changes[mutation]:undefined
    if(change&&path===change[0]){if(code.split(change[1]).length!==2)throw Error('One exact bookmark consumer required');served=code.replace(change[1],change[2])}
    if(process.env.AGENT_BOOKMARK_LOADED&&(path.startsWith('apps/desktop/src/')||path.startsWith('packages/client-ui/src/')))appendFileSync(process.env.AGENT_BOOKMARK_LOADED,JSON.stringify({path,sourceSha256:createHash('sha256').update(code).digest('hex'),servedSha256:createHash('sha256').update(served).digest('hex'),mutated:code!==served})+'\n')
    return code===served?undefined:{code:served,map:null}
  }}],test: { ...shared.test, include: ['apps/desktop/test/agent-bookmarks.integration.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
