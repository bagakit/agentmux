/** Public, renderer-safe reading definitions. These describe text, never control or identity. */
export const AMUX_PROTOCOL_DEFINITIONS = {
  context: {
    tag: 'amux', form: 'envelope', title: 'Declared context',
    description: 'Platform guidance kept separate from the original request. Text alone does not prove its source.',
    syntax: '<amux>…</amux>'
  },
  browser: {
    tag: 'context', form: 'envelope', title: 'Browser context',
    description: 'A captured or declared Browser observation. Its original source and capture remain distinct from the message author.',
    syntax: '<amux><context kind="browser" version="1">…</context></amux>'
  },
  a2a: {
    tag: 'amux:a2a', form: 'envelope', title: 'A2A message',
    description: 'One unchanged message body with declared sender and message IDs. The original journal owns authentication and delivery.',
    syntax: '<amux:a2a from="SID" msg-id="MID">…<reminder>…</reminder></amux:a2a>'
  },
  'a2a-reference': {
    tag: 'amux:a2a', form: 'envelope', title: 'A2A Inbox references',
    description: 'References to originals, individually or in an amux container. Reading this card does not fetch or acknowledge them.',
    syntax: '<amux:a2a from="SID" msg-id="MID" read-via="message --skill" />'
  },
  continue: {
    tag: 'amux:continue', form: 'marker', title: 'Continue',
    description: 'A continuation declaration. Viewing it does not resume a Session or establish that work was completed.',
    syntax: '<amux:continue />'
  },
  reaction: {
    tag: 'amux:reaction', form: 'marker', title: 'Quick reply',
    description: 'A reply keyword. Its meaning belongs to the original selected Prompt snapshot; it does not approve permissions.',
    syntax: '<amux:reaction CODE />'
  },
  sharing: {
    tag: 'amux', form: 'frame', title: 'Shared content',
    description: 'The original File or Browser content in a plain-text frame, without interpreting its contents as a new protocol.',
    syntax: '--- amux : File/Browser ---\n…\n-----'
  },
  link: {
    tag: 'amux://', form: 'link', title: 'Object link',
    description: 'One exact Agent or spatial identity. A valid link does not prove the object exists or authorize navigation.',
    syntax: 'amux://KIND/ID'
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
