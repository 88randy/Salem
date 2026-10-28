# AGENTS.md

Rules for contributors and coding agents (Claude Code, Codex, others) making a reviewable change to Salem. Human-facing contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md); security reports follow [SECURITY.md](SECURITY.md).

## Stack

- Node.js 22 (`engines: >=22 <23`), npm, Git. ESM only (`"type": "module"`).
- TypeScript 5.9 with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; `NodeNext` modules, so relative imports in `.ts` end in `.js`.
- Core in `src/` and `tests/` compiles to `dist/`. The UI in `ui/` is React 19 built with Vite; UI tests use Playwright.
- Build and release scripts in `scripts/` are plain `.mjs`. Dependencies are pinned to exact versions.
- CI (`.github/workflows/ci.yml`) runs only on `windows-latest`.

## Commands

```sh
npm ci                        # install exactly what package-lock.json pins
npm run typecheck             # core and UI, no emit
npm test                      # full build, then every compiled core test (serial, slow)
npm run build:core            # compile src/ and tests/ only
node --test dist/tests/config.test.js   # one core test file, after build:core
node --test tests/public-export.test.mjs # .mjs tests run directly, no build
npm run test:distribution     # export and Windows packaging tests
npx playwright install chromium
npm run test:ui               # Playwright UI tests
```

`scripts/test.mjs` sets `TMP`, `TEMP` and `TMPDIR` to the canonical temp path because Windows runners may expose an 8.3 alias. If a single-file run fails on path comparisons, rerun it through `npm test` before assuming a bug.

## Code style

- Match the density and idiom of the file you edit. Most of the code is compact: several statements per line, short local names, few blank lines. `scripts/*.mjs` is denser than `src/`. Do not reformat code you are not changing; no formatter or linter is adopted yet.
- Identifiers, comments, commit messages, branches and issues are in English.
- User-facing text (CLI output, errors shown to users, UI, user docs) is in Spanish.
- Comments explain non-obvious constraints, not what the line does.
- External commands are argument arrays without a shell, spawned with `windowsHide: true`. Never build shell strings.
- Fail closed on untrusted input: paths, links/junctions, PIDs and file contents read from disk.

## Testing

- Write the test first and watch it fail for the expected reason. Bug fixes start with a reproduction.
- Tests use simulated providers (`tests/fixtures/`). Automated tests must never consume AI quota or need a paid account. Label real-inference evidence as such.
- Do not change acceptance rules, permissions or budgets to make a test pass.
- Prefer readiness signals over fixed sleeps; on timeout, report the child's exit status and stderr.
- Changes to persistence, cancellation, delivery or evolution must cover recovery and must not touch changes that belong to someone else.

## Windows specifics

- Working copies are usually checked out with CRLF (`core.autocrlf=true`). Do not commit line-ending-only churn. Code that compares bytes in generated repositories sets `core.autocrlf=false` there (see `scripts/benchmark.mjs`).
- Directory links are junctions on Windows (`symlink(target, path, "junction")`). Code that walks repositories must reject paths that leave the root through one.
- Process trees are stopped with `taskkill /T /F`. Tests must clean up every process they start and check liveness with PID reuse in mind.
- Temp paths may differ between their 8.3 and long forms; compare canonical (`realpath`) paths.

## Workflow

1. Every change starts as a GitHub Issue with these sections: Context, Objective, Scope / Out of scope, Data model, Contract (API / interfaces), Behavior, Edge cases and errors, Acceptance criteria, Notes.
2. Work on a branch named for the change (for example `fix/...`, `docs/...`).
3. Commits use Conventional Commits in English (`fix: ...`, `docs: ...`, `test: ...`).
4. Open one PR per issue with `Closes #N`. Explain the problem, the result and how it was verified, separating simulated tests from real inference.

## Public repository rules

- Never commit secrets, credentials, `.env` files, private keys, catalogs or unreviewed logs.
- No personal absolute paths (drive-letter or home-directory paths with a user name) in any published file. Use placeholders such as `<repo>`.
- No names of third-party or client projects; use generic references.
- Public snapshots are built by `scripts/export-public.mjs` from an allowlist (`roots`, `guides`, `directories`). A new root file or `docs/` guide is not published until it is added there and covered by `tests/public-export.test.mjs`.
- The export rejects personal paths, private keys, and Markdown links to files outside the snapshot. Keep links relative and pointing to published files.

## Lessons learned

- **Validate file contents, not just existence** (#15). An empty PID file read with `Number("")` gives `0`, which looks like a value. Check that a PID is a positive integer before using it.
- **Windows process containment hides parent-death bugs** (#17). Non-detached children appear to die with their parent on Windows (likely a job object, not yet confirmed). A parent-death test passes there even with the guardian's handler removed, so it does not exercise the guardian. Detached children survive.
- **Sandboxed agents can produce false failures.** A coding agent running in a sandbox may be unable to write a worktree's shared `.git` directory or create junctions. Tests that commit in fixtures or create junctions then skip or fail. Rerun those tests outside the sandbox before treating the failure as real.
