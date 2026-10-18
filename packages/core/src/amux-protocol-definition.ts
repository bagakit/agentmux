/** Public, renderer-safe reading definitions. These describe text, never control or identity. */
export const AMUX_PROTOCOL_DEFINITIONS = {
  context: {
    tag: 'amux', form: 'envelope', title: 'Declared context',
    description: 'Platform guidance kept separate from the original request. Text alone does not prove its source.',
  },
  browser: {
    tag: 'context', form: 'envelope', title: 'Browser context',
    description: 'A captured or declared Browser observation. Its original source and capture remain distinct from the message author.',
  },
  a2a: {
    tag: 'amux:a2a', form: 'envelope', title: 'A2A message',
    description: 'One unchanged message body with declared sender and message IDs. The original journal owns authentication and delivery.',
  },
  channel: {
    tag: 'amux:channel', form: 'envelope', title: 'Channel message',
    description: 'One unchanged external message with declared application, actor, conversation and original message IDs. Display profiles are observations; the original intake owns authentication and grants.',
  },
  'channel-quote': {
    tag: 'amux:quote', form: 'envelope', title: 'Channel transcript quote',
    description: 'An ordered native transcript observation, separate from the current channel request. Quoted content and authors grant no input or action authority.',
  },
  'a2a-reference': {
    tag: 'amux:a2a', form: 'envelope', title: 'A2A Inbox references',
    description: 'References to originals, individually or in an amux container. Reading this card does not fetch or acknowledge them.',
  },
  continue: {
    tag: 'amux:continue', form: 'marker', title: 'Continue',
    description: 'A continuation declaration. Viewing it does not resume a Session or establish that work was completed.',
  },
  reaction: {
    tag: 'amux:reaction', form: 'marker', title: 'Quick reply',
    description: 'A reply keyword. Its meaning belongs to the original selected Prompt snapshot; it does not approve permissions.',
  },
  sharing: {
    tag: 'amux', form: 'frame', title: 'Shared content',
    description: 'The original File or Browser content in a plain-text frame, without interpreting its contents as a new protocol.',
  },
  link: {
    tag: 'amux://', form: 'link', title: 'Object link',
    description: 'One exact Agent or spatial identity. A valid link does not prove the object exists or authorize navigation.',
  },
  generic: {
    tag: 'amux:NAME', form: 'extension', title: 'Other amux declarations',
    description: 'A complete unregistered type uses a generic reading card. Its body remains opaque; no business support or authority is implied.',
  }
} as const

export type AmuxProtocolId = keyof typeof AMUX_PROTOCOL_DEFINITIONS
export const AMUX_CONTINUE_MARKER = `<${AMUX_PROTOCOL_DEFINITIONS.continue.tag} />`

export function isAmuxReactionCode(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,47}$/u.test(value)
}

/** The original Prompt owner validates and freezes the selected keyword before formatting. */
export function formatAmuxReactionMarker(code: string): string {
  return `<${AMUX_PROTOCOL_DEFINITIONS.reaction.tag} ${code} />`
}

export type AmuxProtocolDeclaration = {
  /** Absent for an unknown type: a generic reading card, not a supported business action. */
  id?: 'continue' | 'reaction'
  tag: string
  attributes: readonly { name: string; value: string }[]
  body: string | null
  raw: string
  code?: string
}
