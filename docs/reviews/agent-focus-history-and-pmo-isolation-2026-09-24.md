# Agent focus history and PMO isolation review

**Status: approved**

## User problem

Switching from a Workspace Agent to Agents and back can select a different Agent, because one mutable selection is being used as both navigation context and a surface-local selection. Opening PMO Teams can then overwrite the same selection, so the execution work context is lost.

## Decision

Introduce an explicit Agent focus context abstraction with two independent lanes:

- execution lane: current execution Session plus bounded MRU history, used by Workspaces, Agents and Board;
- PMO lane: current PMO Session, used only by PMO Teams Topic/floating surface.

A Session is classified by the existing Topic binding fact, so PMO is not identified by a UI-only flag. `selectSession` records only execution Sessions in the execution lane and only PMO Sessions in the PMO lane. Main-surface changes read the execution lane. PMO receives a read-only snapshot of execution history when composing context, but never writes to that history.

## Boundaries

- Do not create a second Session, Run, Tab or Region for a focus switch.
- Do not infer a new execution Session from PMO activity.
- Persist the focus context with durable renderer facts so restart returns to the same execution Session and PMO Session independently.
- Keep the history bounded and unique; the current Session is always first.
