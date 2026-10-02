import { describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ToolkitActionInput, type ToolkitScriptSnapshot, type ToolkitToolFields } from '@agentmux/core/control'
import { nativeMain, oneCli, record, until } from './toolkit-main.fixture.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'

const countScript = `import {readFile,writeFile} from 'node:fs/promises';
const file=process.argv[1];
const before=await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '0';throw error});
const value=Number(before)+1;await writeFile(file,String(value));process.stdout.write('action_ACK:'+value);`
const action = (id = 'refresh') => ({ id, label: 'Refresh', script: countScript, args: ['action-count.txt'] })
async function count(directory: string) {
  try { return Number(await readFile(join(directory, 'action-count.txt'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}
async function get(): Promise<ToolkitScriptSnapshot> { return (await oneCli('toolkit', 'inspect', 'quota')).result.snapshot }
async function settled(): Promise<ToolkitScriptSnapshot> {
  let value!: ToolkitScriptSnapshot
  await until(async () => { value = await get(); expect(value.admission).toBeNull(); expect(value.latestConfirmed).not.toBeNull() })
  return value
}
const capture = (value: ToolkitScriptSnapshot): ToolkitActionInput => ({ invocationId: crypto.randomUUID(),
  expectedRevision: value.latestConfirmed!.definition.revision, sourceExecutionId: value.latestConfirmed!.executionId,
  expectedAdmissionExecutionId: value.admission?.executionId ?? null })
async function setup(m: Awaited<ReturnType<typeof nativeMain>>, options: Pick<ToolkitToolFields, 'actions'> & { script?: string } = { actions: [action()] }) {
  const fields: ToolkitToolFields = { name: 'Quota', icon: 'terminal', enabled: true, statusBar: 'icon',
    workspacePath: join(m.directory, 'work'), script: "process.stdout.write('source_ACK')", args: [], ...options }
  const path = join(m.directory, 'fields.json'); await writeFile(path, JSON.stringify(fields))
  await oneCli('toolkit', 'create', 'quota', '--input', path)
  await oneCli('toolkit', 'run', 'quota')
  const source = await settled()
  return { fields, source }
}
async function invoke(m: Awaited<ReturnType<typeof nativeMain>>, actionId: string, input: ToolkitActionInput) {
  const path = join(m.directory, 'action-input.json'); await writeFile(path, JSON.stringify(input))
  return await oneCli('toolkit', 'action', 'quota', actionId, '--input', path)
}
async function rejected(m: Awaited<ReturnType<typeof nativeMain>>, actionId: string, input: ToolkitActionInput) {
  try {
    await m.rpc.call('toolkit.action', { toolId: 'quota', actionId, input })
    return null
  } catch (error) { return error }
}

describe('registered Main saved Toolkit action actual CLI', () => {
  it('concurrent public operation ID uses the original captured invocation and executes its saved script once', async () => {
    const m=await nativeMain(),operationId=crypto.randomUUID()
    const fields:ToolkitToolFields={name:'Quota',icon:'terminal',enabled:true,statusBar:'icon',
      workspacePath:join(m.directory,'work'),script:countScript,args:['action-count.txt'],actions:[]}
    await m.rpc.call('toolkit.create',{toolId:'quota',value:fields})
    const replies=await Promise.allSettled([m.rpc.call('toolkit.run',{toolId:'quota',operationId}),
      m.rpc.call('toolkit.run',{toolId:'quota',operationId})])
    expect(replies.filter(reply=>reply.status==='fulfilled').length).toBeGreaterThanOrEqual(1)
    for(const reply of replies)if(reply.status==='rejected')expect(reply.reason).toMatchObject({code:'CONFIG_CONFLICT'})
    const finished=await settled(),fact=finished.latestConfirmed!
    expect(fact.invocationId).toBe(operationId);expect(fact.text).toBe('action_ACK:1')
    expect(await count(join(m.directory,'work'))).toBe(1)
    const input={invocationId:fact.invocationId,expectedRevision:fact.definition.revision,
      expectedLatestExecutionId:fact.expectedLatestExecutionId}
    const replay=await m.rpc.call('toolkit.run',{toolId:'quota',operationId,input})
    expect(replay.snapshot.kind).toBe('script')
    if(replay.snapshot.kind!=='script')throw new Error('Custom tool must return its own script snapshot')
    expect(replay.snapshot.latestConfirmed).toEqual(fact)
    await expect(m.rpc.call('toolkit.run',{toolId:'quota',operationId})).rejects.toMatchObject({code:'CONFIG_CONFLICT'})
    expect(await count(join(m.directory,'work'))).toBe(1);expect(await m.core.listRuns()).toEqual([])
    await record('action-operation-id-once',{operationId,replies:replies.map(reply=>reply.status),fact,input,
      count:await count(join(m.directory,'work'))})
  })
  it('actual literal action ID --help executes once and ordinary Main restart never replays its captured side effect', async () => {
    const m = await nativeMain()
    const fields: ToolkitToolFields = { name: 'Quota', icon: 'terminal', enabled: true, statusBar: 'icon',
      workspacePath: join(m.directory, 'work'), script: "process.stdout.write('source_ACK')", args: [] }
    await m.rpc.call('toolkit.create', { toolId: 'quota', value: fields })
    await oneCli('toolkit', 'run', 'quota')
    const original = await settled()
    expect(original.definition.actions).toBeUndefined()
    const update = join(m.directory, 'first-action.json')
    await writeFile(update, JSON.stringify({ changes: { actions: [] }, expected: { actions: [] } }))
    const unchanged = (await oneCli('toolkit', 'update', 'quota', '--input', update)).result
    expect(unchanged.changed).toBe(false)
    expect(unchanged.definition).toEqual(original.definition)
    await writeFile(update, JSON.stringify({ changes: { actions: [action('--help')] }, expected: { actions: [] } }))
    const configured = (await oneCli('toolkit', 'update', 'quota', '--input', update)).result.definition
    expect(configured.revision).not.toBe(original.definition.revision)
    expect((await get()).latestConfirmed!.definition).toEqual(original.definition)
    let conflict: unknown
    try { await m.rpc.call('toolkit.update', { toolId: 'quota', input: { changes: { actions: [action('another')] }, expected: { actions: [] } } }) }
    catch (error) { conflict = error }
    expect(conflict).toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect((await get()).definition).toEqual(configured)
    await oneCli('toolkit', 'run', 'quota')
    const source = await settled()
    const input = capture(source), before = await count(join(m.directory, 'work'))
    expect(before).toBe(0)
    await invoke(m, '--help', input)
    const finished = await settled()
    expect(finished.latestConfirmed!.executionId).not.toBe(source.latestConfirmed!.executionId)
    expect(finished.latestConfirmed).toMatchObject({ text: 'action_ACK:1', action: { id: '--help',
      sourceExecutionId: source.latestConfirmed!.executionId, expectedAdmissionExecutionId: null }, definition: source.definition })
    expect(await count(join(m.directory, 'work'))).toBe(before + 1)
    const repeated = (await invoke(m, '--help', input)).result.snapshot
    expect(repeated.latestConfirmed).toEqual(finished.latestConfirmed)
    expect(await count(join(m.directory, 'work'))).toBe(1)
    const instance = await m.sdk.daemonInstance()
    await m.restart()
    expect(await m.sdk.daemonInstance()).toBe(instance)
    const restored = await get()
    expect(restored.latestConfirmed).toEqual(finished.latestConfirmed)
    await invoke(m, '--help', input)
    expect(await count(join(m.directory, 'work'))).toBe(1)
    expect(await m.core.listRuns()).toEqual([])
    await record('action-literal-repeat-restart', { original, unchanged, configured, conflict: String(conflict), source, input,
      finished, restored, instance, count: await count(join(m.directory, 'work')) })
  })
  it('actual action source and captured configuration target conflicts leave both owned counters unchanged', async () => {
    const m = await nativeMain(), { fields, source } = await setup(m)
    const target = join(m.directory, 'second-work'); await mkdir(target)
    await oneCli('toolkit', 'run', 'quota')
    const replacement = await settled()
    expect(replacement.latestConfirmed!.executionId).not.toBe(source.latestConfirmed!.executionId)
    const sourceConflict = await rejected(m, 'refresh', capture(source))
    expect(sourceConflict).toMatchObject({ code: 'CONFIG_CONFLICT' })
    const input = capture(replacement), update = join(m.directory, 'target-update.json')
    await writeFile(update, JSON.stringify({ changes: { workspacePath: target }, expected: { workspacePath: fields.workspacePath } }))
    const changed = (await oneCli('toolkit', 'update', 'quota', '--input', update)).result.definition
    expect(changed.revision).not.toBe(input.expectedRevision)
    const targetConflict = await rejected(m, 'refresh', input)
    await until(async () => expect(await m.core.listRuns()).toEqual([]))
    const counts = { original: await count(fields.workspacePath), changed: await count(target) }
    await record('action-target-conflict', { source, replacement, input, changed, sourceConflict: String(sourceConflict), targetConflict: String(targetConflict), counts })
    expect(counts).toEqual({ original: 0, changed: 0 })
    expect(targetConflict).toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect((await get()).admission).toBeNull()
  })
  it('actual result text cannot create an action program or a new permission', async () => {
    const m = await nativeMain(), injected = action('output-action')
    const { source, fields } = await setup(m, { actions: [], script: 'process.stdout.write(' + JSON.stringify(JSON.stringify({ actions: [injected] })) + ')' })
    expect(source.definition.actions).toEqual([])
    const error = await rejected(m, 'output-action', capture(source))
    await until(async () => expect(await m.core.listRuns()).toEqual([]))
    const after = await count(fields.workspacePath)
    await record('action-output-not-authority', { source, injected, error: String(error), after })
    expect(after).toBe(0)
    expect(error).toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
    expect((await get()).latestConfirmed).toEqual(source.latestConfirmed)
  })
  it('actual repeated unknown action preserves its exact admission and never writes a second counter increment', async () => {
    const m = await nativeMain(), { source, fields } = await setup(m)
    const input = capture(source), save = ToolkitReceiptStore.prototype.save
    let failed = false
    vi.spyOn(ToolkitReceiptStore.prototype, 'save').mockImplementation(function(this:ToolkitReceiptStore,id, value: any) {
      if (!failed && value.latestConfirmed?.action?.id === 'refresh') {
        failed = true
        return Promise.reject(new Error('owned-action-confirmation-unconfirmed'))
      }
      return save.call(this, id, value)
    })
    await invoke(m, 'refresh', input)
    let unknown!: ToolkitScriptSnapshot
    await until(async () => { unknown = await get(); expect(unknown.state).toBe('unknown'); expect(failed).toBe(true) })
    expect(unknown.latestConfirmed).toEqual(source.latestConfirmed)
    expect(unknown.admission).toMatchObject({ invocationId: input.invocationId, action: { id: 'refresh', sourceExecutionId: input.sourceExecutionId } })
    expect(await count(fields.workspacePath)).toBe(1)
    const repeated = (await invoke(m, 'refresh', input)).result.snapshot as ToolkitScriptSnapshot
    const repeatedId = (repeated.admission ?? repeated.latestConfirmed)!.executionId
    let observed = repeated
    if (repeatedId !== unknown.admission!.executionId) await until(async () => {
      observed = await get()
      expect(observed.admission).toBeNull()
      expect(observed.latestConfirmed?.executionId).toBe(repeatedId)
    })
    const current = (await m.core.listRuns()).filter(run => run.runId === unknown.admission!.run!.runId)
    const repeatedCount = await count(fields.workspacePath)
    await record('action-unknown-repeat-observed', { source, input, unknown, repeated, observed, current, repeatedCount })
    expect(repeatedCount).toBe(1)
    expect(current).toHaveLength(1)
    expect(repeated.admission?.executionId).toBe(unknown.admission!.executionId)
    expect(await count(fields.workspacePath)).toBe(1)
    const mismatched = await rejected(m, 'refresh', { ...input, expectedAdmissionExecutionId: 'another-captured-baseline' })
    expect(mismatched).toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(await count(fields.workspacePath)).toBe(1)
    await record('action-unknown-repeat', { source, input, unknown, repeated, current, count: await count(fields.workspacePath), mismatched: String(mismatched) })
  })
})
