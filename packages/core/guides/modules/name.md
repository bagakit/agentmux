---
summary: "Early task self-naming, original naming history and persistence confirmation"
roles: "Agents naming their own task or inspecting an original name operation"
when: "Understand your task and role, refine a materially changed task, or inspect naming provenance and persistence"
---

# name

<!-- amux:content -->
The original object owner holds displayName, source and nameRevision; names never
authenticate identity, ownership or execution. Read name history for the exact Agent/Tab
before a confirmation. Keep object identity, name source, operation and revision separate.

## Name your task early

Once you understand the task and your role, give your own Session a concise name describing
the current task and phase. A clear first request is enough; otherwise clarify the task first.
Do not wait for completion, use a fixed turn count, or claim planned work is already done.
Name once after understanding the task; refine only after a substantial task change and only
when the current name needs to change. Do not rename a Tab or another Agent for this purpose.

Use the full Session ID from whoami, then agent inspect to read displayName availability,
source and nameRevision. Read agent rename --help and use agent rename --derived with that
observed revision. If availability is unavailable or the revision is unknown, do not guess
revision zero or an identity. Preserve manual names, manual clears, launch names and retained
names with unknown provenance; the original naming owner enforces their priority.
If the name is protected, naming is unavailable, or the edit fails, continue the main task.
Do not loop on renaming, send naming reminders, or make naming a prerequisite for useful work.

Use agent rename or space rename for the original object's edit. Autonomous suggestions use
the supported derived mode, preserving manual names and manual clears. name confirm asks the
original owner to confirm one original name operation on disk without replaying its edit;
it is not a human naming approval. A derived label is not human approval either.
After an unknown edit/confirmation, read the same operation and current revision before any
further change. Current names cannot certify a lost response. Naming failures retain the
original Session, Run and user working surface; do not replace an object to obtain a name.
