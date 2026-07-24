import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import { AGENTMUX_DAEMON_BUILD_IDENTITY, AGENTMUX_LOCAL_HOST_ID } from './daemon-protocol.js'

export type AgentMuxDaemonConnector = {
  readonly expectedHostId?: string
  readonly expectedBuildIdentity?: string
  connect(): Promise<Duplex>
}

export class LocalAgentMuxDaemonConnector implements AgentMuxDaemonConnector {
  readonly expectedHostId = AGENTMUX_LOCAL_HOST_ID
  readonly expectedBuildIdentity = AGENTMUX_DAEMON_BUILD_IDENTITY

  constructor(readonly socketPath: string) {}

  async connect(): Promise<Duplex> {
    const socket = createConnection(this.socketPath)
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          socket.off('error', onError)
          resolve()
        }
        const onError = (error: Error): void => {
          socket.off('connect', onConnect)
          reject(error)
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
      })
      return socket
    } catch (error) {
      socket.destroy()
      throw error
    }
  }
}
