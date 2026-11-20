---
tag: topic-context
form: prompt
title: Topic and Mote context
description: Information injected when an Agent opens original Topic and Mote resources.
examples:
- label: Topic and Mote context
  template: workspace
  parameters:
    directory: TOPIC_DIRECTORY
    instructions: Read topic.md.
---

# Topic and Mote context

## workspace

~~~text
Scratch Topic context:
Your working directory is the filesystem-backed Topic at {{directory}}.
{{instructions}}
Inspect .agents/ to discover collaborators. Keep your own identity file current when your role or durable working context changes.
The identity files are shared short memory.
~~~

## topic-resource

~~~text
Read topic.md for the shared goal, put deliverables in outcome/, and put source material in refs/.
~~~

## mote-resource

~~~text
Read topic.md for the current context. Preserve existing files, references, outcomes and collaborator notes.
~~~

## behavior

~~~text
Saved behavior from {{file}} (version {{version}}):
{{behavior}}
Current user instructions and authorization take priority.
~~~

## behavior-invalid

~~~text
Saved behavior from {{file}} is unconfirmed: {{diagnostic}} Read the original file before relying on its preferences.
~~~

## behavior-missing

~~~text
Saved behavior from {{file}} is unavailable: {{diagnostic}}. Read the original SOUL and settings files before relying on missing preferences.
~~~

## knowledge

~~~text
Read "$AGENTMUX_CLI" topic --skill for this shared Topic's knowledge structure and maintenance methods.

At confirmed decisions, important corrections and reusable results, assess what the next collaborator needs. Update the relevant original knowledge and the Topic's short context and links when needed; read saved changes back before reporting them as maintained.

Preserve custom instructions, existing organization and source evidence. Current user instructions and authorization take precedence; knowledge notes are not live Project, Goal, Session or Run facts.
~~~

## mote-role

~~~text
Use amux mote --skill to establish your role from your original whoami identity and MOTE.md binding. The persistent Mote and its Main, members, work threads and arranged heartbeats each keep their own original identity.

Preserve original goals, decisions and commitments across changes and apply valid corrections in their original scope. As the confirmed Main, answer short questions directly, coordinate assigned work through the Mote guide and keep the main conversation available. Members deliver and report along their original assignments. Use amux mote playbook pmo for Project/Goal coordination and amux goal --skill for Goal work.

Update useful original knowledge on confirmed decisions and results, then read the saved changes back. Reuse relevant confirmed context and inspect original receipts when an action outcome is unknown.
~~~
