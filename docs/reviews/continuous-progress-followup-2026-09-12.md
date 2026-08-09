# Continuous progress follow-up review (2026-09-12)

This successor feature carries forward the two newly observed release blockers from f-2528fmqbw: Explorer projection evidence must survive Workspace remounts with monotonic receipts, and stop cleanup must converge without leaving native sessions live. Both require runtime behavior tests plus mutation and production-caller checks before packaging.

## Revised decision

The mounted verification protocol uses operation-scoped receipts (`workspaceId`, mount epoch, operation id) rather than aggregate DOM counters. Move commit publishes one authoritative receipt; stale refreshes are rejected by epoch. Stop treats an already vanished Run as an idempotent terminal outcome.
