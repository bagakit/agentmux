import { describe, expect, it, vi } from 'vitest'
import type { ProcessRunner } from '@agentmux/core'
import { createMacDeviceConfirmation, type DeviceConfirmationIntent } from '../src/mac-device-confirmation.js'

async function failure(operation: Promise<unknown>): Promise<unknown> { return await operation.then(value => value, (error: unknown) => error) }
const intent: DeviceConfirmationIntent = { action: 'approve', hostId: 'host-original', deviceId: 'device-original',
  name: 'phone " & do shell script "rm -rf /"\n\u202e spoof\u0085\u2028\u2029', confirmationCode: '123456', expiresAt: 100_000 }
function runner(outcome = 'confirmed') {
  return vi.fn<ProcessRunner>(async (_command, args) => ({ stdout: `${args.at(-1)}:${outcome}\n`, stderr: '', exitCode: 0 }))
}

describe('Host-owned fixed Mac confirmation (controlled process, not actual dialog proof)', () => {
  it('uses an absolute OS command, immutable script and argv data; confirms only the matching native receipt', async () => {
    const run = runner(), confirm = createMacDeviceConfirmation({ run, platform: 'darwin' })
    expect(await confirm(intent)).toBe('confirmed')
    expect(run).toHaveBeenCalledOnce()
    const [command, args, options] = run.mock.calls[0]!
    expect(command).toBe('/usr/bin/osascript')
    expect(args.slice(0, 6)).toEqual(['-l', 'AppleScript', '-', 'approve', 'host-original', 'device-original'])
    expect(args[6]).toContain('\\u000a\\u202e'); expect(args[6]).toContain('\\u0085\\u2028\\u2029')
    expect(args[6]).not.toMatch(/[\u000a\u0085\u2028\u2029]/u); expect(args[7]).toBe('123456')
    expect(args[8]).toMatch(/^[a-f0-9]{32}$/u)
    expect(options!.input).toContain('buttons {"取消", actionButton} default button "取消" cancel button "取消"')
    expect(options!.input).toContain('giving up after 90')
    const approve = /else if actionName is "approve" then\n([\s\S]*?)else if actionName is "reject"/u.exec(String(options!.input))
    expect(approve?.[1]).toContain('批准后，这台设备可操作本 Mac 的 Agent：读取、发送、启动和停止。')
    expect(options!.input).not.toContain(intent.hostId)
    expect(options!.input).not.toContain('do shell script'); expect(options!.input).not.toContain('System Events')
    expect(options!.maxOutputBytes).toBe(1024); expect(options!.timeoutMs).toBe(95_000)
  })
  it('does not promote cancelled, wrong nonce, extra stdout or failed process output to confirmation', async () => {
    expect(await createMacDeviceConfirmation({ run: runner('cancelled'), platform: 'darwin' })(intent)).toBe('cancelled')
    const cases: ProcessRunner[] = [
      async () => ({ stdout: 'wrong:confirmed\n', stderr: '', exitCode: 0 }),
      async (_cmd, args) => ({ stdout: `${args.at(-1)}:confirmed\nextra`, stderr: '', exitCode: 0 }),
      async (_cmd, args) => ({ stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 1 })
    ]
    expect(cases).toHaveLength(3)
    for (const run of cases) await expect(await failure(createMacDeviceConfirmation({ run, platform: 'darwin' })(intent))).toMatchObject({ code: 'DEVICE_CONFIRMATION_UNCONFIRMED' })
  })
  it('rejects unavailable platform, invalid code and pre-abort without starting a dialog', async () => {
    const run = runner()
    await expect(await failure(createMacDeviceConfirmation({ run, platform: 'linux' })(intent))).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    const confirm = createMacDeviceConfirmation({ run, platform: 'darwin' })
    await expect(await failure(confirm({ ...intent, confirmationCode: '' }))).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    const cancel = new AbortController(); cancel.abort()
    await expect(await failure(confirm(intent, cancel.signal))).toMatchObject({ name: 'AbortError' })
    expect(run).not.toHaveBeenCalled()
  })
  it('keeps the first target busy, fences a late cancelled receipt, and permits a later explicit operation', async () => {
    let release!: () => void
    const run = runner()
    run.mockImplementationOnce(async (_cmd, args) => { await new Promise<void>(resolve => { release = resolve }); return { stdout: `${args.at(-1)}:confirmed\n`, stderr: '', exitCode: 0 } })
    const confirm = createMacDeviceConfirmation({ run, platform: 'darwin' }), cancel = new AbortController()
    const first = confirm(intent, cancel.signal)
    await expect(await failure(confirm({ action: 'invite', hostId: intent.hostId }))).toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
    expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0]![2]!.signal).toBe(cancel.signal)
    cancel.abort(); release()
    await expect(await failure(first)).toMatchObject({ code: 'DEVICE_CONFIRMATION_UNCONFIRMED' })
    expect(await confirm({ action: 'invite', hostId: intent.hostId })).toBe('confirmed')
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('does not leak process diagnostics or automatically retry an unknown native result', async () => {
    const run = vi.fn<ProcessRunner>(async () => { throw new Error('private raw diagnostic NEVER_EXPORT') })
    const operation = createMacDeviceConfirmation({ run, platform: 'darwin' })(intent)
    await expect(await failure(operation)).toMatchObject({ code: 'DEVICE_CONFIRMATION_UNCONFIRMED' })
    await expect(operation).rejects.not.toThrow('NEVER_EXPORT')
    expect(run).toHaveBeenCalledOnce()
  })
})
