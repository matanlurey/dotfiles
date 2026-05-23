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
| gutter signs | Added/changed/deleted lines (automatic) |
| `:J log` | Jujutsu log |
| `:J describe "msg"` | Set jj commit message |
| `:J new` | Create new jj change |

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
- **[pi](https://github.com/mariozechner/pi-coding-agent)** — Coding agent (settings, packages, and extensions managed)
- **[Herdr](https://herdr.dev/)** — Terminal workspace manager for coding agents
- **[Dunk](https://github.com/amix/dunk)** — Terminal diff viewer with inline review comments for agent workflows (split/stack views, jj support)
- **[Hunk](https://github.com/modem-dev/hunk)** — Review-first terminal diff viewer with live session daemon, agent annotations, and inline comments

#### cmux Workspace Commands

| Command | Layout | What it does |
|---------|--------|--------------|
| **Dev** | 2-col split | Left: nvim + shell tabs. Right top: pi. Right bottom: lazyjj + herdr tabs |
| **Ultra-wide** | 3-col split | Three columns: shell, shell, herdr-session |
| **Review** | 2-col split | Left: dunk diff --watch. Right: shell |

cmux also adds Pi, lazyjj, nvim, and dunk as surface tab bar buttons (Cmd+Shift+P for pi, Cmd+Shift+E for nvim, Cmd+Shift+D for dunk --watch).

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
| **pi-code-previews** | Live code preview rendering |
| **pi-intercom** | Cross-session communication between pi agents |
| **pi-agent-browser-native** | Native browser automation tool wrapping agent-browser for web debugging, perf, and QA |

#### Pi MCP Servers

| Server | What it does |
|--------|--------------|
| *(none by default)* | MCP servers are configured via chezmoi data overrides |

#### Pi Custom Providers

| Provider | What it does |
|----------|---------------|
| **ollama** | Local Qwen3-Coder (30B) via Ollama — `ollama serve`, then `/model ollama/qwen3-coder:30b` in Pi |

#### Pi Extensions

| Extension | What it does |
|-----------|--------------|
| **prefer-fd.ts** | Nudges the agent to use `fd` instead of `find` for file searching |
| **review.ts** | `/review` for local self-review (jj diff), `/review <PR>` for GitHub PRs — Conventional Comments format |
| **tts.ts** | `/speak` reads last response aloud via macOS `say`; `/speak auto` toggles auto-speak |

#### Pi Skills

| Skill | What it does |
|-------|---------------|
| **dunk-review** | Reads `dunk comments` from a review session and addresses each one (fix code, resolve comment) |
| **grill-me** | Conducts a rigorous technical interview on the current codebase using pi-interview |

### Brewfile

Managed packages:

- `font-fira-code-nerd-font`
- `agent-browser`, `bat` (with Tokyo Night theme), `duckdb`, `eza`, `fd`, `fzf`, `gh`, `git`, `git-delta`, `glow`, `go`, `hunk`, `jj`, `jq`, `k9s`, `lazyjj`, `ollama`, `playwright-cli`, `procs`, `ripgrep`, `starship`, `tokei`, `xan`, `xcodes`, `yazi`, `zellij`, `zoxide`
- `zsh`, `zsh-autosuggestions`, `zsh-syntax-highlighting`
- `neovim`, `visual-studio-code`
- `cmux`, `ghostty`, `keepingyouawake`

## Getting Started

### Prerequisites

- macOS (Apple Silicon)
- [Homebrew](https://brew.sh/)

### Fresh Machine Setup

```bash
# Install chezmoi and apply dotfiles in one command
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply matan
```

After applying, create `~/.zsh_secrets` for any API keys:

```bash
echo 'export ANTHROPIC_API_KEY="your-key"' > ~/.zsh_secrets
```

### Existing Machine

```bash
chezmoi init https://github.com/matan/dotfiles.git
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

### jj — Jujutsu VCS

```bash
jj log                         # Show commit graph
jj describe -m "message"       # Set commit message
jj new                         # Create new empty change
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
private_dot_local/private_bin/     # Wrapper scripts (~/.local/bin) -- herdr-session
dot_config/bat/themes/             # bat syntax themes (tokyonight_night)
dot_config/delta/themes.gitconfig  # Delta diff viewer config
dot_config/jj/config.toml.tmpl    # Jujutsu VCS config (templated email)
dot_gitconfig.tmpl                # Git config (templated email, conditional URL rewrites)
dot_gitignore_global              # Global gitignore (.DS_Store, .idea, .dunk, etc.)
dot_config/nvim/init.lua          # Neovim config
dot_config/starship.toml          # Starship prompt config
private_dot_pi/agent/AGENTS.md.tmpl       # Agent instructions (data-driven optional sections)
private_dot_pi/agent/mcp.json.tmpl        # MCP servers (data-driven, empty by default)
private_dot_pi/agent/models.json.tmpl     # AI providers (data-driven proxy override)
private_dot_pi/agent/modify_settings.json # pi settings + packages (modify script)
private_Library/                  # VS Code settings
run_once_install-packages.sh      # Runs once: brew bundle + herdr install
```
