/** Observe every actual native RPC frame without changing its target, parameters or result. */
export function instrumentModelStateNativeRpc(source, tracePath) {
  if (!tracePath || source.includes('const __amxNativeRpcTraceId =')) return source
  const replace = (pattern, replacement, label) => {
    const matches = typeof pattern === 'string' ? source.split(pattern).length - 1 : [...source.matchAll(pattern)].length
    if (matches !== 1) throw new Error('The native wire trace requires one actual ' + label + ' anchor.')
    source = source.replace(pattern, replacement)
  }
  const tracing = `const __amxNativeRpcTraceId = __amxNewNativeTraceId();
  const __amxNativeRpcTrace = (phase, frame) => __amxAppendNativeTrace(${JSON.stringify(tracePath)}, JSON.stringify({
    phase, connection: __amxNativeRpcTraceId, pid: process.pid, monotonicNs: process.hrtime.bigint().toString(),
    ...(typeof frame.method === 'string' ? { method: frame.method } : {}),
    ...(frame.id === undefined ? {} : { id: frame.id }), ...(frame.error ? { error: true } : {}),
    ...(typeof frame.params?.clientInfo?.name === 'string' ? { clientName: frame.params.clientInfo.name } : {}),
    ...(typeof frame.params?.threadId === 'string' ? { threadId: frame.params.threadId } : {}),
    ...(typeof frame.params?.modelProvider === 'string' ? { modelProvider: frame.params.modelProvider } : {})
  }) + '\\n');
  const ws = new WebSocket(endpoint,`
  replace('const ws = new WebSocket(endpoint,', tracing, 'connection')
  replace('ws.send(JSON.stringify(request),', "__amxNativeRpcTrace('send', request); ws.send(JSON.stringify(request),", 'send')
  replace(/const value = JSON\.parse\(line\)(?: as Record<string, unknown>)?/gu,
    value => value + "; __amxNativeRpcTrace('receive', value)", 'receive')
  return "import { appendFileSync as __amxAppendNativeTrace } from 'node:fs';\n" +
    "import { randomUUID as __amxNewNativeTraceId } from 'node:crypto';\n" + source
}
