import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { MarkdownExcerpt } from '@agentmux/client-ui/components/MarkdownExcerpt'
import { parseAgentMarkdown } from '@agentmux/client-ui/agent-markdown'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('@agentmux/client-ui/agent-markdown', async original => ({ ...await original<typeof import('@agentmux/client-ui/agent-markdown')>(), parseAgentMarkdown: vi.fn((...args: Parameters<typeof parseAgentMarkdown>) => actualParse(...args)) }))
const actualParse = (await vi.importActual<typeof import('@agentmux/client-ui/agent-markdown')>('@agentmux/client-ui/agent-markdown')).parseAgentMarkdown
vi.mock('../src/renderer/src/components/AgentAvatar', async original => ({ ...await original<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
const dom = composerDOM(), select = vi.fn(), parse = vi.mocked(parseAgentMarkdown)
const prose = '根因已确认：\n\n- **第一例已自动 resume**，缺的是续行。\n- Provider 只读旧日志，检查 `native-session`。\n\n### 验证\n[原始记录](https://example.test/records) 与 ~~旧结论~~，*来源* 保留。'
function timeline(id: string, text = prose): AgentTimelineSnapshot {
  return { agentSessionId: id, sourceHostId: 'local', revision: 1, items: [{ id: 'reply', agentSessionId: id, kind: 'assistant_message',
    source: 'native-hook', status: 'complete', title: 'Reply', content: text, createdAt: _batchFixtureEpoch(0, 0, 1), updatedAt: _batchFixtureEpoch(0, 0, 1) }] }
}
function context(id: string, text = prose) {
  const session = composerSession(id)
  const reading = timeline(id, text)
  return { session, reading, card: agentContextForSession(session, reading, '恢复逻辑', composerConfig.workspaces[0], null) }
}
beforeEach(() => { select.mockClear(); parse.mockClear() })

it.each(['Focus', 'Workspace'] as const)('%s renders actual bounded recap through the shared grammar without nested actions or resource reads', async surface => {
  const h = context('markdown-card'), reads = vi.spyOn(api.sessions, 'historyPage'), appearance = vi.spyOn(api.workspaces, 'appearance')
  useAppStore.setState({ sessions: [h.session], timelines: { [h.session.id]: h.reading } })
  const before = useAppStore.getState()
  await dom.render(surface === 'Focus' ? <FocusContextRow context={h.card} selected={false} onSelect={select} />
    : <WorkspaceAgentRow context={h.card} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => select(h.session.id)} />)
  const card = dom.container.querySelector<HTMLButtonElement>(`button[data-session-id="${h.session.id}"]`)!
  const excerpt = card.querySelector('.focus-context__recap .markdown-excerpt')!
  expect(excerpt).not.toBeNull(); expect(excerpt.querySelector('strong')?.textContent).toBe('第一例已自动 resume')
  expect(excerpt.querySelector('code')?.textContent).toBe('native-session'); expect(excerpt.querySelector('em')?.textContent).toBe('来源')
  expect(excerpt.querySelector('del')?.textContent).toBe('旧结论'); expect(excerpt.textContent).toContain('原始记录')
  expect(excerpt.textContent).not.toMatch(/\*\*|###|\]\(https/)
  expect(excerpt.querySelectorAll('button,a,input,img,table,pre')).toHaveLength(0)
  expect(card.querySelectorAll('button')).toHaveLength(0)
  expect(card.querySelector('.focus-context__activity')?.textContent).toBe(h.card.detail)
  expect(card.querySelector<HTMLElement>('.focus-context__state')!.title).toContain('No current work signal has been received')
  expect(card.getAttribute('aria-label')).toContain('Activity not confirmed')
  expect(card.getAttribute('aria-label')).toContain('Prompt readiness ready')
  expect(h.card.detailKind).toBe('observation'); expect(h.card.activitySemantic).toBe('unknown')
  expect(reads).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled()
  expect(parse).toHaveBeenCalledWith(prose)
  await act(async () => card.click()); expect(select).toHaveBeenCalledExactlyOnceWith(h.session.id)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(h.reading.items[0]!.content).toBe(prose); expect(h.card.recap!.reading!.text).toBe(prose)
})

it('bounds parsing before work and preserves the complete held reading and original card on unrelated output', async () => {
  const long = '**短结论**\n\n' + '长正文和原样内容。'.repeat(300), h = context('long-card', long)
  useAppStore.setState({ sessions: [h.session], timelines: { [h.session.id]: h.reading } })
  await dom.render(<FocusContextRow context={h.card} selected={false} onSelect={select} />)
  const card = dom.container.querySelector('.focus-context')!, excerpt = card.querySelector('.markdown-excerpt')!
  expect(parse).toHaveBeenCalledTimes(1); expect(parse.mock.calls[0]![0].length).toBeLessThanOrEqual(800)
  expect(parse.mock.calls[0]![0]).toContain('\n\n'); expect(excerpt.textContent).toContain('短结论')
  expect(excerpt.textContent!.length).toBeLessThan(800); expect(h.card.recap!.reading!.text).toBe(long)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 1 })) })))
  expect(dom.container.querySelector('.focus-context')).toBe(card); expect(card.querySelector('.markdown-excerpt')).toBe(excerpt)
  expect(parse).toHaveBeenCalledTimes(1)
})

