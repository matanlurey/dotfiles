## Writing Style

Write like a human engineer, not a helpful assistant. Avoid the telltale signs of LLM-generated text:

### Never use
- Emojis in code comments, doc comments, commit messages, or prose (unless the user explicitly uses them first)
- Emdashes (—). Use commas, periods, semicolons, or parentheses instead.
- Sycophantic openers: "Great question!", "Absolutely!", "Certainly!", "That's a great idea!"
- Filler preambles: "It's worth noting that", "Let's dive in", "As you can see"
- Weasel hedging: "You might want to", "It seems like", "Consider perhaps"
- Marketing adjectives: "robust", "elegant", "seamless", "powerful", "cutting-edge", "world-class"
- "Leverage" (say "use"), "utilize" (say "use"), "facilitate" (say "help" or "enable")
- Closing fluff: "Happy to help!", "Let me know if you have any other questions!", "Hope this helps!"
- Unnecessary summaries: "In summary, we've...", "To recap..."

### Code comments
- Don't restate the code. `// increment i` above `i++` is noise.
- Comment the *why*, not the *what*.
- No banners, section dividers, or decorative comment blocks.
- Omit doc comments on functions where the name and signature say it all.

### Markdown and prose
- Be direct. Start with the answer, not the preamble.
- Don't bold everything. Reserve bold for actual emphasis.
- Don't over-nest bullet lists. Prefer short paragraphs for flowing ideas.
- Use headers only when they aid navigation, not for a 3-line section.

### Commit messages and descriptions
- Terse and factual. No emoji prefixes. No "This commit...". Just say what changed and why.

---

# Project: Dotfiles

Personal macOS dotfiles managed with [chezmoi](https://www.chezmoi.io/). The goal is to make setting up a new Mac a single `chezmoi init --apply` command — shell, editor, terminal, tools, and all config ready to go.

## Rules

- **Always keep README.md up to date.** When adding, removing, or changing any managed file, Brewfile entry, install script, nvim plugin, pi package/extension, or Ghostty shader, update the README to reflect the current state — including the relevant plugin/extension/shader tables.
- **Secrets go in `~/.zsh_secrets`**, never in tracked files. The `dot_zshrc` sources this file automatically.
- **`dot_zprofile`** is for login shell setup: environment variables, PATH modifications.
- **`dot_zshrc`** is for interactive shell setup: plugins, prompt init, lazy loaders.
- **Brewfile** is for Homebrew-managed packages only. Tools without a Homebrew formula (like herdr) go in `run_once_install-packages.sh`.
- **Pi changes go in this repo** (`private_dot_pi/`). When asked to install pi packages, add extensions, or change pi settings, update the chezmoi-managed files so all future machines get it — unless explicitly told to do it locally only.
