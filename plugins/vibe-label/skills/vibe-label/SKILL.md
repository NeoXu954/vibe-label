---
name: vibe-label
description: Generate a factual, privacy-aware, shareable code-change label in English or Simplified Chinese from a local Git diff. Use when the user asks for a VibeLabel, code ingredients label, code nutrition label, visual diff facts, a Chinese code-change card, a share card for current/staged/branch changes, or an evidence-based Codex versus Claude Code change comparison. Reports change size, languages, direct dependency changes, test-file changes, verification results, sensitive areas, and explicit patterns on added lines without assigning a quality score or uploading source.
---

# VibeLabel

Generate a self-contained local HTML label and a machine-readable JSON report with the bundled Node.js CLI. Keep the result factual: do not infer authorship, quality, coverage, safety, or merge readiness.

## Workflow

1. Resolve the directory containing this `SKILL.md` as the skill root.
2. Confirm the target is a Git repository.
3. Pick exactly one scope:
   - Default/current request: `--current` for `HEAD` to worktree, including staged, unstaged, and untracked files.
   - Explicit staged request: `--staged` for `HEAD` to index.
   - Explicit unstaged request: `--unstaged` for index to worktree, including untracked files.
   - Branch or PR request: `--base <ref>` for `merge-base(ref, HEAD)` to `HEAD`; local dirty changes are excluded.
4. Select the presentation language. Use `--lang zh-CN` when the user asks in Chinese or explicitly requests a Chinese label; otherwise use the English default.
5. Run `node <skill-root>/scripts/vibe-label.mjs --repo <repo> <scope> [--lang zh-CN]`.
6. Return the generated safe `index.html` path. Mention `detailed.html` and `report.json` separately and treat both as private local data.

The default output directory is outside the repository under the operating system's temporary directory. Use `--output <path>` only when the user asks for persistent files.
Presentation language never changes `report.json`, its rule IDs, or the analysis fingerprint.

## Verification

Do not claim a check passed unless it actually ran. Without explicit checks, the label must show `NOT RUN` or `NOT FOUND`.

When the user asks for a verified label, inspect the repository's existing scripts and choose only relevant, established commands. Use repeatable options in `LABEL=COMMAND` form:

```bash
node <skill-root>/scripts/vibe-label.mjs \
  --repo <repo> \
  --current \
  --check "BUILD=npm run build" \
  --check "TEST=npm test" \
  --check "TYPES=npm run typecheck"
```

Checks run before analysis so generated artifacts or source changes are reflected in the final diff. A failed check produces a label and a nonzero CLI exit code; report the failed state rather than hiding the output.

## Privacy And Claims

- Default to `index.html`. It does not embed repository names, branch names, or base refs.
- Treat `detailed.html` as opt-in local data because it includes repository and branch labels.
- Never expose matched secret values, source snippets, absolute paths, remote URLs, author names, or emails.
- Do not publish `report.json` without the user's explicit approval. It contains relative file paths and direct dependency names for local inspection.
- Describe sensitive areas as touched categories, not vulnerabilities.
- Describe added-line patterns as observations, not defects.
- Never add an AI percentage, health score, grade, quality score, coverage judgment, or merge recommendation.
- Preserve `null` binary line counts as unknown; never display them as zero.

## Useful Commands

```bash
# Current changes, safe default
node <skill-root>/scripts/vibe-label.mjs --repo <repo> --current

# Staged changes and open the local result
node <skill-root>/scripts/vibe-label.mjs --repo <repo> --staged --open

# Branch changes relative to main
node <skill-root>/scripts/vibe-label.mjs --repo <repo> --base main

# Current changes with a Simplified Chinese card and summary
node <skill-root>/scripts/vibe-label.mjs --repo <repo> --current --lang zh-CN

# CLI reference
node <skill-root>/scripts/vibe-label.mjs --help
```

Each HTML page exports a 1080 by 1350 PNG and copies a text summary using its privacy mode. The safe page links to a separate local detailed page. Both run locally and send no telemetry.
