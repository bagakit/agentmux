import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mote-object-navigation.config.mts'
const variants = {
  'drop-private-entry': ['apps/desktop/src/renderer/src/components/MoteThreadsPanel.tsx', 'privateChats={visible => <MotePrivateConversations scope={scope} active={visible} />}', ''],
  'wrong-hosting-owner': ['apps/desktop/src/renderer/src/components/MotePrivateConversations.tsx', "{ target }, owner)", "{ target }, undefined)"],
  'wrong-conversation': ['apps/desktop/src/renderer/src/components/MoteSessionConversation.tsx', '({ hostId, agentSessionId }),', "({ hostId, agentSessionId: 'default-agent' }),"],
  'drop-retained-auto': ['apps/desktop/src/renderer/src/components/MoteConversationBrowser.tsx', 'selected.explicit || !fallback ||', 'selected.explicit ||'],
  'hidden-readers-active': ['apps/desktop/src/renderer/src/components/MoteConversationBrowser.tsx', 'active && showDetail && choice.id === current', 'active'],
  'wrong-member-target': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', 'agentSessionId={observed?.control.agentSessionId ?? member.agentSessionId}', "agentSessionId={'default-agent'}"],
} as const
const mutation = process.env.MOTE_PRIVATE_THREADS_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown private Threads mutation')
export default defineConfig({ ...base, cacheDir: '.tmp/mote-private-threads-' + (mutation ?? 'original'), plugins: [...base.plugins ?? [], {
  name: 'actual-private-thread-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|host)|packages\/(?:core|connectors|client-ui))\/.*\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    if (mutation && path === variants[mutation][0]) {
      const [, before, after] = variants[mutation]
      if (original.split(before).length !== 2) throw Error('Expected one actual private Thread mutation anchor: ' + mutation)
      loaded = original.replace(before, after)
    }
    const trace = process.env.MOTE_PRIVATE_THREADS_LOADED
    if (trace) { const hash = (text: string) => createHash('sha256').update(text).digest('hex'); appendFileSync(trace, JSON.stringify({path, raw:hash(readFileSync(id.split('?')[0]!, 'utf8')), original:hash(original), loaded:hash(loaded), mutation:loaded===original?null:mutation})+'\n') }
    return loaded === original ? undefined : { code: loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/mote-private-threads.test.tsx'], passWithNoTests: false, testTimeout: 25000 } })
