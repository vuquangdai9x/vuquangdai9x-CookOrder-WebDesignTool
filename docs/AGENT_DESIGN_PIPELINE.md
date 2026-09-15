# Agent Design publishing pipeline

The **Agent Design** web tab reads committed static data from `public/agent-levels/`. It does not need a server or browser storage, so the same generated levels are available on phones and other devices after GitHub Pages deploys the Vite build.

## One local agent-design session

Give the local agent a stable, human-readable profile name in the prompt. For example:

```text
Use the design-level workflow to build and publish two Coffee levels for the
Agent Design profile "Mina — Coffee Amount Study". Use amount mechanics, keep
the first level relaxed and make the second one tense but fair. After I confirm
the refined requirements, finalize every level, append them to that profile,
commit, push, wait for GitHub Pages, and report the playtest URL.
```

The profile name identifies the agent session in the web UI. Every finalized MCP level is an entry in that profile's own file:

```text
public/agent-levels/index.json
public/agent-levels/profiles/mina-coffee-amount-study.json
```

The level entry includes its map, name, weather, tag, full runnable `LevelData`, source MCP session/revision, and the refined instruction needed to reprompt another agent.

MCP working data under `outputs/mcp-level-sessions/` is local-only and ignored by Git. A published level needs only these generated runtime assets:

```text
public/agent-levels/index.json
public/agent-levels/profiles/<profile-slug>.json
```

Do not add session JSON, action logs, evaluations, deadlock reports, checkpoint drafts, checkpoint CSVs, or build output to an Agent Design publish commit.

## Commands

Append a finalized level without touching Git:

```sh
npm run agent-level:append -- --session <mcp-session-id> --profile "<profile name>"
```

Use a fixed profile slug when the display name may change:

```sh
npm run agent-level:append -- --session <mcp-session-id> --profile "<profile name>" --profile-id <profile-slug>
```

Override the automatically reconstructed refined instruction when needed:

```sh
npm run agent-level:append -- --session <mcp-session-id> --profile "<profile name>" --instruction-file <prompt.txt>
```

Append, commit only the profile plus index, and push `master` to the repository's `github.com` remote:

```sh
npm run agent-level:publish -- --session <mcp-session-id> --profile "<profile name>"
```

`agent-level:publish` will not include unrelated working-tree or staged files in its commit. It refuses to push from a local branch other than `master`, targets `github.com/master` explicitly, and runs finalization itself only when the current MCP revision has not already been finalized. Republishing the same session revision replaces that entry; a new revision appends a new entry. Advanced callers can override `--remote` and `--branch` when the deployment configuration changes.

For a multi-level profile, use `agent-level:append` for every level except the last, then use `agent-level:publish` for the last one. The single generated commit then contains the complete profile update.

## Deployment and playtest

The existing GitHub Pages workflow deploys pushes to `master`. Publishing from another branch stores the level but does not trigger the production Pages deployment until that branch is merged or pushed to the configured deploy branch.

After pushing, monitor `.github/workflows/deploy.yml` to completion. Open the repository's Pages URL, select **Agent Design**, expand the named profile, and press **Play**. Agent playtests use the same `NodePlayView` and simulation as normal Play mode, but lock to the real-game behavior defaults and hide map/level/behavior configuration. The playtest layout fills narrow mobile screens and retains only gameplay controls.

## Data ownership

- Do not hand-edit queue, grid, or customer strings for Agent Design publishing; publish a finalized MCP session.
- One agent-design profile owns one JSON file. Different profiles can be generated independently with minimal merge overlap.
- `index.json` is only discovery metadata. The profile file is the source of its level list.
- `outputs/mcp-level-sessions/` remains local and ignored. The publisher stages only the final profile JSON and `index.json`.
- Published data is immutable from the browser. Browser playtests never overwrite editor drafts or committed level CSVs.
