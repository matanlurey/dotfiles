#!/bin/bash
# Install packages via Homebrew Bundle
set -euo pipefail

if ! command -v brew &>/dev/null; then
    echo "Homebrew not found, skipping package install"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
brew bundle --file="${CHEZMOI_SOURCE_DIR:-$SCRIPT_DIR}/Brewfile"

# Build bat theme cache
if command -v bat &>/dev/null; then
    echo "Building bat theme cache..."
    bat cache --build
fi


# Install mlux (Typst-powered terminal markdown viewer)
if ! command -v mlux &>/dev/null; then
    echo "Installing mlux..."
    MLUX_VERSION="2.4.0"
    curl -sL "https://github.com/saka1/mlux/releases/download/v${MLUX_VERSION}/mlux-v${MLUX_VERSION}-aarch64-apple-darwin.tar.gz" -o /tmp/mlux.tar.gz
    tar xzf /tmp/mlux.tar.gz -C /tmp
    cp "/tmp/mlux-v${MLUX_VERSION}-aarch64-apple-darwin/mlux" /opt/homebrew/bin/mlux
    rm -rf /tmp/mlux.tar.gz "/tmp/mlux-v${MLUX_VERSION}-aarch64-apple-darwin"
    echo "Installed mlux $(mlux --version)"
fi

# Install Node.js via fnm and pi coding agent
if command -v fnm &>/dev/null; then
    eval "$(fnm env)"
    if ! fnm list | grep -q lts; then
        echo "Installing Node.js LTS via fnm..."
        fnm install --lts
        fnm default lts-latest
    fi
    echo "Installing pi and packages..."
    npm install -g @earendil-works/pi-coding-agent @burneikis/pi-fzfp @makeplane/plane-mcp-server @noahsaso/pi-remote

    # Wrapper script for pi in ~/.local/bin so it's available in non-login shells
    # Uses a wrapper instead of a symlink so pi can resolve its own install location for self-update
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/pi" <<'WRAPPER'
#!/bin/bash
# Route to the fnm-managed pi so self-update works.
# Resolves the real cli.js path so pi can detect its own install location for self-update.
eval "$(fnm env)" 2>/dev/null
FNM_NODE_DIR="$(dirname "$(which node)")/.."
PI_CLI="$FNM_NODE_DIR/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
if [ -f "$PI_CLI" ]; then
    exec node "$PI_CLI" "$@"
else
    echo "Error: pi not found at $PI_CLI" >&2
    exit 1
fi
WRAPPER
    chmod +x "$HOME/.local/bin/pi"
else
    echo "fnm not found — run 'brew bundle' first"
fi
