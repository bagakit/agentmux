import { describe, expect, it } from 'vitest'
import { sanitizeBrowserElementSelection } from '../src/main/browser-selection.js'
import { auditCaughtFrameAction, auditFrameObservation, auditRejectedFrameAction, auditRestoredFrameRead, auditScopedFrame,
  frameDocuments, frameFixture, issuedFrameActionsCode, navigatedFrameActionCode, run as runFrameOperation } from '../scripts/browser-frame-probe-scenario.mjs'

// Contract tests of Native scenario oracles with explicit fake protocol facts.
// No Desktop, Chromium frame, transfer, physical input or app restart runs here.
const pageUrl = 'http://127.0.0.1:9191/a', label = 'Shared frame action'
type JoinedFrame = { document: string; frameId: string; ref: string; sessionId?: string }
function sample() {
  const names = [...frameDocuments], ids = names.map(name => `frame-${name}`)
  const urlFor = (name: string) => name === 'main' ? pageUrl : `${name.startsWith('remote') ? 'http://localhost:9191' : 'http://127.0.0.1:9191'}/frame-${name}`
  const frames = names.map((name, index) => ({ id: ids[index], url: urlFor(name), loaderId: `loader-${index}` }))
  const tree = { frameTree: { frame: frames[0], childFrames: [
    { frame: frames[1], childFrames: [{ frame: frames[2] }] }, { frame: frames[3], childFrames: [{ frame: frames[4] }] }
  ] } }
  const nodes = names.map((name, index) => ({ ref: `@e${index + 1}`, frameId: ids[index], backendNodeId: index % 3 + 1,
    role: 'button', name: label, depth: index === 0 ? 0 : 1, ...(name.startsWith('remote') ? { sessionId: 'session-remote' } : {}) }))
  const snapshot = { url: pageUrl, navigationId: 'navigation-main', title: 'Frames', nodes, missingFrames: [],
    observation: { scope: { kind: 'page', document: null }, fullObserved: 5, scoped: 5, matched: 5, returned: 5,
      truncated: false, omittedFrames: [] as string[], unlocated: 0, work: { axTrees: 5, axNodes: 10, layoutTrees: 0, cdpCommands: 19 } } }
  const contexts = nodes.map((node, index) => ({ ref: node.ref, selection: { pageUrl: urlFor(names[index]!),
    attributes: { id: `frame-action-${names[index]}` }, tagName: 'BUTTON', accessibleName: label } }))
  const nativeDocuments = names.map((document, index) => ({ document, url: urlFor(document), identity: `native-document-${index}`,
    processId: document.startsWith('remote') ? 199 : 99, frameTreeNodeId: index + 1, actions: 0 }))
  return { tree, snapshot, contexts, nativeDocuments }
}

