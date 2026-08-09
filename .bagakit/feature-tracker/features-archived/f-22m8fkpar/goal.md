# Feature Goal: Workspace File Operations and Editing

Contract: `bagakit.feature-goal.v1`
Feature: `f-22m8fkpar`
Convergence: `terminal`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive

Make AgentMux file navigation, editing, saving, conflict handling, and move operations a reliable first-class workflow. The result must preserve user drafts and authoritative disk facts under failures and races, while leaving one clear owner for each state.

## Convergence Contract

- Smallest sufficient closure: complete the reviewed tasks of this Feature so revision-aware atomic saving, external-conflict handling, cross-directory move, open-document path transactions, and real Desktop acceptance form one coherent local-workspace workflow.
- Oracle: every reviewed task is `done`; its declared gates and independent reviews pass on the exact final candidate; mounted Desktop evidence exercises the representative workflow through Renderer, preload, IPC, and Desktop Main.
- Scope expansion: route remote-workspace parity, Agent lifecycle, ctxmux evolution, A2A activity, and unrelated Explorer or Editor enhancements to their owning Feature unless current acceptance cannot be met without them.
- Completion or cycle stop: stop when Feature Tracker binds all reviewed task evidence, the final check and mounted Desktop oracle pass on the same candidate, owning documentation is current, and no blocking independent-review finding remains.

## Protected Invariants

- Desktop Main is the only owner of Workspace Root confinement, disk revision, file mutation, and observation facts. Renderer owns buffers, edit/save/observation generations, view state, and explicit conflict choices. `packages/core` does not become a Workspace File Service.
- Use the simplest complete owner-level design. Do not add compatibility layers, migration paths, legacy aliases, revisionless fallbacks, duplicated truth, or speculative configuration and abstraction.
- Preserve a working vertical while adding required capability. Each lasting component has one concern and one authoritative state owner.
- Formal documentation states only current AgentMux behavior and durable boundaries; it contains no dates, implementation-source narrative, or completed-task chronology.
- Non-goal: this Feature does not establish SSH or remote-file parity, change Agent or Run lifecycle ownership, or implement unrelated Browser, Activity, terminal, or A2A features.

## Acceptance And Stop Rules

- Acceptance: the current reviewed Task acceptance, task gates, real mounted Desktop workflow, final repository checks, independent owner-level review, and current SSOT all join on one immutable candidate.
- Insufficient: a commit alone, focused unit tests alone, mock-only UI evidence, a narrowed test-discovery command, a stale predecessor review, or a green result produced while another process mutates the same generated artifacts.
- Stop and ask before: changing the Feature outcome or authority boundary, adding remote parity, weakening an acceptance oracle, publishing externally, or taking a destructive or irreversible action outside the reviewed Tasks.

## Authority And Orchestration

- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Before substantial work and after every review, re-read this Goal and the current acceptance evidence.
- Take the smallest action that directly advances that evidence or removes a real blocker. Defer anything not required for the current closure; stop when acceptance and applicable mandatory gates are satisfied.
- Do not implement a chat-only requirement. First record each accepted new requirement in the appropriate reviewed Feature Task through Feature Tracker.
- Prove the cheapest representative user-visible vertical before broad horizontal infrastructure.
- For engineering work, satisfy acceptance first; among valid solutions minimize enduring states, owners, APIs, abstractions, duplicated truth, and temporary scaffolding.
- Keep one Writer for each mutation surface. Reviewers are read-only and bind verdicts to exact commits. Generated build artifacts also have one active Writer during mounted verification.
- Keep implementation commits small enough to audit and separate owner changes, review corrections, mounted probes, and documentation when their intent differs. Run an independent diff and message review for each stable commit.
- Supervise by material event. Do not interrupt aligned work; when no material event occurs, refresh progress and blockers about every ten minutes.
- Report a verified result, a direction-changing mismatch, a real blocker, a Writer conflict, or a decision needed before irreversible work; do not emit timer-driven implementation chatter.

## Context References

- `AGENTS.md`: project ownership, architecture, and no-compatibility constraints; read before implementation or review.
- `docs/design/interaction-review.md`: Workspace file behavior and owner boundary; read when changing product semantics or interaction acceptance.
- `docs/testing/strategy.md`: authoritative verification layers and mounted Desktop oracle; read before claiming readiness.
