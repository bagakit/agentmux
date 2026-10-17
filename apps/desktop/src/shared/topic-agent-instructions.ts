/** Short filesystem entry points; product roles remain in their original owner. */
export const TOPIC_AGENT_INSTRUCTIONS_PATH = 'AGENTS.md'
export const MOTE_MEMORY_PATH = 'MEMORY.md'

export const DEFAULT_MOTE_MEMORY = `# Memory

## Confirmed knowledge

No entries have been added to this index yet. Relevant original files may already contain useful material; an empty index is not an empty knowledge library.
`

const PUBLIC_CAPABILITIES = `## AgentMux

Read \`"$AGENTMUX_CLI" --skill\` and the relevant command help before acting. Use \`"$AGENTMUX_CLI" whoami\` to confirm your actual Session and location; discover exact targets through the public app/space/agent capabilities. Do not invent commands, target IDs or successful receipts.

Use the original Files read/create/write capabilities with the exact resource and expected revision. Read a saved change back before claiming success. If the result is unknown, inspect it before deciding whether to retry. Do not blindly resend input or overwrite a changed file.

Current user instructions, authorization and authoritative Project, Goal, Session and Run facts take precedence over historical notes. These files grant no new permissions. Keep healthy Agents and existing work available when an observation is unavailable.
`

export const DEFAULT_TOPIC_AGENT_INSTRUCTIONS = `# Topic working guide

Read \`"$AGENTMUX_CLI" topic --skill\` for the knowledge structure, maintenance duties and original-file workflow.

Read [topic.md](./topic.md) for the shared goal and confirmed context. Read relevant source material in \`refs/\` and existing results in \`outcome/\` before repeating work. Inspect \`.agents/\` for collaborators; their plaques are handoff notes, not live Runtime state.

Keep durable decisions and evidence in the original files. Preserve user edits and unrelated material. This is a shared Topic, not a persistent Mote persona.

${PUBLIC_CAPABILITIES}`

export const DEFAULT_MOTE_AGENT_INSTRUCTIONS = `# Mote working guide

Read \`"$AGENTMUX_CLI" mote --skill\` for cooperation and knowledge maintenance.

- [SOUL.md](./SOUL.md): persistent identity.
- [MEMORY.md](./MEMORY.md): short confirmed-knowledge index.
- [topic.md](./topic.md), relevant \`refs/\`, \`outcome/\` and \`.agents/\`: original context, evidence and handoffs.
- \`BEHAVIOR.md\` / \`MOTE.md\`, when present: cooperation preferences / quick-mode settings.

Read only relevant originals; use the public Files owner for exact resources, revisions and save receipts. These notes grant no permissions and are not live Runtime state.
`
