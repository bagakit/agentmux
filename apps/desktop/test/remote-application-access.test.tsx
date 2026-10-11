import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ApplicationAccessConfiguration, ApplicationAccessOperation, ApplicationAccessPlan } from '@agentmux/core'
import { HostApplicationAccessPanel } from '../src/renderer/src/components/settings/HostApplicationAccessPanel'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { connectionsConfig } from '../scripts/fixtures/settings-connections/data'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), config = connectionsConfig(composerConfig), host = config.hosts.find(item => item.id === 'host-01')!
const configuration: ApplicationAccessConfiguration = { profileId: 'application-rule', revision: 'rule-revision', profile: {
  label: 'Project tooling', applicationId: 'project-tool', accountId: 'expected-account', scopes: ['project:read'],
  source: { hostId: 'local', runtimeId: 'source-runtime', osAccount: 'source-user', command: _historyFixturePath("tools/source-connector"), args: ['--site', 'work'] },
  target: { hostId: host.id, runtimeId: 'target-runtime', osAccount: 'target-user', command: _historyFixturePath("tools/target-connector"), args: [] }
} }
const observation = (source: boolean) => ({ hostId: source ? 'local' : host.id, runtimeId: source ? 'source-runtime' : 'target-runtime',
  osAccount: source ? 'source-user' : 'target-user', status: source ? 'ready' as const : 'login-required' as const,
  applicationId: 'project-tool', accountId: source ? 'expected-account' : null, scopes: source ? ['project:read'] : [], revision: 'app-revision', transferable: true })
let plan: ApplicationAccessPlan
let operations: ApplicationAccessOperation[], applied: string[], queried: string[], listed: unknown[], rejectApply: boolean
const record = (id: string, succeeded = false): ApplicationAccessOperation => ({ operationId: id, profileId: configuration.profileId, planId: plan.planId,
  configurationRevision: configuration.revision, applicationId: configuration.profile.applicationId,
  source: { hostId: 'local', runtimeId: 'source-runtime', osAccount: 'source-user' }, target: { hostId: host.id, runtimeId: 'target-runtime', osAccount: 'target-user' }, accountId: 'expected-account', scopes: ['project:read'],
  createdAt: new Date(_historyFixtureEpoch(1, 0, 0)).toISOString(), updatedAt: new Date(_historyFixtureEpoch(1, 60, 0)).toISOString(), status: succeeded ? 'succeeded' : 'unknown', stage: succeeded ? 'complete' : 'import-dispatched' })
beforeEach(() => {
  installNoteCanvasGeometry()
  plan = { planId: 'comparison-1', profileId: configuration.profileId, configurationRevision: configuration.revision, createdAt: new Date(_historyFixtureEpoch(1, 0, 0)).toISOString(),
    disposition: 'transfer', accountId: 'expected-account', scopes: ['project:read'], source: observation(true), target: observation(false) }
  operations = []; applied = []; queried = []; listed = []; rejectApply = false
  const handler = async (method: string, params: Record<string, unknown>) => {
    if (method === 'settings.applications.ls') { listed.push(params.hostId); return { configurations: [configuration], operations } }
    if (method === 'settings.applications.plan') return structuredClone(plan)
    if (method === 'settings.applications.apply') {
      applied.push(params.operationId as string)
      if (rejectApply) throw Object.assign(new Error('This comparison is stale.'), { code: 'APPLICATION_ACCESS_PLAN_CHANGED' })
      operations = [record(params.operationId as string)]
      throw Object.assign(new Error('The original response was not received.'), { code: 'CONTROL_TIMEOUT' })
    }
    if (method === 'settings.applications.operation') {
      queried.push(params.operationId as string)
      return record(params.operationId as string, queried.length > 1)
    }
    throw new Error('Unexpected application method: ' + method)
  }
  vi.spyOn(api.applications, 'call').mockImplementation(handler as typeof api.applications.call)
  useAppStore.setState({ config, sessions: [], hostChecks: {} })
})
const panel = () => <HostApplicationAccessPanel host={host} committed={host} hosts={config.hosts} active />
async function click(text: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)
  expect(button, `Reachable action ${text}`).toBeTruthy()
  await act(async () => button!.click())
}

