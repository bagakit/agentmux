// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MoteInputInspection, MoteInputObservation } from '@agentmux/core'
import { moteInputNoticeWire, parseMoteInputNotice } from '@agentmux/core/mote-input-notice'
import { projectConversationReading } from '@agentmux/core/conversation'
import { normalizeAgentTimelineItem } from '../../core/src/session-timeline'
import { CapturedConversationMessage } from '../src/components/CapturedConversationMessage'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { createDesktopMoteInputReader, desktopMoteMemberName } from '../../../apps/desktop/src/renderer/src/lib/mote-input-reader'
import type { SessionSnapshot } from '../../../apps/desktop/src/shared/contracts'
import { createMobileMoteInputReader } from '../../../apps/mobile/src/conversation/mote-input-reader'

const scope = { hostId: 'original-host', agentSessionId: 'original-primary' }
const originalOwner = { routeHostId: scope.hostId, sourceHostId: 'recorded-source-host', recipientAgentSessionId: scope.agentSessionId }
const source = { spaceId: 'original-mote', zoneId: 'original-zone', tabId: 'original-tab', regionId: 'original-region' }
function observation(): MoteInputObservation {
  return { id: 'original-observation', revision: 2, source, binding: { source, primary: { hostId: 'local', agentSessionId: scope.agentSessionId },
    moteRevision: 'mote-revision', spatialRevision: 2 }, sourceStatus: 'confirmed', issue: null,
    origin: { kind: 'prompt', key: { kind: 'prompt', agentSessionId: 'original-member', expectedRun: { runId: 'original-run' }, submissionId: 'original-input' } },
    input: 'terminal-confirmed', notices: { input: 'original-notice' } }
}
function inspection(value = observation()): MoteInputInspection { return { observation: value, inputText: '保留原计划，只将阈值改为 12。', notices: {} } }
function captured(value = observation(), phase: 'input' | 'result' = 'input', hostId = scope.hostId, sourceHostId = originalOwner.sourceHostId) {
  const wire = moteInputNoticeWire(value, phase)
  const item = normalizeAgentTimelineItem({ id: 'captured-original-notice', agentSessionId: scope.agentSessionId, kind: 'system_message', source: 'agentmux',
    status: 'complete', title: 'AgentMux context', content: wire, a2aNotificationId: 'original-notice',
    inputRef: { kind: 'prompt', agentSessionId: scope.agentSessionId, expectedRun: { runId: 'primary-run' }, submissionId: 'original-notice' },
    createdAt: 1000, updatedAt: 1000 })
  const record = projectConversationReading({ agentSessionId: scope.agentSessionId, routeHostId: hostId, executionHostId: sourceHostId,
    timeline: { agentSessionId: scope.agentSessionId, sourceHostId, revision: 1, items: [item] } }).records[0]!
  return <CapturedConversationMessage item={item} record={record} speaker={{ role: 'system', id: 'agentmux' }} executionHostId={record.executionHostId!}
    conversationSessionId={scope.agentSessionId} describeSpeaker={() => ({ name: 'Aggregated Mote identity' })} />
}
const copy = vi.fn<ClientUiPlatform['copyText']>(async () => true)
const read = vi.fn<NonNullable<ClientUiPlatform['readMoteInput']>>()
const basic: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
  moteMemberName: (owner, member) => owner.routeHostId === scope.hostId && member === 'original-member' ? 'Research member' : undefined }
