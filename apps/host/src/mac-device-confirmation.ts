import { randomBytes } from 'node:crypto'
import { AgentMuxError, runProcess, type ProcessRunner } from '@agentmux/core'

export type DeviceConfirmationIntent = {
  action: 'invite'; hostId: string
} | {
  action: 'approve' | 'reject'; hostId: string; deviceId: string; name: string;
  confirmationCode: string; expiresAt: number
} | {
  action: 'revoke'; hostId: string; deviceId: string; name: string; createdAt: number
}
export type MacDeviceConfirmation = (intent: DeviceConfirmationIntent, signal?: AbortSignal) => Promise<'confirmed' | 'cancelled'>

// Fixed StandardAdditions program. Every varying value is argv data, never AppleScript source.
const SCRIPT = `on run argv
  set actionName to item 1 of argv
  set hostIdentity to item 2 of argv
  set deviceIdentity to item 3 of argv
  set deviceName to item 4 of argv
  set confirmationCode to item 5 of argv
  set receiptNonce to item 6 of argv
  if actionName is "invite" then
    set actionButton to "生成邀请"
    set detailText to "为这台 Mac 生成短时一次设备邀请。邀请不等于设备授权。"
  else if actionName is "approve" then
    set actionButton to "批准此设备"
    set detailText to "批准后，这台设备可操作本 Mac 的 Agent：读取、发送、启动和停止。" & return & "请核对手机显示的六位确认码与下面相同，才批准此设备。" & return & "确认码：" & confirmationCode
  else if actionName is "reject" then
    set actionButton to "拒绝此请求"
    set detailText to "拒绝此设备的待配对请求。已有授权和 Agent 会话保留。"
  else if actionName is "revoke" then
    set actionButton to "撤销此设备"
    set detailText to "撤销此设备的授权并断开它的连接。其他设备和原 Agent 会话继续运行。"
  else
    error "Unsupported device action"
  end if
  set detailText to detailText & return & return & "Mac 身份：" & hostIdentity
  if deviceIdentity is not "" then
    set detailText to detailText & return & "设备：" & deviceName & return & "设备身份：" & deviceIdentity
  end if
  try
    set answer to display dialog detailText with title "AgentMux 设备授权" buttons {"取消", actionButton} default button "取消" cancel button "取消" giving up after 90
    if gave up of answer then return receiptNonce & ":cancelled"
    if button returned of answer is actionButton then return receiptNonce & ":confirmed"
    return receiptNonce & ":cancelled"
  on error number -128
    return receiptNonce & ":cancelled"
  end try
end run
`

function label(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 160) throw new AgentMuxError('Device confirmation target is invalid. Original authorization is retained.', 'INVALID_CONTROL_REQUEST')
  // Public names cannot inject a second instruction or disguise the immutable identities.
  return value.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Host-owned OS child only. No serialized caller assertion can become a confirmation result. */
export function createMacDeviceConfirmation(options: { run?: ProcessRunner; platform?: NodeJS.Platform } = {}): MacDeviceConfirmation {
  const run = options.run ?? runProcess, platform = options.platform ?? process.platform
  let busy = false
  return async (intent, signal) => {
    if (platform !== 'darwin') throw new AgentMuxError('Mac native device confirmation is unavailable. Original Host and Runs remain available.', 'CONTROL_UNAVAILABLE')
    signal?.throwIfAborted()
    if (busy) throw new AgentMuxError('A Mac device confirmation is already open. This operation has not been submitted.', 'CONTROL_OWNER_BUSY')
    const hostId = label(intent.hostId), deviceId = intent.action === 'invite' ? '' : label(intent.deviceId)
    const name = intent.action === 'invite' ? '' : label(intent.name)
    const code = intent.action === 'approve' || intent.action === 'reject' ? intent.confirmationCode : ''
    if ((intent.action === 'approve' || intent.action === 'reject') && !/^[0-9]{6}$/u.test(code)) throw new AgentMuxError('Device confirmation code is invalid.', 'INVALID_CONTROL_REQUEST')
    const nonce = randomBytes(16).toString('hex')
    busy = true
    try {
      const result = await run('/usr/bin/osascript', ['-l', 'AppleScript', '-', intent.action, hostId, deviceId, name, code, nonce],
        { input: SCRIPT, timeoutMs: 95_000, maxOutputBytes: 1024, ...(signal ? { signal } : {}) })
      signal?.throwIfAborted()
      if (result.exitCode !== 0) throw new Error('Native confirmation has no successful receipt.')
      if (result.stdout === `${nonce}:confirmed\n`) return 'confirmed'
      if (result.stdout === `${nonce}:cancelled\n`) return 'cancelled'
      throw new Error('Native confirmation has no matching receipt.')
    } catch {
      throw new AgentMuxError('Mac device confirmation is unconfirmed. Check the local dialog and read the original device state before another explicit action; existing authorizations and Runs are retained.', 'DEVICE_CONFIRMATION_UNCONFIRMED')
    } finally { busy = false }
  }
}
