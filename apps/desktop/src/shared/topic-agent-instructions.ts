/** Short filesystem entry points; product roles remain in their original owner. */
export const TOPIC_AGENT_INSTRUCTIONS_PATH = 'AGENTS.md'

const PUBLIC_CAPABILITIES = `## AgentMux

Read \`"$AGENTMUX_CLI" --skill\` and the relevant command help before acting. Use \`"$AGENTMUX_CLI" whoami\` to confirm your actual Session and location; discover exact targets through the public app/space/agent capabilities. Do not invent commands, target IDs or successful receipts.

Use the original Files read/create/write capabilities with the exact resource and expected revision. Read a saved change back before claiming success. If the result is unknown, inspect it before deciding whether to retry. Do not blindly resend input or overwrite a changed file.

Current user instructions, authorization and authoritative Project, Goal, Session and Run facts take precedence over historical notes. These files grant no new permissions. Keep healthy Agents and existing work available when an observation is unavailable.
`

export const DEFAULT_TOPIC_AGENT_INSTRUCTIONS = `# Topic working guide

Read [topic.md](./topic.md) for the shared goal and confirmed context. Read relevant source material in \`refs/\` and existing results in \`outcome/\` before repeating work. Inspect \`.agents/\` for collaborators; their plaques are handoff notes, not live Runtime state.

Keep durable decisions and evidence in the original files. Preserve user edits and unrelated material. This is a shared Topic, not a persistent Mote persona.

${PUBLIC_CAPABILITIES}`

export const DEFAULT_MOTE_AGENT_INSTRUCTIONS = `# Mote working guide

## Read first

- [SOUL.md](./SOUL.md): persistent identity and relationship.
- [topic.md](./topic.md): current context and links to original work.
- \`BEHAVIOR.md\` and \`MOTE.md\`, when present: saved cooperation preferences and quick-mode settings.
- \`MEMORY.md\`, when present, and the relevant original notes it links: durable knowledge for this Mote. Do not infer another Mote's knowledge or an unseen conversation.
- Relevant \`refs/\`, \`outcome/\` and \`.agents/\`: evidence, deliverables and collaborator handoffs.

## Remember usefully

During normal collaboration, assess confirmed preferences, decisions, corrections and open commitments worth keeping. Record source, date and scope; distinguish facts and confirmed choices from inferences and proposals. Use the existing organization and keep the memory entry point short. Link detailed evidence rather than copying whole conversations. Do not store secrets or unnecessary sensitive details.

Read the latest original file before editing; use its revision, preserve unrelated content, and read the save back. Only then say it is remembered. A note saying "read back" is not a Files receipt. If useful, replace the brief last-maintenance note with your Session, source and date plus what changed or why no change was needed. That is an Agent-reported historical note, not proof that every turn was assessed.

When corrected, update the relevant knowledge. When asked to forget, remove its recall text and optionally keep a minimal source-only withdrawal marker so old material is not learned again. Do not restore withdrawn knowledge from old chat without a new explicit instruction. Existing live conversations retain their earlier context; do not claim their history was erased.

Keep knowledge separate from current Goal/Task progress and Runtime state. Do not start another Agent, background schedule or extra model round merely to maintain memory. If no maintenance was performed or a read/write is unconfirmed, say so rather than claiming success.

${PUBLIC_CAPABILITIES}`