let element: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); read.mockReset(); read.mockResolvedValue(inspection()); copy.mockClear()
  element = document.createElement('div'); document.body.append(element); root = createRoot(element) })
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals() })
async function render(node: ReactNode, reader: ClientUiPlatform['readMoteInput'] = read, names = basic.moteMemberName) {
  await act(async () => root.render(<ClientUiProvider platform={{ ...basic, ...(reader ? { readMoteInput: reader } : {}), ...(names ? { moteMemberName: names } : {}) }}>{node}</ClientUiProvider>))
}
async function click(selector: string) {
  const node = element.querySelector<HTMLElement>(selector); expect(node).not.toBeNull()
  await act(async () => { node!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
const open = () => click('.conversation-mote-notice__original > summary')

it('actual captured notification is readable without JSON or eager original IO', async () => {
  await render(captured())
  expect(element.querySelector('.conversation-mote-notice')?.textContent).toContain('Research member')
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).toContain('新输入已送入终端，是否采用待确认')
  expect(element.textContent).not.toContain('agentmux.mote-input-notice.v1')
  expect(element.querySelector('.log-turn__system-toggle')).toBeNull()
  expect(read).not.toHaveBeenCalled()
  await click('.conversation-a2a-notice__details > summary')
  expect(element.querySelectorAll('.conversation-mote-notice')).toHaveLength(1)
  expect(element.textContent).toContain(moteInputNoticeWire(observation(), 'input'))
  await click('[aria-label="Copy notification protocol"]')
  expect(copy).toHaveBeenLastCalledWith(moteInputNoticeWire(observation(), 'input'), expect.any(Function))
  expect(read).not.toHaveBeenCalled()
})

it.each([
  { speaker: { role: 'human', id: 'human' } },
  { speaker: { role: 'agent', id: 'other-agent' } },
  { speaker: { role: 'system', id: 'agentmux' } },
  { speaker: { role: 'system', id: 'agentmux' }, a2aNotificationId: 'notice', contentBoundary: 'body' }
] as const)('ordinary JSON never becomes a Mote platform event: %j', async props => {
  await render(<ConversationMessage content={moteInputNoticeWire(observation(), 'input')} messageId="ordinary" {...props} />)
  expect(element.querySelector('.conversation-mote-notice')).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

it('terminal confirmation and native admission have distinct event wording', async () => {
  const value = observation(); await render(captured(value))
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).toContain('是否采用待确认')
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).not.toContain('已接收')
  value.input = 'admitted'; await render(captured(value))
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).toContain('成员已接收新输入')
})

it('the exact Desktop member label never becomes the aggregated Mote identity or an equal ID at another Host', async () => {
  const sessions = [
    { kind: 'agent', id: 'member-presentation', label: '实现与校验', control: { kind: 'agent', hostId: scope.hostId, agentSessionId: 'original-member' } },
    { kind: 'agent', id: 'other-presentation', label: '另一Host的成员', control: { kind: 'agent', hostId: 'other-host', agentSessionId: 'original-member' } }
  ] as unknown as SessionSnapshot[]
  const names: NonNullable<ClientUiPlatform['moteMemberName']> = (owner, member) => desktopMoteMemberName(owner, member, sessions, {})
  await render(captured(), read, names)
  expect(element.querySelector('.conversation-mote-notice__member')?.textContent).toBe('实现与校验')
  expect(element.querySelector('.conversation-mote-notice__member')?.textContent).not.toContain('Aggregated Mote identity')
  expect(names({ ...originalOwner, routeHostId: 'unconfirmed-host' }, 'original-member')).toBeUndefined()
  await render(captured(), read, () => undefined)
  expect(element.querySelector('.conversation-mote-notice__member')?.textContent).toBe('original-member')
  expect(read).not.toHaveBeenCalled()
})

it.each([
  ['permission', 'saved', false, '权限答复已保存，送达待确认'],
  ['permission', 'bytes-accepted', false, '权限答复已送入终端，采用待确认'],
  ['permission', 'hook-written', false, '权限答复已写入原请求通道'],
  ['permission', 'acp-acknowledged', false, '权限答复已获原协议确认'],
  ['permission', 'unknown', false, '权限答复的送达尚未确认'],
  ['question', 'bytes-accepted', true, '问题答复对应的原请求已结束']
] as const)('a recorded %s response keeps original delivery %s and completion %s distinct', async (responseKind, delivery, nativeCompleted, expected) => {
  const value = observation(); value.input = 'interaction-confirmed'
  value.origin = { kind: 'interaction', agentSessionId: 'original-member', runId: 'original-run', operationId: 'original-response' }
  value.result = { kind: 'interaction', requestId: 'original-request', responseKind, delivery, nativeAdoption: 'unknown', nativeCompleted }
  await render(captured(value, 'result'))
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).toContain(expected)
  expect(read).not.toHaveBeenCalled()
})

it('the production Desktop reader routes the original endpoint and member independently of source Host', async () => {
  const inspect = vi.fn(async () => inspection()), adapter = createDesktopMoteInputReader(inspect)
  await render(captured(), adapter); expect(inspect).not.toHaveBeenCalled()
  await open()
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ hostId: scope.hostId, agentSessionId: 'original-member' }, 'original-observation')
  expect(element.querySelector('blockquote')?.textContent).toBe('保留原计划，只将阈值改为 12。')
})

