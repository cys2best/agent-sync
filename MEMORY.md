# Project Memory & Lessons

<!-- agent-sync:memory:start -->
## Lessons

- Imports: only Claude Code resolves `@path` references → other agents must read shared files explicitly.
- Rule visibility: Claude-specific rules are invisible to other agents → keep repository-wide constraints in AGENTS.md.
- Config precedence: `.agent-sync/config.json` wins → migrate root `.agent-sync.json` only when the canonical file is absent.
<!-- agent-sync:memory:end -->
