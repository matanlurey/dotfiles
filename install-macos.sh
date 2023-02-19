# Additional install steps needed for OSX.

# Change hostname.
sudo scutil --set HostName "mac"

# Check if "dockutil" is installed.
if [[ ! -f "/usr/local/bin/dockutil" ]]; then
  DOCKUTIL_VERSION="3.0.2"
  DOCKUTIL_REPOSITORY="https://github.com/kcrawford/dockutil"
  DOCKUTIL_PKG="${DOCKUTIL_REPOSITORY}/releases/download/${DOCKUTIL_VERSION}/dockutil-${DOCKUTIL_VERSION}.pkg"

  wget -O "/tmp/dockutil.pkg" "${DOCKUTIL_PKG}"
  sudo installer -pkg "/tmp/dockutil.pkg" -target "/Applications"
else
  echo "dockutil is already installed, skipping." >&2
fi

# Clear all dock items.
dockutil --remove all --no-restart

# Add dock items.
dockutil --add "/Applications/Google Chrome.app" --no-restart
dockutil --add "/Applications/Discord.app" --no-restart
dockutil --add "/Applications/Visual Studio Code.app" --no-restart
dockutil --add "/Applications/Alacritty.app" --no-restart

# Restart dock.
killall Dock

# Check if "rust" is installed.
rustup-init -q -y

# Install "cargo" extensions:
# - "cargo-edit" for managing dependencies.
cargo install cargo-edit -q
# - "cargo-update" for updating installed crates.
cargo install cargo-update -q
# - "cargo-watch" for watching files and running commands.
cargo install cargo-watch -q
# - "cargo-tree" for displaying a dependency tree.
cargo install cargo-tree -q
# - "cargo-outdated" for checking for outdated dependencies.
cargo install cargo-outdated -q
# - "cargo-expand" for expanding macros.
cargo install cargo-expand -q
# - "cargo-bloat" for analyzing binary size.
cargo install cargo-bloat -q
# - "cargo-generate" for generating projects from templates.
cargo install cargo-generate -q
# - "cargo-release" for releasing crates.
cargo install cargo-release -q
# - "cargo-make" for running tasks.
cargo install cargo-make -q

# Copy .config files.
cp -r .config ~/

# Copy tmux.conf.
cp .tmux.conf ~/

# Make the default shell zsh if it isn't already.
if [[ ! "$SHELL" == "/bin/zsh" ]]; then
  chsh -s /bin/zsh
fi

# Copy .zshrc.
cp .zshrc ~/
cp .fzf.zsh ~/
