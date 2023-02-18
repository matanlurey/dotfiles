# dotfiles

## MacOS

Install XCode:

```bash
sudo xcodebuild -license
xcode-select --install

Install [Homebrew](https://brew.sh/) and `Brewfile` support:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew tap Homebrew/bundle
# Make sure to add `brew` to your PATH.
```

Then install the [Brewfile](./Brewfile):

```bash
brew bundle Brewfile

# Additional scripts needed to install some packages.
./install-macos.sh
```

## Ideas

<https://github.com/myTerminal/dotfiles/blob/master/README.org>
