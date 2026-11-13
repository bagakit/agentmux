#!/usr/bin/env node
import { isAbsolute } from 'node:path'
import { AgentMuxControlServer, type AgentMuxRpcMethod } from '@agentmux/core'
import { StandaloneBrowserHost } from './browser-standalone-host.js'

/** Explicit storage/engine/socket policy; importing the package never launches a browser. */
export async function serveStandaloneBrowser(input: { directory: string; executablePath: string; socketPath: string }): Promise<{ stop(): Promise<void> }> {
  if (!isAbsolute(input.socketPath)) throw new TypeError('The standalone Browser socket path must be absolute.')
  const host = new StandaloneBrowserHost(input)
  await host.ready()
  const exposedMethods = new Set<AgentMuxRpcMethod>(['browser.create','browser.close','browser.targets','browser.run','browser.history','browser.inspect','browser.stop','browser.follow','system.endpoint','system.subscription.cancel'])
  const server = new AgentMuxControlServer({ exposedMethods, socketPath: input.socketPath, coreClients: () => [], execute: request => host.execute(request),
    subscribeBrowserOperation: async (request, listener) => {
      const subscription = await host.journal.subscribe(request.operationId, request.afterSequence, listener)
      queueMicrotask(() => { for (const event of subscription.backlog) listener(event) })
      return { runOperation: subscription.operation, gap: subscription.gap, dispose: () => subscription.dispose() }
    } })
  try { await server.start() } catch (cause) { await host.stop(); throw cause }
  return { async stop() { await server.stop(); await host.stop() } }
}
