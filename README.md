# ProjectCookOrder-WebGameLevelDesignTool

## Unity Package

The `CookingGraph.Unity` package can be imported into a Unity project via git URL:

```
https://github.com/vuquangdai9x/vuquangdai9x-CookOrder-WebDesignTool.git?path=CookingGraph.Unity#master
```

Add it in Unity via Package Manager → `+` → **Add package from git URL**, or add it directly to `Packages/manifest.json`:

```json
"com.daivq.cookinggraph": "https://github.com/vuquangdai9x/vuquangdai9x-CookOrder-WebDesignTool.git?path=CookingGraph.Unity#master"
```

## Live-ops config snapshot

`liveops/` holds a queryable JSON export of the designer's GDD sheet (economy, shop, ads, hearts,
boosters, Save Me, journey rewards, home decoration, customer cast, analytics events). **Agents:
query it with `python liveops/liveops-cli.py tables|show|get|kv|find` before opening any file in
`liveops/data/`.** Re-import with `python liveops/import-sheet.py`. See [liveops/README.md](liveops/README.md).
