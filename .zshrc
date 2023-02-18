# EXPORTS
################################################################################
export TERM="xterm-256color" # getting proper colors
export HISTORY_IGNORE="(ls|cd|pwd|exit|sudo reboot|history|cd -|cd ..)"
export EDITOR="neovim"  # $EDITOR use Neovim
export VISUAL="code -w" # $VISUAL use Visual Studio Code

# PATH
################################################################################
# Add Homebrew's bin to PATH.
export PATH="/opt/homebrew/bin:$PATH"

# ALIASES
################################################################################
# Use nvim instead of vim.
alias vim="nvim"

# Use 'bat' instead of 'cat'.
alias cat="bat"
export MANPAGER="sh -c 'col -bx | bat -l man -p'"

# Changing "ls" to "exa"
alias ls='exa -al --color=always --group-directories-first' # my preferred listing
alias la='exa -a --color=always --group-directories-first'  # all files and dirs
alias ll='exa -l --color=always --group-directories-first'  # long format
alias lt='exa -aT --color=always --group-directories-first' # tree listing
alias l.='exa -a | egrep "^\."'

# Use VI mode in ZSH.
bindkey -v

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

# Make the prompt pretty/shorter.
PROMPT="%F{33}%n %F{38}%~ %#%f "

# No duplicate entries in the history.
HISTSIZE=5000
HISTFILE=~/.zsh_history
SAVEHIST=5000
HISTDUP=erase
setopt appendhistory
setopt sharehistory
setopt incappendhistory
setopt hist_ignore_all_dups
setopt hist_save_no_dups
setopt hist_ignore_dups
setopt hist_find_no_dups

# Case insensitive completion.
autoload -U compinit && compinit
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
