# Changelog

## 0.1.1

- Preservation slots are now a first-class part of the package: the `preservation` edge kind, the
  tool's `preservationSlots` field, `CookingGraphAsset.preservationEdges`, and
  `CookingGraphPreservation` for resolving a wired ingredient or group into the concrete set a
  tool's buffer accepts.
- Graph validation checks that a tool's buffer size and its preservation wiring agree, and that a
  tool takes at most one preservation edge.
- Added the schema fields the web editor already writes: `imageURL` on ingredient/tool/dirty nodes
  and `emoji` on composites. As before, artwork fields stay in the JSON and out of runtime assets
  and sync fingerprints.
- Deleting a node now also removes preservation edges that referenced it.
- Fixed the Editor test assembly failing to compile (`JToken` has no `Add`).
- Added GAMEPLAY_RULES.md — the full cooking-graph and play-mode simulation specification.

## 0.1.0

- Initial graph editor, translators, runtime assets, and synchronization workflow.