it('the accepted source Host stays provenance while a distinct original route reads the member observation', async () => {
  const inspectMoteInput = vi.fn(async () => inspection())
  const adapter = vi.fn(createMobileMoteInputReader({ inspectMoteInput } as unknown as AgentMuxHostedClient, scope.agentSessionId))
  await render(captured(observation(), 'input', 'local', 'host-original'), adapter)
  expect(inspectMoteInput).not.toHaveBeenCalled(); await open()
  expect(adapter).toHaveBeenCalledExactlyOnceWith({ routeHostId: 'local', sourceHostId: 'host-original', recipientAgentSessionId: scope.agentSessionId }, 'original-member', 'original-observation')
  expect(inspectMoteInput).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'original-member', observationId: 'original-observation' })
  expect(element.querySelector('[data-conversation-item-ref]')?.getAttribute('data-conversation-item-ref')).toContain('host-original')
  expect(element.querySelector('blockquote')?.textContent).toContain('阈值改为 12')
})

it('the production Mobile reader consumes the same original inspection through the selected Hosted owner', async () => {
  const inspectMoteInput = vi.fn(async () => inspection())
  const adapter = createMobileMoteInputReader({ inspectMoteInput } as unknown as AgentMuxHostedClient, scope.agentSessionId)
  await render(captured(observation(), 'input', 'local'), adapter); expect(inspectMoteInput).not.toHaveBeenCalled()
  await open()
  expect(inspectMoteInput).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'original-member', observationId: 'original-observation' })
  expect(element.querySelector('blockquote')?.textContent).toContain('阈值改为 12')
})

it.each([{ ...originalOwner, routeHostId: 'another-host' }, { ...originalOwner, routeHostId: 'local', recipientAgentSessionId: 'another-primary' }])(
  'Mobile keeps an unconfirmed original owner local to this notice: %j', async other => {
    const inspectMoteInput = vi.fn(async () => inspection())
    const adapter = createMobileMoteInputReader({ inspectMoteInput } as unknown as AgentMuxHostedClient, scope.agentSessionId)
    await expect(adapter(other, 'original-member', 'original-observation')).rejects.toThrow('原通知的 Host')
    expect(inspectMoteInput).not.toHaveBeenCalled()
  })

it.each(['id', 'source', 'origin', 'primary'] as const)('a different original %s cannot be shown as this event', async field => {
  const value = inspection()
  if (field === 'id') value.observation.id = 'other-observation'
  if (field === 'source') value.observation.source = { ...source, regionId: 'other-region' }
  if (field === 'origin') value.observation.origin = { kind: 'interaction', agentSessionId: 'other-member', runId: 'run', operationId: 'op' }
  if (field === 'primary') value.observation.binding = { ...value.observation.binding!, primary: { hostId: 'local', agentSessionId: 'other-primary' } }
  read.mockResolvedValue(value); await render(captured()); await open()
  expect(element.textContent).toContain('返回记录未匹配原成员')
  expect(element.querySelector('blockquote')).toBeNull()
  expect(element.querySelector('.conversation-mote-notice__event')).not.toBeNull()
})

it('a delayed original read cannot populate a different source or inherit its open disclosure', async () => {
  let release!: (value: MoteInputInspection) => void
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await render(captured()); await open(); expect(read).toHaveBeenCalledOnce()
  const other = observation(); other.id = 'other-observation'; other.source = { ...source, regionId: 'other-region' }
  await render(captured(other)); await act(async () => release(inspection()))
  expect(element.querySelector('blockquote')).toBeNull()
  expect(element.querySelector<HTMLDetailsElement>('.conversation-mote-notice__original')?.open).toBe(false)
  expect(read).toHaveBeenCalledOnce()
})

it('a late response cannot cross the original reading route even when notification and source IDs are equal', async () => {
  let release!: (value: MoteInputInspection) => void
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await render(captured()); await open()
  await render(captured(observation(), 'input', 'another-route'))
  await act(async () => release(inspection()))
  expect(element.querySelector('blockquote')).toBeNull()
  expect(element.querySelector<HTMLDetailsElement>('.conversation-mote-notice__original')?.open).toBe(false)
  expect(read).toHaveBeenCalledOnce()
})

