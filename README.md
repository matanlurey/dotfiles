# Dotfiles

My dotfiles, managed with [chezmoi](https://www.chezmoi.io/).

Machine-specific config (git email, URL rewrites, API proxies, MCP servers) is handled through chezmoi data overrides. Set values in `~/.config/chezmoi/chezmoi.toml` to customize.

## What's Included

### Shell

- **Zsh** — Default shell with autosuggestions and syntax highlighting
- **fnm** — Fast Node manager (auto-switches on `.node-version`)
- **Starship** — Prompt with Nerd Font icons
- **`~/.zsh_secrets`** — Untracked file for API keys and secrets (sourced automatically)

### AI Agent Config

- **`CLAUDE.md`** — Global project instructions: writing style (anti-slop rules), dotfiles project rules

### Editors

- **Neovim** — Full config with plugins, native LSP, and native completion
- **VS Code** — Editor settings

#### Neovim Cheatsheet

Leader is `<Space>`. Press `<Space>` and pause to see all keybinds (which-key).

**General**

| Key | Action |
|-----|--------|
| `<Space>w` | Save file |
| `<Space>q` | Quit |
| `<Space>e` | Toggle file explorer (neo-tree) |
| `Ctrl+h/j/k/l` | Move between splits |
| `J` / `K` (visual) | Move selected lines down / up |

**Search & Navigate (Telescope)**

| Key | Action |
|-----|--------|
| `<Space>f` | Find files |
| `<Space>g` | Live grep across project |
| `<Space>b` | Open buffers |
| `<Space>s` | Document symbols (LSP) |
| `<Space>/` | Fuzzy search in current buffer |

**LSP (Go, TypeScript, Swift)**

| Key | Action |
|-----|--------|
| `gd` | Go to definition |
| `gr` | Go to references |
| `gi` | Go to implementation |
| `K` | Hover docs |
| `<Space>r` | Rename symbol |
| `<Space>a` | Code action |
| `<Space>d` | Line diagnostics (floating window) |
| `<Space>cf` | Format buffer (also auto-formats on save) |

**Diagnostics & Trouble**

| Key | Action |
|-----|--------|
| `<Space>xx` | Toggle all diagnostics |
| `<Space>xd` | Buffer diagnostics only |
| `<Space>o` | Toggle code outline (symbols sidebar) |
| `<Space>xs` | Symbols outline (Trouble) |
| `<Space>xr` | LSP references panel |
| `<Space>xq` | Quickfix list |

**Code Editing**

| Key | Action |
|-----|--------|
| `gcc` | Toggle comment (line) |
| `gc` (visual) | Toggle comment (selection) |
| `(`, `[`, `{`, `"`, `'` | Auto-closes pair |

**Git**

| Key / Command | Action |
|---------------|--------|
| gutter signs | Added/changed/deleted lines via signify (git, jj, and more) |
| `]c` / `[c` | Next / previous hunk |

**GitHub PR Reviews (gh-review.nvim, works with GHE)**

| Command | Action |
|---------|--------|
| `:GHReview 123` | Open PR #123 for review |
| `:GHReview <url>` | Open PR by URL (GitHub or GHE) |
| `gc` (in review) | Add comment on current line |
| `gs` (in review) | Add suggestion |
| `:GHReviewFiles` | Browse changed files |
| `:GHReviewSubmit` | Submit your review |
| `:GHReviewClose` | Close review session |

**Xcode (Swift files)**

| Key | Action |
|-----|--------|
| `<Space>xb` | Build |
| `<Space>xr` | Build & Run |
| `<Space>xt` | Test |
| `<Space>xd` | Select device |
| `<Space>xp` | Select scheme |
| `<Space>xl` | Toggle build logs |

**Pi Integration**

| Key / Command | Action |
|---------------|--------|
| `<Space>p` | Send to Pi (opens dialog) |
| `:PiSend` | Send prompt to Pi |
| `:PiSendFile` | Send current file to Pi |
| `:PiSendSelection` | Send visual selection to Pi |
| `:PiSendBuffer` | Send entire buffer to Pi |

**Useful Commands**

| Command | Action |
|---------|--------|
| `:Mason` | Manage LSP servers |
| `:TodoTelescope` | Search all TODO/FIXME/HACK comments |
| `:ConformInfo` | Check formatter status |
| `:Lazy` | Manage plugins |

### Apps

- **cmux** — Ghostty-based terminal with vertical tabs, notification rings, and split panes for AI agent workflows
- **Ghostty** — Terminal emulator (Tokyo Night theme, Quake-style dropdown)
- **Zellij** — Terminal multiplexer (Tokyo Night, session persistence, `dev`, `uw`, and `mbp` layouts)
- **KeepingYouAwake** — Menu bar utility to prevent Mac from sleeping (wraps `caffeinate`)
- **Superwhisper** — Local Whisper-based voice-to-text, works in terminals
- **[pi](https://github.com/earendil-works/pi-coding-agent)** — Coding agent (settings, packages, and extensions managed)
- **[Hunk](https://github.com/modem-dev/hunk)** — Review-first terminal diff viewer with live session daemon, agent annotations, and inline comments. Has a built-in pi skill: `hunk skill path`

#### cmux Workspace Commands

| Command | Layout | What it does |
|---------|--------|--------------|
| **Dev** | 2-col split | Left: nvim + shell tabs. Right top: pi. Right bottom: lazyjj |
| **Ultra-wide** | 3-col split | Three columns: shell, shell, shell |
| **Review** | 2-col split | Left: hunk diff --watch. Right: shell |

cmux also adds Pi, lazyjj, nvim, and hunk as surface tab bar buttons (Cmd+Shift+P for pi, Cmd+Shift+E for nvim, Cmd+Shift+D for hunk --watch).

#### Ghostty Shaders

| Shader | What it does |
|--------|--------------|
| **bloom.glsl** | Subtle glow effect on bright text |
| **cursor_warp.glsl** | Animated cursor warp effect |

#### Zellij Cheatsheet

Zellij starts in **locked mode** so all keys pass through to terminal apps (no conflicts with Neovim, fzf, etc.). Press `Ctrl+g` to enter Zellij's normal mode, then use mode keys. Press `Esc` or `Enter` to go back to locked.

**Workflow: `Ctrl+g` → do Zellij stuff → `Esc`**

**Quick Actions (Normal Mode, after `Ctrl+g`)**

| Key | Action |
|-----|--------|
| `Alt+h/j/k/l` | Navigate between panes |
| `Alt+n` | New pane |
| `~` | Toggle floating panes (quake mode) |
| `Alt+=`/`Alt+-` | Resize panes |
| `Alt+[`/`Alt+]` | Cycle layouts |

**Mode Keys (enter normal with `Ctrl+g`, then press mode key)**

| Mode Key | Mode | Common Actions |
|----------|------|---------|
| `Alt+p` | Pane | `n` new, `d` split down, `r` split right, `x` close, `f` fullscreen |
| `Ctrl+t` | Tab | `n` new, `x` close, `r` rename, `1-9` go to tab |
| `Ctrl+n` | Resize | `h/j/k/l` resize in direction |
| `Ctrl+s` | Scroll | `j/k` scroll, `d/u` half-page, `s` search |
| `Ctrl+o` | Session | `d` detach, `w` session manager |

**Session Management**

```bash
zellij                          # Start or attach to default session
zellij -s myproject              # Named session
zellij ls                        # List sessions
zellij a myproject               # Attach to session
zellij d myproject               # Delete session
```

#### Pi Packages

| Package | What it does |
|---------|--------------|
| **pi-web-access** | Web search, fetch, and content extraction tools |
| **pi-mcp-adapter** | MCP server integration — connects to configured MCP servers lazily |
| **pi-fzfp** | Replaces built-in `@` file autocomplete with fzf-powered fuzzy matching |
| **pi-nvim** | Unix socket bridge — lets Neovim send prompts to a running Pi session |
| **pi-draw** | Drawing/diagramming tool by mitsuhiko |
| **pi-autoresearch** | Autonomous experiment loop — run, measure, keep or discard |
| **pi-interview** | Interactive interview forms — rich question types with native macOS window |
| **pi-remote** | Remote terminal access via WebSocket and browser, with Tailscale integration |
| **pi-subagents** | Spawn sub-agents for parallel task execution |
| **pi-prompt-template-model** | Custom prompt templates (slash commands) with model selection, deterministic pre-steps, loops, chains, and subagent delegation |
| **pi-code-previews** | Live code preview rendering |
| **pi-intercom** | Cross-session communication between pi agents |
| **glimpseui** | Native WebView window for scripts and agents — used by pi-interview for macOS native dialogs |
| **pi-agent-browser-native** | Native browser automation tool wrapping agent-browser for web debugging, perf, and QA |
| **pi-boomerang** | Reconnect and resume pi sessions after restart/crash |
| **pi-commandcode-provider** | Connects Pi to the Command Code API (Claude, GPT, DeepSeek V4, Kimi, GLM, Qwen 3.6, and more) |
| **pi-cmux** | Terminal multiplexer integration for pi |
| **pi-anthropic-auth** | Anthropic model provider with custom proxy/base URL support via `@gotgenes/pi-anthropic-auth` |
| **pi-tasks** | Claude Code-style task tracking and coordination — structured tasks, dependency management, persistent widget |
| **pi-goal** | Session-scoped `/goal` mode — autonomous, verifiable task completion with guarded continuation turns |

#### Pi MCP Servers

| Server | What it does |
|--------|--------------|
| *(none by default)* | MCP servers are configured via chezmoi data overrides |

#### Pi Custom Providers

| Provider | What it does |
|----------|---------------|
| **commandcode** | DeepSeek V4 models via the Command Code API — install `pi-commandcode-provider`, run `/login commandcode` or select from list |
| **anthropic** | Claude Sonnet 4.6, Opus 4.6 via Anthropic OAuth subscription — install `pi-anthropic-auth`, run `/login anthropic` |

#### Pi Extensions

| Extension | What it does |
|-----------|--------------|
| **guardrails.ts** | Hard-blocks bash commands that hang the session or violate policy: `find /`\|`~`\|`$HOME` (unbounded filesystem scans), `jj`/`git -i`/`--interactive` (opens an editor, hangs non-interactive sessions), and `jj squash` (never-squash policy) |
| **review.ts** | `/review` for local self-review (jj diff), `/review <PR>` for GitHub PRs — Conventional Comments format |
| **tts.ts** | `/speak` reads last response aloud via macOS `say`; `/speak auto` toggles auto-speak |
| **gh-agent/** | `/gh-agent` — autonomous GitHub issue worker. Watches a label, works issues in isolated worktrees, opens draft PRs, answers reviews with new commits, fixes red CI, stands down on merge or label removal. Runs as a detached daemon. See [its README](private_dot_pi/agent/extensions/gh-agent/README.md) |

#### Pi Skills

| Skill | What it does |
|-------|---------------|
| **grill-me** | Conducts a rigorous technical interview on the current codebase using pi-interview |
| **api-doc-comments** | Writes and de-slops high-quality documentation comments for public APIs (agnostic principles + TS/Python/Rust/Go references) |
| **hunk-review** | Drives live Hunk diff-review sessions via CLI — inspects focus, navigates files/hunks, and adds inline review comments (bundled with `hunk`, copied via `hunk skill path`) |
| **simplify** | Reviews code for word choice, structure, and overfitting before it's ready for human review (adapted from [bholmesdev/skills](https://github.com/bholmesdev/skills)) |
| **done** | Wraps up a finished feature — commits, rebases, merges/PRs, and cleans up worktrees/workspaces (git and jj) (adapted from [bholmesdev/skills](https://github.com/bholmesdev/skills)) |
| **bro** | Restates the last message in plain human language, no jargon (adapted from [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles)) |
| **handoff** | Compacts the current conversation into a handoff document (saved to the OS temp dir) for another agent to pick up, with suggested next skills (adapted from [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles)) |
| **writing-great-skills** | Reference for writing and editing skills well — vocabulary and principles for predictable skills, plus a glossary (adapted from [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles)) |
| **hashi-style** | Write and review code in the style of Mitchell Hashimoto's open source work — declaration comments carrying design rationale and caller contracts, sparse narrative body comments, machine-checked invariants, behavior-named colocated tests |
| **codebase-design** | Shared vocabulary for designing deep modules — module, interface, seam, adapter, leverage, locality — plus dependency-category guidance for deepening and a design-it-twice parallel sub-agent pattern (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **improve-codebase-architecture** | Scans a codebase for deepening opportunities, presents them as a visual HTML report (Tailwind + Mermaid), then grills through whichever candidate you pick (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **grilling** | Interviews the user relentlessly, one question at a time with a recommended answer, until a plan or decision reaches shared understanding (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **domain-modeling** | Builds and sharpens a project's domain model — challenges fuzzy terms, cross-references code, and keeps `CONTEXT.md`/ADRs current as decisions crystallise (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **tdd** | Red-green-refactor discipline — seam-first testing, anti-patterns (implementation-coupled, tautological, horizontal slicing), and rules of the loop (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **diagnosing-bugs** | Six-phase diagnosis loop for hard bugs and perf regressions — build a tight red-capable feedback loop first, then reproduce/minimise, hypothesise, instrument, fix with a regression test, and clean up (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **setup-matt-pocock-skills** | One-time per-repo scaffolding for the engineering skills — issue tracker (GitHub/GitLab/local markdown), triage label vocabulary, and domain doc layout (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **grill-with-docs** | Runs a `/grilling` session using `/domain-modeling`, so the interview also produces ADRs and glossary updates as it goes (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **to-spec** | Synthesizes the current conversation into a spec/PRD (problem, solution, user stories, implementation and testing decisions) and publishes it to the issue tracker, no interview (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **to-tickets** | Breaks a plan/spec/conversation into tracer-bullet vertical-slice tickets with explicit blocking edges, published to the configured tracker (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **implement** | Implements a spec or ticket set using `/tdd` at pre-agreed seams, runs typecheck/tests, reviews with `/code-review`, and commits (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **wayfinder** | Plans oversized work as a shared map of decision tickets (research/prototype/grilling/task) on the issue tracker, resolved one at a time until the route is clear (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **prototype** | Builds throwaway prototypes to answer a design question — an interactive terminal app for state/logic questions, or switchable UI variants for look-and-feel questions (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **research** | Spins up a background agent to investigate a question against primary sources and capture findings as a cited Markdown file (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **resolving-merge-conflicts** | Resolves an in-progress git merge/rebase conflict by understanding both sides' intent from history, preserving both where possible, then running checks and finishing (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **triage** | Moves issues and external PRs through a triage state machine — categorise, verify, grill if needed, and write durable agent-ready briefs (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **wizard** | Generates an interactive bash wizard that walks a human through a manual setup/migration procedure — opens URLs, captures values, writes `.env`/GitHub secrets (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **to-questionnaire** | Turns a decision the user can't answer alone into a Markdown questionnaire for the person who holds the missing context (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |
| **teach** | Stateful, multi-session teaching workspace — mission, resources, lessons, reference docs, glossary, and learning records tuned to the user's zone of proximal development (adapted from [mattpocock/skills](https://github.com/mattpocock/skills)) |

#### Pi Prompt Templates

Custom slash commands (`private_dot_pi/agent/prompts/`, via `pi-prompt-template-model`). `/audit`, `/audit-next`, and `/audit-prev` page through a path/glob in Hunk, batched — reviewing and discussing it from there is just the `hunk-review` skill above. `/deep-dive` is a standalone structured review prompt, independent of Hunk.

| Command | What it does |
|---------|---------------|
| **/audit \<path-or-glob\>** | Enumerates non-ignored, non-generated, non-binary files under the target, splits them into batches, and opens batch 1 in your live Hunk session. Resumable — re-running the same target continues from wherever you left off; `--fresh` restarts it; `--batch-size N` overrides the default of 8 |
| **/audit-next** | Opens the next batch in Hunk |
| **/audit-prev** | Opens the previous batch in Hunk |
| **/deep-dive \<path\> [focus]** | Reads every file under the path, then checks it against real callers/exports (dead public API), test coverage of edge/error/interaction paths, project conventions (README/lint/type-check/test), and asymmetries between sibling variants (e.g. sync vs. async). Reports findings as Conventional Comments grouped by file with a summary table; optional trailing args add extra focus for that pass |

The bookkeeping (enumeration, batching, current position, resuming) lives in `private_dot_pi/agent/prompts/audit-scripts/audit.mjs` — a plain Node script, not a Pi extension, since none of this needs a persistent background process or a live status widget.

### Brewfile

Managed packages:

- `font-fira-code-nerd-font`
- `agent-browser`, `ansible`, `bat` (with Tokyo Night theme), `duckdb`, `eza`, `fd`, `fzf`, `gh`, `git`, `git-delta`, `glow`, `go`, `hunk`, `jj`, `jq`, `k9s`, `lazyjj`, `playwright-cli`, `procs`, `ripgrep`, `starship`, `tokei`, `xan`, `xcodes`, `yazi`, `zellij`, `zoxide`
- `jj-hooks` (runs pre-commit/pre-push hooks before jj pushes)
- `mlux` (Typst-powered terminal markdown viewer; installed from GitHub releases)
- `fnm`, `zsh`, `zsh-autosuggestions`, `zsh-syntax-highlighting`
- `neovim`, `visual-studio-code`
- `cmux`, `ghostty`, `keepingyouawake`, `superwhisper`

## Getting Started

### Prerequisites

- macOS (Apple Silicon)
- [Homebrew](https://brew.sh/)

### Fresh Machine Setup

```bash
# Install chezmoi and apply dotfiles in one command
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply matanlurey
```

After applying, create `~/.zsh_secrets` for any API keys:

```bash
echo 'export ANTHROPIC_API_KEY="your-key"' > ~/.zsh_secrets
```

### Existing Machine (Cloned Repository)

If you have already cloned the repository and want to manage the files in the current directory:

```bash
# Initialize chezmoi to use the current directory as source
chezmoi init --source .

# Apply changes from the current directory
chezmoi apply
```

To test changes without permanently setting the source, use the `-S` flag:

```bash
chezmoi -S . diff
```

### Existing Machine (Remote)

```bash
chezmoi init https://github.com/matanlurey/dotfiles.git
chezmoi diff   # Preview changes
chezmoi apply  # Apply changes
```

### Day-to-Day Usage

```bash
chezmoi edit ~/.config/ghostty/config  # Edit a managed file
chezmoi update                         # Pull latest and apply
chezmoi add ~/.config/some/config      # Add a new dotfile
chezmoi diff                           # See what would change
```

## CLI Tools Cheatsheet

### bat — better `cat`

```bash
bat README.md                  # Syntax-highlighted file viewing
bat -p README.md               # Plain output (no line numbers/header)
bat src/*.ts --language ts      # Force language for highlighting
```

### eza — better `ls`

```bash
eza -la                        # List all files, long format
eza --tree --level=2           # Tree view, 2 levels deep
eza -la --git                  # Show git status for each file
```

### fd — better `find`

```bash
fd "pattern"                   # Find files matching pattern
fd -e ts                       # Find all TypeScript files
fd -e ts --exec wc -l          # Count lines in each .ts file
```

### fzf — fuzzy finder

```bash
Ctrl+R                         # Fuzzy search command history
Ctrl+T                         # Fuzzy find files
Alt+C                          # Fuzzy cd into directories
```

### gh — GitHub CLI

```bash
gh pr list                     # List pull requests
gh pr create                   # Create a PR interactively
gh issue list                  # List issues
```

### duckdb — SQL on files

```bash
duckdb -c "SELECT * FROM 'data.csv' LIMIT 10"   # Query a CSV with SQL
duckdb -c "SELECT * FROM 'data.parquet'"         # Works with Parquet too
duckdb -c "SUMMARIZE FROM 'data.csv'"            # Quick stats on all columns
```

### delta — better diffs

Configured as the default pager for `jj`. No direct usage needed — diffs are automatically pretty.

### glow — markdown renderer

```bash
glow README.md                 # Render markdown in terminal
glow -p README.md              # Pager mode for long docs
```

### mlux — Typst-powered markdown viewer

Renders markdown through Typst's typesetting engine with inline images, LaTeX math, and Mermaid diagrams. Requires a Kitty-protocol terminal (Ghostty, Kitty, WezTerm).

```bash
mlux README.md                 # View markdown with Typst rendering
mlux --watch README.md         # Auto-reload on file change
```

### jj — Jujutsu VCS

```bash
jj log                         # Show commit graph
jj describe -m "message"       # Set commit message
jj new                         # Create new empty change
jj push                        # Push (runs pre-commit hooks first via jj-hooks)
```

### jq — JSON processor

```bash
echo '{"a":1}' | jq .          # Pretty-print JSON
curl -s api | jq '.items[].name'  # Extract nested fields
jq -r '.key' file.json         # Raw output (no quotes)
```

### lazyjj — TUI for Jujutsu

```bash
lazyjj                         # Launch interactive jj interface
```

### procs — better `ps`

```bash
procs                          # List all processes, pretty
procs node                     # Filter by name
```

### ripgrep — better `grep`

```bash
rg "pattern"                   # Search recursively
rg "pattern" -t ts             # Search only TypeScript files
rg "pattern" -l                # List matching filenames only
```

### tokei — code statistics

```bash
tokei                          # Count lines of code by language
tokei src/                     # Stats for a specific directory
```

### xan — CSV toolkit

```bash
xan view data.csv              # Pretty-print CSV as a table
xan headers data.csv           # List column names
xan search "pattern" data.csv  # Grep rows matching a pattern
```

### yazi — terminal file manager

```bash
yazi                           # Launch file manager
yazi /path/to/dir              # Open in specific directory
```

### zoxide — smarter `cd`

```bash
z projects                     # Jump to most-used match for "projects"
zi                             # Interactive selection with fzf
```

## File Structure

```
.chezmoi.toml.tmpl                # chezmoi init config (prompts for email)
Brewfile                          # Homebrew packages
dot_zprofile                      # Login shell: env vars, PATH
dot_zshrc                         # Interactive shell: plugins, prompt, NVM
dot_config/cmux/cmux.json         # cmux terminal config (workspace commands, actions, sidebar)
dot_config/ghostty/               # Ghostty terminal emulator config
dot_config/zellij/config.kdl      # Zellij multiplexer config (Tokyo Night)
dot_config/zellij/layouts/        # Zellij layouts (dev: full workflow; uw: ultra-wide single-tab; mbp: laptop 3-tab)
dot_config/bat/themes/             # bat syntax themes (tokyonight_night)
dot_config/delta/themes.gitconfig  # Delta diff viewer config
dot_config/jj/config.toml.tmpl    # Jujutsu VCS config (templated email)
dot_gitconfig.tmpl                # Git config (templated email, conditional URL rewrites)
dot_gitignore_global              # Global gitignore (.DS_Store, .idea, etc.)
dot_config/nvim/init.lua          # Neovim config
dot_config/starship.toml          # Starship prompt config
private_dot_pi/agent/AGENTS.md.tmpl       # Agent instructions (data-driven optional sections)
private_dot_pi/agent/mcp.json.tmpl        # MCP servers (data-driven, empty by default)
private_dot_pi/agent/models.json.tmpl     # AI providers (data-driven proxy override)
private_dot_pi/agent/modify_settings.json # pi settings + packages (modify script)
private_Library/                  # VS Code settings
run_once_install-packages.sh      # Runs once: brew bundle + pi install
```