describe('thin frame Native scenario contract oracles', () => {
  it('joins five nonempty Native document facts and public refs; same sender still owns distinct remote documents', () => {
    const value = sample(), joined = auditFrameObservation(value, pageUrl)
    expect(joined.map((item: JoinedFrame) => [item.document, item.frameId, item.ref])).toEqual(frameDocuments.map((name, index) => [name, `frame-${name}`, `@e${index + 1}`]))
    expect(joined.filter((item: JoinedFrame) => item.sessionId).map((item: JoinedFrame) => item.document)).toEqual(['remote', 'remote-child'])
  })
  it('joins the actual sanitized URL while rejecting another origin, port or document path', () => {
    const value = sample(), nativeUrl = 'http://fixture-user:fixture-pass@127.0.0.1:9191/frame-child?generation=2#changed'
    value.tree.frameTree.childFrames[0]!.frame!.url = nativeUrl
    value.nativeDocuments[1]!.url = nativeUrl
    const selection = sanitizeBrowserElementSelection({
      pageTitle: 'Frames', pageUrl: nativeUrl, tagName: 'button', role: 'button', accessibleName: label,
      selector: '#frame-action-child', text: label, attributes: { id: 'frame-action-child' },
      nearbyText: [], html: '<button id="frame-action-child">Shared frame action</button>',
      rectViewport: { x: 0, y: 0, width: 100, height: 32 }, rectPage: { x: 0, y: 0, width: 100, height: 32 }, isFixed: false
    })
    expect(selection.pageUrl).toBe('http://127.0.0.1:9191/frame-child')
    // This case isolates the URL join; the remaining protocol facts are sample().
    value.contexts[1]!.selection.pageUrl = selection.pageUrl
    expect(() => auditFrameObservation(value, pageUrl)).not.toThrow()
    for (const foreign of ['http://localhost:9191/frame-child', 'http://127.0.0.1:9292/frame-child', 'http://127.0.0.1:9191/frame-child/']) {
      value.contexts[1]!.selection.pageUrl = foreign
      expect(() => auditFrameObservation(value, pageUrl)).toThrow()
    }
  })
  it('joins the real sanitizer id marker and rejects a foreign document marker without retaining data attributes', () => {
    const value = sample(), contexts = value.contexts.map((context, index) => ({ ref: context.ref,
      selection: sanitizeBrowserElementSelection({
        pageTitle: 'Frames', pageUrl: context.selection.pageUrl, tagName: 'button', role: 'button', accessibleName: label,
        selector: `#frame-action-${frameDocuments[index]}`, text: label,
        attributes: { id: `frame-action-${frameDocuments[index]}`, 'data-document': frameDocuments[index] },
        nearbyText: [], html: `<button id="frame-action-${frameDocuments[index]}">${label}</button>`,
        rectViewport: { x: 0, y: 0, width: 100, height: 32 }, rectPage: { x: 0, y: 0, width: 100, height: 32 }, isFixed: false
      }) }))
    expect(contexts.map(context => context.selection.attributes)).toEqual(frameDocuments.map(document => ({ id: `frame-action-${document}` })))
    expect(() => auditFrameObservation({ ...value, contexts }, pageUrl)).not.toThrow()
    contexts[1]!.selection.attributes.id = 'frame-action-remote'
    expect(() => auditFrameObservation({ ...value, contexts }, pageUrl)).toThrow()
    contexts[1]!.selection.attributes.id = 'unrelated-marker'
    expect(() => auditFrameObservation({ ...value, contexts }, pageUrl)).toThrow()
  })
  it('rejects an entirely empty block of observed targets and matching context reads', () => {
    const value = sample(); value.snapshot.nodes = []; value.contexts = []
    expect(() => auditFrameObservation(value, pageUrl)).toThrow('All five actual documents')
  })
  it('rejects a same-process document collapsed into its sender and a real ref returned for another frame', () => {
    const collapsed = sample(); collapsed.snapshot.nodes[2]!.frameId = collapsed.snapshot.nodes[1]!.frameId
    expect(() => auditFrameObservation(collapsed, pageUrl)).toThrow('Documents cannot collapse')
    const wrong = sample(); wrong.contexts[1]!.selection.attributes.id = 'frame-action-main'
    expect(() => auditFrameObservation(wrong, pageUrl)).toThrow()
  })
  it('rejects a silent missing OOPIF sender and a same-process target labelled as an independent session', () => {
    const remote = sample(); delete remote.snapshot.nodes[3]!.sessionId
    expect(() => auditFrameObservation(remote, pageUrl)).toThrow('actual OOPIF sender')
    const local = sample(); local.snapshot.nodes[1]!.sessionId = 'session-remote'
    expect(() => auditFrameObservation(local, pageUrl)).toThrow()
  })
  it('does not claim complete Native observation with missing reads or output truncation', () => {
    const missing = sample()
    const missingValue = { ...missing, snapshot: { ...missing.snapshot, missingFrames: [{ frameId: 'frame-child', reason: 'unavailable' }] } }
    expect(() => auditFrameObservation(missingValue, pageUrl)).toThrow()
    const clipped = sample(); clipped.snapshot.observation.truncated = true
    expect(() => auditFrameObservation(clipped, pageUrl)).toThrow()
  })
  it('joins local CDP IDs and independent Native targets without assuming the main sender exposes remote nested trees', () => {
    const value = sample(); value.tree.frameTree.childFrames.pop()
    const joined = auditFrameObservation(value, pageUrl)
    expect(joined.map((item: JoinedFrame & { independentlyJoinedMainCdpTree: boolean }) => [item.document, item.independentlyJoinedMainCdpTree]))
      .toEqual([['main', true], ['child', true], ['nested', true], ['remote', false], ['remote-child', false]])
    value.nativeDocuments = []
    expect(() => auditFrameObservation(value, pageUrl)).toThrow()
  })
  it('pins withinRef to its actual document, excludes other documents and retains the real five-tree cost', () => {
    const value = sample(), joined = auditFrameObservation(value, pageUrl)
    const scoped = { ...value.snapshot, nodes: [value.snapshot.nodes[1]!], observation: { ...value.snapshot.observation,
      scope: { kind: 'subtree', document: 'frame-child' }, fullObserved: 5, scoped: 1, matched: 1, returned: 1,
      omittedFrames: ['frame-main', 'frame-nested', 'frame-remote', 'frame-remote-child'] } }
    expect(() => auditScopedFrame(scoped, joined, 'child', 'subtree')).not.toThrow()
    scoped.nodes[0]!.frameId = 'frame-main'
    expect(() => auditScopedFrame(scoped, joined, 'child', 'subtree')).toThrow()
    scoped.nodes[0]!.frameId = 'frame-child'
    scoped.observation.work.axTrees = 1
    expect(() => auditScopedFrame(scoped, joined, 'child', 'subtree')).toThrow('underlying document work')
  })
  it('does not turn scope exclusions into missing reads or allow an empty scoped result', () => {
    const value = sample(), joined = auditFrameObservation(value, pageUrl)
    const scoped = { ...value.snapshot, nodes: [value.snapshot.nodes[0]!], observation: { ...value.snapshot.observation,
      scope: { kind: 'subtree', document: 'frame-main' }, returned: 1,
      omittedFrames: ['frame-child', 'frame-nested', 'frame-remote', 'frame-remote-child'] } }
    expect(() => auditScopedFrame(scoped, joined, 'main', 'subtree')).not.toThrow()
    scoped.observation.omittedFrames = []
    expect(() => auditScopedFrame(scoped, joined, 'main', 'subtree')).toThrow()
    scoped.nodes = []
    expect(() => auditScopedFrame(scoped, joined, 'main', 'subtree')).toThrow()
  })
  it('requires an actually failed old-ref click step; a successful retarget or an empty trace cannot pass', () => {
    const report = { outcome: { kind: 'script-failed' }, runOperation: { steps: [{ method: 'click', status: 'failed' }] } }
    expect(() => auditRejectedFrameAction(report)).not.toThrow()
    report.outcome.kind = 'completed'
    expect(() => auditRejectedFrameAction(report)).toThrow('fresh successful action')
    report.outcome.kind = 'script-failed'; report.runOperation.steps = []
    expect(() => auditRejectedFrameAction(report)).toThrow()
  })
  it('a caught same-run supersession needs its real failed step and exactly six completed actions', () => {
    const report = { outcome: { kind: 'completed' }, result: { supersededError: '@e2 was superseded by a later snapshot in this run.' },
      runOperation: { steps: [...Array.from({ length: 6 }, () => ({ method: 'click', status: 'completed' })), { method: 'click', status: 'failed' }] } }
    expect(() => auditCaughtFrameAction(report)).not.toThrow()
    report.result.supersededError = ''
    expect(() => auditCaughtFrameAction(report)).toThrow()
    report.result.supersededError = '@e2 was superseded by a later snapshot in this run.'
    report.runOperation.steps = report.runOperation.steps.filter(step => step.status === 'completed')
    expect(() => auditCaughtFrameAction(report)).toThrow()
  })
  it('ordinary old-ref reads disclose appearance recovery and cannot include an action', () => {
    const report = { outcome: { kind: 'indeterminate' }, result: { attributes: { id: 'frame-action-main' }, pageUrl },
      runOperation: { warning: 'This match is by appearance, not identity: it can land on a different element.', steps: [{ method: 'elementContext', status: 'completed' }] } }
    expect(() => auditRestoredFrameRead(report, pageUrl)).not.toThrow()
    report.outcome.kind = 'completed'
    expect(() => auditRestoredFrameRead(report, pageUrl)).toThrow('lossy notice')
    report.outcome.kind = 'indeterminate'; report.runOperation.warning = ''
    expect(() => auditRestoredFrameRead(report, pageUrl)).toThrow()
    report.runOperation.warning = 'by appearance, not identity'; report.runOperation.steps.push({ method: 'click', status: 'completed' })
    expect(() => auditRestoredFrameRead(report, pageUrl)).toThrow()
  })
  it('the actual thin consumer reads only SuccessReceipt.result and validates the original operation/Browser and nonempty trace', async () => {
    let mode = 'actual'
    const ctx = { browserId: 'browser-original', receipt: { frames: { operations: [] } },
      requestControl: async (request: { operationId: string; browserId: string }) => {
        const report = { outcome: { kind: 'completed' }, result: 7, runOperation: {
          id: mode === 'foreign-operation' ? 'other-operation' : request.operationId,
          browserId: mode === 'foreign-browser' ? 'other-browser' : request.browserId,
          steps: mode === 'empty' ? [] : [{ method: 'snapshot', status: 'completed' }] } }
        return mode === 'legacy-body' ? { ok: true, operation: 'browser.run', ...report }
          : { ok: true, operation: 'browser.run', result: report }
      } }
    const report = await runFrameOperation(ctx, 'return await snapshot()')
    expect(report.result).toBe(7); expect(ctx.receipt.frames.operations).toEqual([report.runOperation])
    for (mode of ['legacy-body', 'foreign-operation', 'foreign-browser', 'empty']) {
      await expect(runFrameOperation(ctx, 'return await snapshot()')).rejects.toThrow()
      expect(ctx.receipt.frames.operations).toEqual([report.runOperation])
    }
  })
  it('executes issued-ref scope and supersession in one generated program, without a second run or ledger path', async () => {
    const value = sample(), events: string[] = [], scoped = { ...value.snapshot, nodes: [{ ...value.snapshot.nodes[1]!, ref: '@e6' }] }
    let issued = false
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const execute = new AsyncFunction('cdp', 'snapshot', 'elementContext', 'click', issuedFrameActionsCode())(
      async () => value.tree,
      async (query: { withinRef?: string }) => {
        events.push(`snapshot:${query.withinRef ?? 'page'}`)
        if (query.withinRef) { expect(query.withinRef).toBe('@e2'); issued = true; return scoped }
        return value.snapshot
      },
      async (ref: string) => value.contexts.find(context => context.ref === ref)!.selection,
      async (ref: string) => {
        events.push(`click:${ref}`)
        if (issued && ref !== '@e6') throw new Error(`${ref} was superseded by a later snapshot in this run.`)
      })
    await expect(execute).resolves.toMatchObject({ withinRef: scoped })
    const result = await execute
    expect(events).toEqual(['snapshot:page', 'click:@e1', 'click:@e2', 'click:@e3', 'click:@e4', 'click:@e5', 'snapshot:@e2', 'click:@e6', 'click:@e2'])
    expect(result.snapshot).toBe(value.snapshot); expect(result.withinRef).toBe(scoped)
    expect(result.supersededError).toContain('superseded')
  })
  it('the generated navigation program waits for actual fixture load before consuming the old same-run child ref', async () => {
    const value = sample(), events: string[] = []
    let loaded = false, onLoad: (() => void) | undefined
    const frame = { contentWindow: { frameIdentity: 'new-document', location: { replace: (url: string) => {
      expect(url).toBe('/frame-child?generation=2'); events.push('navigate')
      void Promise.resolve().then(() => { loaded = true; events.push('loaded'); onLoad!() })
    } } }, addEventListener: (event: string, callback: () => void) => { expect(event).toBe('load'); onLoad = callback } }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const execute = new AsyncFunction('snapshot', 'elementContext', 'js', 'click', navigatedFrameActionCode())(
      async () => { events.push('snapshot'); return value.snapshot },
      async (ref: string) => value.contexts.find(context => context.ref === ref)!.selection,
      async (expression: string) => await new AsyncFunction('document', `return ${expression}`)({ querySelector: () => frame }),
      async (ref: string) => { expect(ref).toBe('@e2'); expect(loaded).toBe(true); events.push('old-ref'); throw new Error('stale-ref') })
    await expect(execute).rejects.toThrow('stale-ref')
    expect(events).toEqual(['snapshot', 'navigate', 'loaded', 'old-ref'])
  })
  it('uses two loopback sites and nested actual fixture documents without adding another launcher', () => {
    const main = frameFixture('/a', pageUrl), child = frameFixture('/frame-child?generation=2', pageUrl)
    expect(main).toContain('src="/frame-child"')
    expect(main).toContain('src="http://localhost:9191/frame-remote"')
    expect(child).toContain('src="/frame-nested"')
    expect(frameFixture('/frame-remote', pageUrl)).toContain('src="/frame-remote-child"')
    expect(frameFixture('/frame-budget?id=7', pageUrl)).toContain('id="frame-action-budget-7"')
    expect(main).toContain('frameActions=0')
  })
})
