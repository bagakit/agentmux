# Demand code naming review

## Decision

The Board concept is a first-class Demand. Its implementation identifiers and
control surface must use `Demand`/`demand` consistently. Generic task concepts
outside Board, such as agent handoff work items, keep their existing names.

## Scope

- Rename the Board projection module and its local identifiers to Demand.
- Rename the Board control protocol, receipts, CLI command, and desktop store
  adapters from `task.*` to `demand.*`.
- Keep Session linkage explicit and preserve zero-session and multi-session
  behavior.

## Risks and checks

This is a deliberate protocol rename under the repository rule that obsolete
names are removed without compatibility aliases. Core and desktop tests must
prove the new operation names, and a mutation of the Demand projection or
control dispatch must make the targeted tests fail.

**Review status: approved.**
