# Powerlevel10k Simple Configuration - Rainbow Style
# Simplified config using P10k presets with minimal customization
# To reconfigure interactively: run `p10k configure`

# Enable instant prompt for faster startup
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# ============================================================================
# STYLE PRESET: Rainbow (each segment gets a different color)
# ============================================================================

typeset -g POWERLEVEL9K_MODE=nerdfont-complete

# Prompt layout: Single line
typeset -g POWERLEVEL9K_PROMPT_ADD_NEWLINE=true
typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(
  os_icon       # OS icon
  context       # user@host
  dir           # Current directory
  vcs           # Git status
  prompt_char   # Prompt symbol (changes color on error)
)

typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(
  status                    # Exit code
  command_execution_time    # Duration of last command
  background_jobs           # Background jobs indicator
  virtualenv                # Python virtualenv
  nvm                       # Node version (nvm)
  pyenv                     # Python version (pyenv)
  time                      # Current time
)

# ============================================================================
# SEGMENT COLORS (Rainbow Style)
# ============================================================================

# OS Icon: Bold white (no background)
typeset -g POWERLEVEL9K_OS_ICON_FOREGROUND=white
typeset -g POWERLEVEL9K_OS_ICON_BACKGROUND=''

# Context (user@host): Yellow (no background)
typeset -g POWERLEVEL9K_CONTEXT_FOREGROUND=yellow
typeset -g POWERLEVEL9K_CONTEXT_BACKGROUND=''
typeset -g POWERLEVEL9K_CONTEXT_ROOT_FOREGROUND=red
typeset -g POWERLEVEL9K_CONTEXT_ROOT_BACKGROUND=''
typeset -g POWERLEVEL9K_CONTEXT_TEMPLATE='%n@%m'  # user@hostname

# Directory: Blue (no background)
typeset -g POWERLEVEL9K_DIR_FOREGROUND=blue
typeset -g POWERLEVEL9K_DIR_BACKGROUND=''

# Git: Green (clean), Yellow (modified), Magenta (untracked) - no backgrounds
typeset -g POWERLEVEL9K_VCS_CLEAN_FOREGROUND=green
typeset -g POWERLEVEL9K_VCS_CLEAN_BACKGROUND=''
typeset -g POWERLEVEL9K_VCS_MODIFIED_FOREGROUND=yellow
typeset -g POWERLEVEL9K_VCS_MODIFIED_BACKGROUND=''
typeset -g POWERLEVEL9K_VCS_UNTRACKED_FOREGROUND=magenta
typeset -g POWERLEVEL9K_VCS_UNTRACKED_BACKGROUND=''

# Prompt char: Cyan (ok), Red (error) - no background
typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_{VIINS,VICMD,VIVIS}_FOREGROUND=cyan
typeset -g POWERLEVEL9K_PROMPT_CHAR_ERROR_{VIINS,VICMD,VIVIS}_FOREGROUND=red
typeset -g POWERLEVEL9K_PROMPT_CHAR_{OK,ERROR}_VIINS_CONTENT_EXPANSION='❯'
typeset -g POWERLEVEL9K_PROMPT_CHAR_BACKGROUND=''

# Command execution time: Yellow (no background)
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_FOREGROUND=yellow
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_BACKGROUND=''
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_THRESHOLD=3

# Background jobs: Magenta (no background)
typeset -g POWERLEVEL9K_BACKGROUND_JOBS_FOREGROUND=magenta
typeset -g POWERLEVEL9K_BACKGROUND_JOBS_BACKGROUND=''

# Python virtualenv: Yellow (no background)
typeset -g POWERLEVEL9K_VIRTUALENV_FOREGROUND=yellow
typeset -g POWERLEVEL9K_VIRTUALENV_BACKGROUND=''

# Python pyenv: Yellow (no background)
typeset -g POWERLEVEL9K_PYENV_FOREGROUND=yellow
typeset -g POWERLEVEL9K_PYENV_BACKGROUND=''

# Node (nvm): Green (no background)
typeset -g POWERLEVEL9K_NVM_FOREGROUND=green
typeset -g POWERLEVEL9K_NVM_BACKGROUND=''

# Time: Blue (no background)
typeset -g POWERLEVEL9K_TIME_FOREGROUND=blue
typeset -g POWERLEVEL9K_TIME_BACKGROUND=''

# Status (error code): Red (no background)
typeset -g POWERLEVEL9K_STATUS_ERROR_FOREGROUND=red
typeset -g POWERLEVEL9K_STATUS_ERROR_BACKGROUND=''
typeset -g POWERLEVEL9K_STATUS_OK=false  # Hide status when ok

# ============================================================================
# ADDITIONAL SETTINGS
# ============================================================================

# Shorten directory paths intelligently
typeset -g POWERLEVEL9K_SHORTEN_STRATEGY=truncate_to_unique

# Show execution time format
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_FORMAT='%ds'

# Time format
typeset -g POWERLEVEL9K_TIME_FORMAT='%D{%H:%M:%S}'

# Remove text prefixes for cleaner look
typeset -g POWERLEVEL9K_DIR_PREFIX=''
typeset -g POWERLEVEL9K_VCS_PREFIX=''
typeset -g POWERLEVEL9K_TIME_PREFIX=''

# Segment separators (comfortable spacing for rainbow style)
typeset -g POWERLEVEL9K_LEFT_SEGMENT_SEPARATOR='  '
typeset -g POWERLEVEL9K_RIGHT_SEGMENT_SEPARATOR='  '
typeset -g POWERLEVEL9K_LEFT_SUBSEGMENT_SEPARATOR=' '
typeset -g POWERLEVEL9K_RIGHT_SUBSEGMENT_SEPARATOR=' '

# Visual spacing
typeset -g POWERLEVEL9K_VISUAL_IDENTIFIER_EXPANSION=''
typeset -g POWERLEVEL9K_ICON_PADDING=none

# Transient prompt: off (you can set to 'always' for minimal prompt after execution)
typeset -g POWERLEVEL9K_TRANSIENT_PROMPT=off

# Apply configuration
(( ! $+functions[p10k] )) || p10k reload

