# CookOrder level-authoring MCP

This repository includes a local, stateful MCP server for graph-aware CookOrder level authoring. It reads committed graph and catalog data but writes only append-only session artifacts under `outputs/mcp-level-sessions/`.

## Run

```powershell
npm install
npm run mcp
```

Set `COOKORDER_WORKSPACE_ROOT` only when the MCP process starts outside this repository.

Example client configuration:

```json
{
  "mcpServers": {
    "cookorder-level-authoring": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "D:/path/to/ProjectCookOrder-WebGameLevelDesignTool"
    }
  }
}
```

The stdio entrypoint is intentionally thin. Repository access, sessions, validation, simulation, and checkpointing live in transport-independent services so a future HTTPS Streamable HTTP entrypoint can reuse them. GitHub Pages remains the static frontend and cannot host the stateful server process.

## Safety and authoring contract

- Start with `read_authoring_context`; `start_level_session` rejects stale context tokens.
- All mutations require `expected_revision`, autosave, and append an action-log entry.
- Normal sessions authorize no obstacles or special mechanics.
- Effects, statuses, groups, timers, and special customers are rejected until explicitly authorized by the brief or an approved requirement amendment.
- Queue contents are authored through explicit ingredient/slot actions. No `generate_level` tool is exposed.
- A queue slot may be a **bag**: `add_queue_ingredient` takes `count` (slots added) and `amount` (pieces per slot), and `set_queue_slot_amount` resizes one slot. A slot with `amount` 2+ serializes as `<id>:<amount>` and, in play, lands on one grid cell and drains a piece at a time; `amount` 1 is a plain slot.
- Validation suggestions are evidence only and are never applied automatically.
- Finalization requires valid serialization and structure, sufficient supply, solver victory, every customer served, and no customer timeouts.
- Canonical level CSVs and browser drafts are never modified.

## Session output

Each session stores `session.json`, an append-only `actions.ndjson`, and checkpoint files in `versions/`. Serializable checkpoints may include a level CSV. Full reports and draft JSON remain available even when a draft is not finalizable. `session-index.csv` is append-only.

## Verification

```powershell
npm run mcp:typecheck
npm test -- --run src/mcp
npm run build
```

The stdio contract test launches the bundled server through the official MCP client, lists its tool contract, verifies that bulk generation is absent, and calls graph discovery through the protocol.
