#!/usr/bin/env zsh
# Zsh options configuration
# Performance: Set options first for faster loading

# Navigation
setopt AUTO_CD              # cd by typing directory name
setopt AUTO_PUSHD           # Make cd push the old directory onto the directory stack
setopt PUSHD_IGNORE_DUPS    # Don't push multiple copies of the same directory
setopt PUSHD_SILENT         # Don't print the directory stack after pushd or popd

# History
setopt HIST_VERIFY          # Show command before running history substitution
setopt INC_APPEND_HISTORY   # Immediately append to history file
setopt HIST_IGNORE_ALL_DUPS # Remove older duplicate entries from history
setopt HIST_REDUCE_BLANKS   # Remove superfluous blanks from history file
setopt HIST_SAVE_NO_DUPS    # Don't save duplicate entries
setopt SHARE_HISTORY        # Share history between all sessions
setopt HIST_IGNORE_SPACE    # Don't save commands that start with space
setopt HIST_FIND_NO_DUPS    # Don't display duplicates when searching history

# Completion
setopt COMPLETE_IN_WORD     # Complete from both sides of cursor
setopt ALWAYS_TO_END        # Move cursor to end if word had one match
setopt PATH_DIRS            # Perform path search even on command names with slashes
setopt AUTO_MENU            # Show completion menu on successive tab press
setopt AUTO_LIST            # Automatically list choices on ambiguous completion
setopt AUTO_PARAM_SLASH     # If completed parameter is a directory, add trailing slash
setopt COMPLETE_ALIASES     # Complete aliases

# Correction
setopt CORRECT              # Auto correct mistakes
setopt CORRECT_ALL          # Auto correct all arguments

# Other
setopt INTERACTIVE_COMMENTS # Allow comments in interactive commands
setopt EXTENDED_GLOB        # Extended globbing
setopt NO_BEEP              # Disable beep
setopt NOTIFY               # Report status of background jobs immediately

