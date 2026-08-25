# CODYSSEY

> Architecture guardrails for AI coding agents.
> Tells the agent what will break **before** it edits, and actually blocks edits to protected code.

[한국어 문서 →](README.ko.md)

## Why

AI coding agents quietly break things that used to work. Every existing tool only
*informs* — the agent can ignore it. CODYSSEY intercepts at the `PreToolUse` hook and
denies the edit with a reason. That is the only point with real enforcement.

Blocking `Edit` alone is not enough: one `sed -i` walks straight through it. So CODYSSEY
**reads `Bash` commands too** and works out which files they would write. Redirection,
heredocs, `sed -i`, `tee`, `cp`/`mv`, `rm` all go through the same rules. Read-only
commands (`cat`, `grep`, `npm test`) pass untouched.

## Quick start

**You can just ask your agent.** Tell Claude Code:

> "Install codyssey. Run `npx codyssey init`, and tell me to restart Claude Code when it's done."

Or run it yourself:

```bash
npx codyssey init
```

That is the whole setup. It reads your code, writes the config, and opens a web view.
The port is derived from the project folder, so several projects can run at once
without colliding.

```
Setting up CODYSSEY...

  Read 19 source files
  Found 4 features
  5 files are shared by several features - pick which to lock in the web view

  + .codyssey/rules.yaml
  + .claude/settings.json
  + .mcp.json
  + .git/hooks/pre-commit

Setup complete. This project uses port 7912.

Important: Blocking turns on once you restart Claude Code.
```

**Restart Claude Code once.** Hook settings are read when a session starts. After that
the daemon comes up on its own.

Click a file box in the browser and press **protect**. From then on, when the agent
tries to edit it:

```
[codyssey] Payment core. Needs a human to approve changes.
Files nearby you can edit instead: api/services/order.py
```

## What it does

- **Blocks edits** to locked files, including shell bypasses (`sed -i`, heredoc, `mv`, `rm`)
- **Protects contracts** — warns before removing an export that other files import by name
  (in one real repo, `logger` is imported by 83 files)
- **Traces impact across languages** — which frontend pages break if you change a Python service
- **Suggests what to lock** — files that several features or modules share
- **Tells the agent** what to run after an edit, and what already exists under that name
- **Zero LLM calls.** Static analysis only. No API key, no code leaving your machine
- **Zero code changes.** No imports, no decorators. Delete `.codyssey/` and it is gone
- **Fails open.** If the daemon is down or a rule is unclear, edits pass silently

## Language

CODYSSEY speaks English by default and follows your system locale when that is Korean.

```bash
codyssey init --lang ko      # or en
```

The choice is written to `.codyssey/rules.yaml` as `lang:`, so it stays the same on
every machine that opens the project. `--lang` always wins over the file.

## Works on large repositories

Drawing a 400-file repository all at once is unreadable. The default view shows
**what is around the file you care about**.

- **nearby** — 24 boxes closest to the selected file (or recent activity, locks, suggestions)
- **this module** — one folder group
- **everything** — all of it, collapsed into modules

It always says how many boxes are hidden. Nothing is quietly dropped.

## Two axes: features and modules

| | Features | Modules |
|---|---|---|
| Point of view | screens and APIs people use | code grouped by folder |
| How they are found | files reachable from an entrypoint | two levels below the project root |
| When useful | web apps | always (libraries and CLIs too) |

Files shared by several features, or by several modules, are the lock candidates.

## What file locks cannot catch

Locking a whole file is a blunt tool. Editing that file is usually fine — the real
risk is **one particular name inside it**, or **what you must check afterwards**.

**Contract protection** — removing an export other files import by name:

```
Agent: renaming export function formatMoney to formatCents
->  You are removing 'formatMoney'. 3 places use that name.
    Used by: web/app/admin/page.tsx, web/components/OrderTable.tsx, ...
```

In a real repository, `logger` in `src/shared/logger.ts` is imported by **83 files**.
Deleting something like that during a refactor is the most common accident, and a
file lock does not catch it.

