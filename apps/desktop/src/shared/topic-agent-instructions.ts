import { AGENTMUX_GOAL_SKILL_ENTRY } from '@agentmux/core/goal-role-guidance'
/** Short filesystem entry points; product roles remain in their original owner. */
export const TOPIC_AGENT_INSTRUCTIONS_PATH = 'AGENTS.md'
export const MOTE_MEMORY_PATH = 'MEMORY.md'

export const DEFAULT_MOTE_MEMORY = `# Memory

This is the short durable knowledge entry point for this Mote. Follow AGENTS.md when reading, correcting or maintaining it. Current instructions and original evidence take precedence over historical notes.

## Original context

- [topic.md](./topic.md): current context and confirmed work.
- \`refs/\`: original sources. \`outcome/\`: saved results.
- \`BEHAVIOR.md\`, when present: saved cooperation preferences; keep their single source there.

## Confirmed knowledge

No additional knowledge has been recorded here yet. Add only useful confirmed facts, preferences, decisions, corrections or commitments, with their source, date and scope. Link detailed original material rather than copying a conversation.

## Last maintenance

Not assessed. An Agent-reported maintenance note is historical context, not a system guarantee or a save receipt.
`

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

- [SOUL.md](./SOUL.md): identity and relationship; [topic.md](./topic.md): context and original work.
- \`BEHAVIOR.md\` / \`MOTE.md\`, when present: cooperation preferences / quick-mode settings.
- \`MEMORY.md\` and relevant linked originals: this Mote's durable knowledge, not another Mote's or unseen conversation.
- Relevant \`refs/\`, \`outcome/\`, \`.agents/\`: sources, results and collaborator handoffs.

## Goal work

For Goal work, first read \`${AGENTMUX_GOAL_SKILL_ENTRY}\`. Keep exact Goal, execution, Session/Run and source/thread identities. Report progress, blockers and evidence to the same Goal; managers verify and collect reports. Assignment, acknowledgement or exit is not completion. Execution authorization never supplies human confirmation or acceptance. Unknowns preserve original requests and healthy work, not replacements or blind retries.

## Remember usefully

Retain useful confirmed preferences, decisions, corrections and commitments with source, date and scope. Separate facts and choices from inferences and proposals. Keep a short index linking original evidence, not copied conversations. Do not store secrets or unnecessary sensitive details in auto-loaded files; use only an authorized secure-store reference.

Read back a saved change before saying it is remembered. Follow the Files workflow below. A maintenance note may record Session, source/date and changes or why none was needed; it is historical self-report, not a save receipt or proof of every-turn assessment.

Correct relevant knowledge without changing unrelated content. On withdrawal, remove recall text and optionally keep a source-only marker; do not relearn it from old chat without new explicit instruction. Existing conversations keep their earlier context and history.

Goal/Task records own progress; notes and plaques are not Runtime state. Do not start another Agent, schedule or model round just to maintain memory. Say when maintenance was not performed or a read/write is unconfirmed.

${PUBLIC_CAPABILITIES}`