it('a source Host never substitutes for a missing original reading route', async () => {
  await render(<ConversationMessage speaker={{ role: 'system', id: 'agentmux' }} content={moteInputNoticeWire(observation(), 'input')}
    a2aNotificationId="notice" itemRef={{ ...scope, source: { kind: 'captured', recordId: 'record' } }} />)
  await open(); expect(read).not.toHaveBeenCalled()
  expect(element.textContent).toContain('原通知的读取位置或主 Agent 未确认')
})

it('a failed refresh retains the last confirmed original and a readable retry', async () => {
  await render(captured()); await open()
  read.mockRejectedValueOnce(new Error('Original owner temporarily unreadable'))
  await click('.conversation-mote-notice__body > button')
  expect(element.querySelector('blockquote')?.textContent).toContain('阈值改为 12')
  expect(element.textContent).toContain('Original owner temporarily unreadable')
  read.mockResolvedValue(inspection()); await click('.conversation-mote-notice__body > button')
  expect(element.textContent).not.toContain('Original owner temporarily unreadable')
  expect(read).toHaveBeenCalledTimes(3)
})

it('a completed native turn stays distinct from task acceptance and preserves every exact result reference', async () => {
  const value = observation(); value.result = { kind: 'native-turn', status: 'completed', records: Array.from({ length: 70 }, (_, index) => ({
    record: { hostId: 'local', agentSessionId: 'original-member', source: { kind: 'native', providerId: 'codex', nativeSessionId: 'member-native', recordId: `reply-${index}` } }, revision: `revision-${index}` })) }
  read.mockResolvedValue(inspection(value)); await render(captured(value, 'result'))
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).toContain('成员本轮已结束')
  expect(element.querySelector('.conversation-mote-notice__event')?.textContent).not.toContain('任务完成')
  expect(read).not.toHaveBeenCalled(); await open(); await click('.conversation-mote-notice__records > summary')
  await click('[aria-label="Copy original result references"]')
  expect(copy).toHaveBeenLastCalledWith(JSON.stringify(value.result.records, null, 2), expect.any(Function))
  expect(element.textContent).toContain('本轮原记录 · 70')
})

it('hiding an opened event does not start a new original read', async () => {
  const props: ConversationMessageProps = { speaker: { role: 'system', id: 'agentmux' }, content: moteInputNoticeWire(observation(), 'input'),
    a2aNotificationId: 'original-notice', executionHostId: scope.hostId, itemRef: { ...scope, source: { kind: 'captured', recordId: 'record' } } }
  await render(<ConversationMessage {...props} active={false} />); await open(); expect(read).not.toHaveBeenCalled()
  await render(<ConversationMessage {...props} active />); expect(read).toHaveBeenCalledOnce()
})

it('the browser reading codec rejects mismatched immutable wire targets while keeping complete historical wire readable', () => {
  const wire = moteInputNoticeWire(observation(), 'input'), value = JSON.parse(wire)
  expect(parseMoteInputNotice(wire)).toMatchObject({ observationId: 'original-observation', memberAgentSessionId: 'original-member' })
  expect(parseMoteInputNotice(JSON.stringify({ ...value, memberAgentSessionId: 'other-member' }))).toBeNull()
  value.read.params.observationId = 'other-observation'; expect(parseMoteInputNotice(JSON.stringify(value))).toBeNull()
  expect(parseMoteInputNotice('not json')).toBeNull()
})

it.each(['phase', 'input', 'status', 'responseKind'] as const)('the reading codec rejects array and object %s enum values', field => {
  const value = observation()
  value.result = field === 'responseKind'
    ? { kind: 'interaction', requestId: 'request', responseKind: 'permission', delivery: 'saved', nativeAdoption: 'unknown', nativeCompleted: false }
    : { kind: 'native-turn', status: 'completed', records: [] }
  const original = JSON.parse(moteInputNoticeWire(value, 'result'))
  const valid = field === 'phase' ? 'result' : field === 'input' ? 'terminal-confirmed' : field === 'status' ? 'completed' : 'permission'
  for (const invalid of [[valid], { value: valid }]) {
    const body = structuredClone(original)
    if (field === 'status' || field === 'responseKind') body.result[field] = invalid
    else body[field] = invalid
    expect(parseMoteInputNotice(JSON.stringify(body))).toBeNull()
  }
})
