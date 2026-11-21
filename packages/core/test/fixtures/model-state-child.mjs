import { fork } from 'node:child_process'
import { resolve } from 'node:path'

/** Real Node Main/Core owner; the parent receives its actual public results and RuntimeEvents. */
export async function openModelStateMainChild(directory, { native = false, restore = false, processId, initialObservation, onRuntimeEvent = () => {} } = {}) {
  if (!process.env.AMX_INFORMATION_CANDIDATE) throw new Error('The exact compiled model-state candidate is required.')
  const child = fork(resolve(import.meta.dirname, 'model-state-main-owner.mjs'), [directory, native ? 'native' : restore ? 'restore' : 'create', processId ? String(processId) : '', initialObservation ? JSON.stringify(initialObservation) : ''], {
    execArgv: ['--experimental-transform-types'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const pending = new Map(), events = []
  let sequence = 0, diagnostics = '', resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const openingTimer = setTimeout(() => rejectReady(new Error('The private Main owner did not become ready: ' + diagnostics)), native ? 60000 : 15000)
  child.stderr.on('data', bytes => { diagnostics += bytes })
  child.on('message', message => {
    if (message.type === 'ready') { clearTimeout(openingTimer); resolveReady(message); return }
    if (message.type === 'runtime-event') { events.push(message.event); onRuntimeEvent(message.event); return }
    if (message.type !== 'reply') return
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id); clearTimeout(call.timer)
    if (message.error) call.reject(Object.assign(new Error(message.error.message), message.error))
    else call.resolve(message.result)
  })
  const exited = new Promise(resolve => child.once('exit', code => {
    clearTimeout(openingTimer)
    const failure = new Error('The private Main owner exited ' + code + ': ' + diagnostics)
    rejectReady(failure)
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(failure) }
    pending.clear(); resolve(code)
  }))
  child.once('error', rejectReady)
  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The original private Main request did not settle: ' + method + ': ' + diagnostics)) }, 60000)
      pending.set(id, { resolve, reject, timer })
      child.send({ type: 'call', id, method, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error) } })
    })
  }
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    try { await call('close'); if (await exited !== 0) throw new Error(diagnostics) }
    finally { clearTimeout(timer) }
  }
  try { return { child, ready: await ready, events, call, close, diagnostics: () => diagnostics } }
  catch (error) { child.kill('SIGTERM'); await exited; throw error }
}
