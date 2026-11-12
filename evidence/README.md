# Evidence scripts

Repro scripts for upstream-relevant findings discovered while building this
plugin. Kept in-repo so a reader can re-run them against the same dependency
versions this plugin pins.

- `cordis-repro.mjs`, `cordis-repro2.mjs` — **F8**: runtime `ctx.plugin()`
  service insertion wakes consumers via a ~200ms two-step cascade; a session
  that snapshots its toolset mid-cascade can lose tools. The lifecycle plugin
  ships a settle barrier in `apply()` as its side of the fix; the cascade
  itself is upstream loader timing. Requires the cordis version from this
  package's lockfile on PATH (`npm ls @deepseek-ai/cordis` or adjust the
  import).