**Tests to run** — what to check after the edit:

```
->  Tests covering this file: tests/core/packager.test.ts
```

**Names that already exist** — building a function that is already there:

```
->  'formatMoney' already exists in web/lib/money.ts.
```

## Three ways it reaches the agent

| Way | When | What |
|---|---|---|
| **Block** | just before an edit | denies a locked file with a reason (1.15ms). Watches `Bash` as well as `Edit`/`Write` |
| **Inform** | session start · prompt · right after an edit | feature list, impact of mentioned files, links that changed |
| **Ask** | when the agent asks | 6 MCP tools: `get_overview` `impact_of` `find_file` `check_edit` `get_unlabeled` `set_labels` |

Informing adds **nothing when there is nothing to say**, and never repeats itself.
A few hundred tokens on every edit is noise, not help.

## In pull requests

```bash
codyssey diff origin/main --markdown
```

```markdown
## Architecture change (vs `origin/main`)

### Locked files changed
- `api/services/payment.py`
These need a human to approve. Please confirm the change was intended.

### New links between modules
- `web/components -> api/routes (HTTP)`
```

Drop in `.github/workflows/codyssey.yml` and it comments on the PR, failing CI when a
locked file changes or a new rule violation appears.

It reports **links between modules**, not individual files. Hundreds of lines because
someone moved one file is something nobody reads.

## Commands

```bash
codyssey init            set up and open the web view
codyssey start           start the web view and file watcher
codyssey doctor          check that everything is wired correctly
codyssey status          print a summary in the terminal
codyssey map             draw the structure in your terminal
codyssey impact <file>   what breaks if I change this
codyssey diff <ref>      how the architecture changed since <ref>
codyssey mcp             MCP server (6 tools for agents)
codyssey stop            stop what is running in the background
codyssey scan            write the structure file only
```

```
$ codyssey impact services/payment.py

2 features affected
  GET /api/v1/admin/stats
  PAGE /checkout

5 places use this file
  api/main.py
  api/routes/admin.py
  ...
```

## Rules

One file: `.codyssey/rules.yaml`. The web view edits it by clicking, but you can write
it by hand.

```yaml
lang: en                                    # en | ko

protect:                                    # the agent cannot edit these
  - path: api/services/payment.py
    reason: Payment core. Needs a human to approve.

layers:                                     # forbid this direction of import
  - deny: web/components/** -> web/lib/api.ts
    reason: Only pages may fetch data.

autolock:                                   # files several features share
  minFeatures: 3
  mode: ask                                 # off | ask | block
```

## Support

TypeScript / JavaScript / Python.
Next.js (app + pages router), TanStack Router, FastAPI `APIRouter` prefix composition
(including nested mounts), tsconfig path aliases, TypeScript ESM (`./x.js` → `x.ts`).

## Status

v0.2.3. Verified against 6 real open-source repositories (`npm run bench`).
304 tests, including a packaged smoke test that installs the built CLI and runs the
whole flow — setup, daemon, web view, lock, block.

## Development

```bash
npm install
npm test          # 7 suites, 304 tests
npm start         # run the daemon
```

`fixtures/shop` is a minimal project with every case worth catching planted in it —
a TypeScript frontend plus a Python backend, so cross-language tracing is actually
exercised. `fixtures/vibe` is the opposite: everything crammed into one file, the way
a lot of vibe-coded projects really look.

```bash
npm run bench -- --pull   # score against 6 real open-source repositories
```

Developing against a single fixture hides real problems — the graph can come out
completely empty on a real repository and you would never know. That happened. So
judgement calls are made from the bench table.

## Layout

```
src/core/      language-independent core - graph, feature extraction, rules
src/adapters/  per-language adapters (~200 lines each)
src/index/     parser, scanner
src/daemon/    resident server + hook responses
src/i18n/      message catalogs (en, ko)
src/ui/        web view (single HTML file, no build step)
```

5 dependencies. 0 LLM calls.