it('application-target: the actual Host workbench reads applications for the exact selected environment', async () => {
  await dom.render(<HostSettingsPane config={config} active onSave={async () => {}} />)
  await dom.click('[aria-label="List"]')
  await dom.click(`[data-host-disclosure="${host.id}"] [data-host-panel="agents"]`)
  expect(listed, 'Application panel consumes the exact selected Host').toEqual([host.id])
  expect(dom.container.querySelector('[aria-label="Application account synchronization"]')).toBeTruthy()
  expect(dom.container.textContent).toContain('Project tooling')
})

it('application-original: lost apply response keeps the original operation and reentry discovers it without another apply', async () => {
  await dom.render(panel())
  await click('Compare access')
  await click('Synchronize selected access')
  expect(applied).toHaveLength(1)
  const original = applied[0]!
  expect(dom.container.textContent).toContain('Synchronization result not confirmed')
  await click('Check original operation')
  expect(queried, 'Original operation ID is preserved').toEqual([original])
  await dom.render(<div />)
  await dom.render(panel())
  expect(dom.container.textContent, 'Reentry consumes the durable original result').toContain('Synchronization result not confirmed')
  await click('Check original operation')
  expect(queried, 'Original operation ID is preserved').toEqual([original, original])
  expect(applied, 'Observation never replays the transfer').toEqual([original])
  expect(dom.container.textContent).toContain('Target account and scopes verified')
})

it('application-rejection: a typed pre-dispatch rejection preserves the comparison and permits a fresh one', async () => {
  rejectApply = true
  await dom.render(panel())
  await click('Compare access')
  await click('Synchronize selected access')
  expect(dom.container.textContent).toContain('This comparison is no longer current')
  expect(dom.container.textContent).not.toContain('Synchronization result not confirmed')
  expect(dom.container.textContent).toContain('expected-account')
  plan = { ...plan, planId: 'comparison-2' }
  await click('Compare access')
  const action = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Synchronize selected access')
  expect(action?.disabled, 'Known not-applied does not block the next valid comparison').toBe(false)
  expect(applied).toHaveLength(1)
})

it('application-configuration: editing exposes exact endpoint commands and independent argv without credential fields', async () => {
  await dom.render(panel())
  await click('Edit rule')
  const input = (label: string) => dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input('Source connector command').value).toBe(_historyFixturePath("tools/source-connector"))
  expect(input('Source connector arguments').value).toBe('["--site","work"]')
  expect(input('Target OS account').value).toBe('target-user')
  expect(dom.container.querySelectorAll('input[type="password"]')).toHaveLength(0)
  await click('Refresh')
  expect(input('Source connector arguments').value, 'Metadata refresh preserves the open editor').toBe('["--site","work"]')
  expect(applied).toHaveLength(0)
})

it('application-late-read: an earlier list response cannot erase a newly accepted original operation', async () => {
  await dom.render(panel())
  let finish!: (value: { configurations: ApplicationAccessConfiguration[]; operations: ApplicationAccessOperation[] }) => void
  const earlier = new Promise<{ configurations: ApplicationAccessConfiguration[]; operations: ApplicationAccessOperation[] }>(resolve => { finish = resolve })
  vi.mocked(api.applications.call).mockImplementationOnce((async () => await earlier) as typeof api.applications.call)
  await dom.render(<HostApplicationAccessPanel host={host} committed={host} hosts={config.hosts} active={false} />)
  await dom.render(panel())
  await click('Compare access')
  await click('Synchronize selected access')
  await click('Check original operation')
  const original = applied[0]!
  await act(async () => finish({ configurations: [], operations: [] }))
  expect(dom.container.textContent, 'Earlier list cannot erase the accepted original result').toContain('Synchronization result not confirmed')
  expect(dom.container.textContent).toContain('Project tooling')
  expect(queried, 'Original operation ID is preserved').toEqual([original])
})