it('keeps code literal, image labels and ordered/task/table meaning without full Markdown readers or IO', async () => {
  await dom.render(<MarkdownExcerpt content={'### 结果\n\n3. 已完成\n4. 下一步\n\n- [x] 已核对\n\n```text\n**literal**\n```\n\n![设计图](https://example.test/private.png)\n\n| 项目 | 结果 |\n| --- | --- |\n| 检查 | 通过 |'} />)
  const excerpt = dom.container.querySelector('.markdown-excerpt')!
  expect(excerpt.textContent).toContain('结果 · 3. 已完成 · 4. 下一步')
  expect(excerpt.textContent).toContain('☑ 已核对'); expect(excerpt.querySelector('code')?.textContent).toBe('**literal**')
  expect(excerpt.querySelector('strong')).toBeNull(); expect(excerpt.textContent).toContain('设计图'); expect(excerpt.textContent).toContain('项目 | 结果 · 检查 | 通过')
  expect(excerpt.querySelectorAll('button,a,input,img,table,pre,iframe')).toHaveLength(0)
})

it.each(['waiting', 'error', 'disconnected', 'disconnected-without-detail', 'interrupted', 'unobserved', 'exited'] as const)('retains direct %s service information and the original state glyph', async kind => {
  const h = context('service-' + kind)
  if (kind === 'interrupted' || kind === 'unobserved') h.session.processState = 'interrupted'
  else if (kind === 'exited') h.session.processState = 'exited'
  if (kind === 'unobserved') h.session.runUnobserved = true
  h.session.status = { state: kind === 'interrupted' || kind === 'unobserved' ? 'running' : kind === 'disconnected-without-detail' ? 'disconnected' : kind, source: 'run-process', observedAt: Date.now(), ...(kind === 'disconnected-without-detail' ? {} : { detail: 'Original service reason' }) }
  const c = agentContextForSession(h.session, h.reading, '准确目标', composerConfig.workspaces[0], null)
  useAppStore.setState({ sessions: [h.session], timelines: { [h.session.id]: h.reading } })
  await dom.render(<FocusContextRow context={c} selected={false} onSelect={select} />)
  expect(c.detailKind).toBe('service')
  const card = dom.container.querySelector('.focus-context')!
  expect(card.querySelector('.focus-context__detail')!.textContent).toContain(c.detail)
  expect(card.querySelector('.focus-state-mark svg')).not.toBeNull()
  expect(card.getAttribute('aria-label')).toContain(c.detail)
})

it('keeps Mote identity service visible even when that same Agent activity is unknown', async () => {
  const h = context('mote-card'), card = { ...h.card, detailKind: 'service' as const, detail: 'Mote identity is not confirmed · Original source is kept' }
  await dom.render(<FocusContextRow context={card} selected={false} onSelect={select} />)
  expect(dom.container.querySelector('.focus-context__activity')?.textContent).toBe(card.detail)
  expect(dom.container.querySelector('.markdown-excerpt')?.textContent).toContain('根因已确认')
})
