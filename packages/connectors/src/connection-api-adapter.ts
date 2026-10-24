import type { ConnectionApiDescription, ConnectionApiRequest, ConnectionApiResponseBody, ConnectionConfig } from '@agentmux/core/connections'

/** Private original Host boundary. Authentication material never becomes a public DTO. */
export interface ConnectionApiAdapter {
  readonly description: ConnectionApiDescription
  /** Pure native path/format eligibility check before resolving credentials. */
  validate(request: ConnectionApiRequest): void
  request(config: ConnectionConfig, credential: string, request: ConnectionApiRequest, context: {
    /** Register actual SDK authentication values for the one central Host outcome redactor. */
    protect(value: string): void
  }): Promise<{ status: number; body: ConnectionApiResponseBody }>
}
