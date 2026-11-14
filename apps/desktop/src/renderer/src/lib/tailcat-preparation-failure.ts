const explanations = {
  RPC_METHOD_NOT_FOUND: {
    title: 'This AgentMux service cannot prepare keys yet',
    next: 'Update the AgentMux service serving this Mac, reconnect to it, then prepare again.'
  },
  CONTROL_UNAVAILABLE: {
    title: 'Key preparation is unavailable on this service',
    next: 'Check the AgentMux service serving this Mac. Ask Mote to help identify the missing setup capability.'
  },
  TAILCAT_CLI_MISSING: {
    title: 'The service cannot find Tailcat',
    next: 'Install the official Tailcat CLI on this Mac and make it available in the serving AgentMux service’s PATH.'
  },
  TAILCAT_KEY_CONFLICT: {
    title: 'This saved key cannot be used here',
    next: 'Keep the existing key. Choose another key name for this connection and prepare again.'
  },
  CONTROL_PERMISSION_DENIED: {
    title: 'Prepare this key yourself',
    next: 'Key preparation requires your local device confirmation. Mote can help with installation and ordinary fields.'
  },
  TAILCAT_UNAVAILABLE: {
    title: 'Tailcat preparation did not complete',
    next: 'Ask Mote to check this preparation step and the original service environment.'
  }
} as const

export type TailcatPreparationCode = keyof typeof explanations

/** Only original machine codes classify a failure. Display text and version labels grant no diagnosis. */
export function tailcatPreparationFailure(error: unknown) {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const code = typeof value === 'string' && Object.hasOwn(explanations, value) ? value as TailcatPreparationCode : null
  return { code, ...(code ? explanations[code] : {
    title: 'Key preparation could not be confirmed',
    next: 'The cause is still unknown. Ask Mote to check the original service before trying again.'
  }) }
}
