# Agent Instructions

<!-- agent-sync:agent-policy:start -->
This file contains shared project knowledge, conventions, and agent instructions.

See:
- MEMORY.md — project learnings, component pitfalls, and durable lessons
- AGENTS.local.md — local private notes and personal overrides (gitignored)

## Overview

agent-sync is a zero-config project boilerplate and best-practices initializer for AI coding agents. Helpers and tests use Python 3.10+ and the standard library; no dependency installation is needed.

## Commands

- Verify: `python3 -m unittest discover -s tests -p "test_*.py"`
- Focused test: `python3 -m unittest tests.test_setup.TestSetupScript.test_first_run_scaffolds_all_files`
- Bump version: `scripts/bump-version.sh <new-version | patch | minor | major>`

## Key Constraints & Gotchas

- `skills/*`: preflight is read-only; apply only staged writes, then reread and verify preservation of unmanaged bytes.

## Conventions

- Commits: Conventional Commits (e.g. `feat(auth): add token refresh`). Keep plan names, task numbers, and AI attribution (no "Co-Authored-By" trailers or PR footers) out; disable auto-attribution in agent config.

## Session Memory & Resuming
- Shared memory (agent-mem): a short digest of recent sessions from every agent is injected at session start. Don't re-explore work it already covers; search with `/agent-sync:mem-search` before re-reading large files or re-running long investigations.
- Resuming: if the digest warns that a session was interrupted, or the user says continue/resume work another agent started, run `/agent-sync:resume` first and continue its in-progress step instead of starting over.
<!-- agent-sync:agent-policy:end -->
