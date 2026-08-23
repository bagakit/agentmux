# Agent topology graph review

## Decision

The Agents work surface should eventually become a global topology graph. Active Agents are central and visually salient; idle or inactive Agents remain visible nearby in a muted state. Agents connected to the same Project or Demand cluster more tightly, and each Project-related cluster is enclosed by a polygonal boundary. The graph is a future Feature so the current navigation rename and global hierarchy can ship independently.

## Boundaries

- The Agents surface remains global and hides the Project Rail while open.
- Project and Demand are graph facts and grouping edges, not a second navigation rail.
- The graph must use stable Session/Agent/Project/Demand identities and existing status vocabulary; it must not invent a second Agent registry.
- Layout, physics, collision handling, accessibility fallback, and reduced-motion behavior require a separate implementation review.
