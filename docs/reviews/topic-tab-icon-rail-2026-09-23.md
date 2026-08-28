# Topic Tab icon rail review

Status: approved by the user's three explicit constraints on 2026-09-23.

Observed screenshot: each Tab consumes a large empty double-bordered tile; the Agent roster repeats Agents already represented by Tabs; the inspector names Agents without showing their visual identity. The result wastes Topic title width and makes the identity relationship hard to scan.

Decision: one compact icon slot per Tab. A one-Region Tab shows that Region's Agent avatar or surface icon. A split Tab shows a square miniature of actual Region bounds. Agents mounted in any Tab are represented there and are excluded from the separate roster; only live background Agents without a Tab retain a separate entry. The inspector uses the same configured avatar beside Agent identity and recent activity. Existing Tab order, active state, Topic opening, portal placement, and Session ownership stay sourced from current projections.

Acceptance proof: component rendering for one Agent, one non-Agent, and split Tabs; mounted Agent roster de-duplication across inactive Tabs; focused tests and a block-level mutation; typecheck and caller check; installed screenshot when packaging is requested.
