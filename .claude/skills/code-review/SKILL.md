---
description: Multi-specialist thorough code review of pending changes — security/path safety, performance, code quality, and regressions/conventions. Parallel subagents per specialty. Use for pre-commit or pre-push audits, or when reviewing a specific commit, PR, or ref range. Pass --staged for a pre-commit review of staged changes only.
disable-model-invocation: true
argument-hint: [scope] [--staged] [--save]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Glob, Grep, Agent, Write
---

# Thorough multi-specialist code review

Run a deep review across four specialties in parallel, then merge into one structured report using the format at the bottom of this file.

This skill shares a name with Claude Code's built-in `code-review`, so in this repo it takes over `/code-review`. It does **not** implement the built-in's `--fix`, `--comment`, `--ultra`, or `--post`. If one of those appears in `$ARGUMENTS`, say plainly that this project's reviewer is read-only and doesn't support it, rather than ignoring the flag — a silently dropped `--fix` looks like a no-op review.

## Scope

Pick the scope from `$ARGUMENTS` first, then fall back:

1. **`--staged`** — staged-only mode. Diff is `git diff --cached`. If nothing is staged, say so and exit with a one-line `PASS` (no changes to review).
2. If `$ARGUMENTS` is a commit ref or range (`abc123`, `abc..HEAD`, `main..HEAD`), use it directly with `git show` / `git diff`.
3. If `$ARGUMENTS` is a PR number (`#123` or `123`), resolve via `gh pr view <num> --json baseRefName,headRefName,number,title` then diff `<base>...<head>`.
4. If empty: review what is not yet pushed. This repo commits directly to `main`, so that is usually `git diff origin/main...HEAD` plus any uncommitted work — check `git status --short` and say which of the two you are reviewing. If the working tree is dirty, review `git diff HEAD` (tracked changes) **and** list untracked files, since new files here are often the whole point (a new static asset, a new script).
5. If still ambiguous, ask **one** clarifying question naming the candidate scope (e.g. "Review the 3 unpushed commits on `main`, or just the dirty working tree?") rather than open-ended.

Once scope is fixed, capture:

- File list and line counts: `git diff <range> --stat`
- Full diff: `git diff <range>` (keep the file list separately for assigning to specialists)
- Untracked files, if reviewing a dirty tree: `git status --porcelain`
- Commit message(s) if applicable: `git show <ref>` or `gh pr view <num>`

A caution specific to this repo: the working tree often carries **more than the change you were just asked about** — several features can sit uncommitted at once. Review everything in scope, and if the diff spans clearly unrelated features, say so in the report header rather than pretending it's one change.

## Specialists

Spawn **four `code-reviewer` subagents in parallel** (a single message with four `Agent` tool calls, each with `subagent_type: "code-reviewer"`). The agent definition at `.claude/agents/code-reviewer.md` already encodes the universal rules — what the codebase is, severity scheme, output format (`file:line` + **Fix:**), citation verification, read-only restriction, and the forbidden recommendations (no dependencies, no build step, no TypeScript, no SFCs, no test framework). Don't restate those in your prompts.

Each subagent prompt should contain only:

1. **Specialty assignment**: "You are running as the **<Security/Path safety | Performance | Code Quality | Regressions/Conventions>** specialist for `/code-review`."
2. **Scope**: the exact diff range / commit ref / `--cached` flag, plus the pre-computed file list (so they don't refetch).
3. **Specialty brief**: the bullet list from the matching subsection below.
4. **Pointer to the checklist**: read `.claude/skills/code-review/checklist.md` first for project-specific signals.
5. **Output instructions**: return only findings for this specialty, no TL;DR, no verdict — the orchestrator merges across specialists.

### Subagent 1 — Security & path safety
- **Path containment on every endpoint that accepts a path.** A caller-supplied path must be `path.resolve`d and confirmed to sit inside the media root, the ComfyUI output root, or the workflows dir before any read, write, move, or delete. Compare against `/api/dirs`, `/api/move`, `/api/mkdir`, and the `WORKFLOWS_DIR` check in `/api/workflow-field-config`. A new path-taking endpoint without that check is Critical. Note the checklist's list of endpoints that predate the pattern — those are gaps, not precedents.
- **Destructive endpoints must not overwrite.** Move/rename paths pick a free stem before moving so a same-named file survives and a video keeps its sidecar thumbnail. Skipping that is silent data loss.
- **Prefix checks that aren't boundary-aware** — `startsWith(root)` without a trailing separator lets a sibling directory (`…/Media2` against root `…/Media`) pass as "inside".
- **Name validation on anything that becomes a filename or directory** — separators, `..`, leading dots, Windows device names (`CON`, `NUL`, `COM1`…), trailing dots/spaces, length.
- **Static file serving stays an explicit allowlist.** Generic "serve any file under `__dirname`" logic is a Critical finding; new assets belong in the existing allowlist branch.
- **Secrets** — API keys live in `config.json`. Flag any path that returns them to a client unredacted, writes them to a log or debug dump, embeds them in a page, or forwards them to a third party.
- **Child processes** — the ComfyUI starter, the Claude CLI, and ffmpeg/ffprobe are all spawned. Flag user-controlled data reaching a shell string, `shell: true` with interpolation, or an argument array built from unvalidated input.
- **The proxy to ComfyUI** — flag anything that lets a caller choose the upstream host/URL rather than using the configured `comfyUrl`.
- **Exposure changes** — a new bind address, a permissive CORS header, a new port, or anything that widens reachability beyond localhost + the private VPN.
- **The prompt sanitizer's term list must stay base64-encoded** in source (see CLAUDE.md). Plaintext terms are a finding.
- Do **not** file "these endpoints have no authentication" as a finding. That's the intended posture for a localhost/VPN-only app. Only flag it when a change *widens* exposure.

### Subagent 2 — Performance
- **Blocking the single event loop.** One Node process serves the SPA, the REST API, SSE streams, and the ComfyUI WebSocket proxy. `readdirSync` / `statSync` / `readFileSync` / `existsSync` inside a request handler stalls *everything else*, including in-flight generations. Flag new sync fs calls on request paths, especially over directories that can hold thousands of files.
- **Unbounded work per request** — recursive directory walks, listings without pagination or a cap, reading a whole JSON index to answer one lookup, re-scanning the media tree.
- **Per-request process spawns** — ffmpeg/ffprobe for thumbnails or metadata. Results must be cached on disk and reused; flag anything that re-derives them per request.
- **Upstream calls with slow first-byte** — ComfyUI's `/object_info` can take 10–30s TTFB and is cached with a short TTL. Flag code that refetches it per request or per field, or that holds a request open on it without a timeout.
- **Front end** — work inside Vue computeds or render paths that scales with the whole library; rendering unbounded lists; `fetch` in a loop where one call would do; polling where an existing SSE/WS stream already carries the data.
- **Leaks** — `addEventListener` / `setInterval` / SSE / WebSocket / `BroadcastChannel` created without a matching teardown, and job/log arrays that grow without bound.

### Subagent 3 — Code quality & structure
- **`server.js` is already a god file.** Don't propose splitting it wholesale, but do flag a new endpoint that invents its own idiom instead of following the established one (collect body → `JSON.parse` in a `try` → `jsonRes(res, {error}, 4xx)` on failure).
- **Near-verbatim duplication across 2+ sites** — especially the body-collection preamble, path-normalization helpers redefined per endpoint, and client-side fetch/error/toast boilerplate. Propose a named shared helper and say where it goes.
- **Magic strings and numbers** — status values, node types, widget indexes, size thresholds, TTLs. Name them, and say what the rule behind the number is.
- **Swallowed failures** — `catch {}` and `.catch(() => {})` on paths where the user or the log needs to know. `catch {}` is idiomatic here for genuinely optional work; flag it where the failure is material.
- **Fire-and-forget promises** — an unawaited async call whose rejection nobody handles.
- **Front-end structure** — new UI that re-implements what the existing CSS variables and dialog/sheet classes already do; inline `style="…"` where a token exists; a block that reimplements logic already available as a named helper elsewhere in the same file.
- **Comments that no longer match the code** — this codebase leans on explanatory comments; a stale one is worse than none.

### Subagent 4 — Regressions, dead code & project conventions
- **Regressions**: removed endpoints, removed UI controls or keyboard shortcuts, changed response shapes that a client still reads the old way, behavior changes buried in a "reformatting" hunk.
- **Dead code**: a handler nothing calls, a field/flag nothing reads, a helper left behind after its last caller went away, commented-out blocks.
- **Zero dependencies is non-negotiable** — any new entry in `package.json` `dependencies`, or a `require()` of a non-builtin module, is a Critical finding. The rest of the forbidden-recommendation list is in the agent definition; apply it as written there.
- **Workflow / field-config changes** — a diff touching `field-config-runtime.js`, `docs/field-config/gen_field_config.js`, the shape of `app-workflows.json`, or the field UI in `inspect.html` / the Remix dialog must be checked against the "Workflow / field-config subsystem" section of the checklist: field-id stability, saved-edit rot, linked widgets, unreachable targets, positional `widgets_values`. Report those under section 5.
- **Deploy story** — changes to `server.js` only take effect after a restart, while the static pages are served from disk and need only a reload. Flag a change that quietly depends on a restart having happened, and any **new static asset that wasn't added to the server's allowlist** (it will 404 in production while working fine in whatever ad-hoc test was run).
- **Vue conventions** — the global build with runtime-compiled string templates, so no SFCs and no JSX. Template identifiers resolve against the component instance, so a template referencing a module-scope helper is a bug. Check that reactive state is read from the reactive objects (`gridState` / `modalState` mirrors), not from plain module-scope objects that Vue doesn't track — a computed reading a non-reactive object silently caches stale values.
- **Dialog conventions** — a backdrop that closes on outside click must carry `data-backdrop` (see `ui-guards.js`), or drag-selecting text will close it. New Escape/Enter handling must not fight the existing document-level capture handlers.
- **Silent UX failures** — a `fetch` whose failure produces no toast, inline message, or error state; a `busy`/`loading` flag not cleared in a `finally`, leaving a button stuck.
- **Docs discipline** — machine-specific paths, task names, and firewall rules belong in the gitignored `CLAUDE.local.md`, never in the committed `CLAUDE.md` or `README.md`. Flag secrets or absolute local paths landing in committed files.

## Aggregation

After all four subagents return, write a single combined report:

```
# <Change> — <Scope> Review (<commit-ref-or-range>)

<one-line description: file count, ± lines, what the change does>

Specialists: **Security / Path safety**, **Performance**, **Code Quality**, **Regressions / Conventions**.

---

## TL;DR — Top items to fix before commit
1. **<ID>** — <one-sentence summary>.
2. ...
(up to 10 highest-severity items across all specialists, ordered by severity)

---

## 1. Security & path safety
### Critical
- **C1.** ... — `path:line`. **Fix:** ...
### High
- **H1.** ...
### Medium
### Low

## 2. Performance
### Blocking / event loop
### Per-request cost
### Leaks
### Front-end

## 3. Code quality & structure
### Priority 1 — Structural
### Priority 2 — Duplication
### Priority 3 — Magic strings & constants
### Priority 4 — Smaller items

## 4. Regressions, dead code & conventions
### Critical
### High
### Medium
### Low
(prose if no findings — say so explicitly, e.g. "The diff is additive; no endpoint, control, or response shape was removed.")

## 5. Workflow / field-config subsystem
(only when the diff touches it — otherwise omit the section entirely rather than printing "n/a")

---

## Files referenced (consolidated)
Server:
- ...
Front-end:
- ...
Docs / config:
- ...

---

## Summary

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security / Path safety | | | | |
| Performance | | | | |
| Code Quality | | | | |
| Regressions / Conventions | | | | |
| Workflow / field-config | | | | |

**Verdict: PASS** | **FAIL**
```

ID scheme: `C1, C2, …` Critical, `H1, H2, …` High, `M1, M2, …` Medium, `L1, L2, …` Low. Code-quality and performance sections may use numbered priority groups (`#1, #2, …`) instead of severity letters for non-correctness items.

**Verdict rules:**
- **FAIL** if any Critical or High finding exists. List them at the top of the TL;DR and recommend fixing before commit.
- **PASS** otherwise. Medium / Low items are noted for awareness; they do not block.
- In `--staged` (pre-commit) mode the verdict is the *primary* output — print it on the last line so a hook can grep for it.

Every finding MUST include a concrete `file:line` citation and a one-line **Fix:**. No vague "consider improving X" — say what to change.

## Saving the review

By default, **print to chat only**.

If `$ARGUMENTS` contains `--save` (or the user says "save it"), write to `docs/reviews/<scope-slug>-review.md`, where `<scope-slug>` comes from the branch name, PR number, or commit short SHA. Create `docs/reviews/` if it doesn't exist. Confirm before overwriting.

## Do not

- Do not edit any source file as part of this skill — review only. The user decides what to fix. (`--save` writes a report under `docs/reviews/`; that is the only file this skill ever creates.)
- Do not make any recommendation the agent definition forbids — that list is authoritative, and repeating it here would only let the two copies drift.
- Do not file "no authentication on these endpoints" as a finding — see the Subagent 1 brief for why.
- Do not invent `file:line` references — every citation must be verified against the actual file. Line numbers in `server.js` and `index.html` drift; re-check before citing.
- Do not skip any of the four specialists for "small" diffs. A 30-line change here can still escape the media root or block the event loop.
- Do not restart the server, run the app, or touch the running instance / scheduled task.
- Do not commit or push.
