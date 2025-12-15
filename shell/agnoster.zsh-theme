# Enhanced Agnoster Theme - Clean, modern Zsh theme
# Based on original Agnoster with essential enhancements

# Segments to display
CURRENT_BG='NONE'
SEGMENT_SEPARATOR=''

# Special powerline characters
() {
  local LC_ALL="" LC_CTYPE="en_US.UTF-8"
  SEGMENT_SEPARATOR=$''
}

# Configuration options
export AGNOSTER_SHOW_USER=${AGNOSTER_SHOW_USER:-false}
export AGNOSTER_SHOW_EXEC_TIME=${AGNOSTER_SHOW_EXEC_TIME:-true}

# Begin a segment
prompt_segment() {
  local bg fg
  [[ -n $1 ]] && bg="%K{$1}" || bg="%k"
  [[ -n $2 ]] && fg="%F{$2}" || fg="%f"
  if [[ $CURRENT_BG != 'NONE' && $1 != $CURRENT_BG ]]; then
    echo -n " %{$bg%F{$CURRENT_BG}%}$SEGMENT_SEPARATOR%{$fg%} "
  else
    echo -n "%{$bg%}%{$fg%} "
  fi
  CURRENT_BG=$1
  [[ -n $3 ]] && echo -n $3
}

# End the prompt, closing any open segments
prompt_end() {
  if [[ -n $CURRENT_BG ]]; then
    echo -n "%{%k%F{$CURRENT_BG}%}$SEGMENT_SEPARATOR"
  else
    echo -n "%{%k%}"
  fi
  echo -n "%{%f%}"
  CURRENT_BG=''
}

### Essential prompt components

# Context: user@hostname (for remote sessions only)
prompt_context() {
  if [[ -n $SSH_CONNECTION ]]; then
    prompt_segment black default "%n@%m"
  elif [[ "$AGNOSTER_SHOW_USER" == "true" ]]; then
    prompt_segment black default "%n"
  fi
}

# Git: branch/detached head, dirty status
prompt_git() {
  local color ref status_symbols
  is_dirty() {
    test -n "$(git status --porcelain --ignore-submodules 2>/dev/null)"
    [[ $? -eq 1 ]] && return 0
    return 1
  }
  
  ref="$vcs_info_msg_0_"
  if [[ -n "$ref" ]]; then
    status_symbols=()
    
    local untracked=$(git ls-files --other --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
    local modified=$(git ls-files --modified 2>/dev/null | wc -l | tr -d ' ')
    local staged=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
    
    [[ $staged -gt 0 ]] && status_symbols+="%F{green}▲%f"
    [[ $modified -gt 0 ]] && status_symbols+="%F{yellow}●%f"
    [[ $untracked -gt 0 ]] && status_symbols+="%F{red}+%f"
    
    if is_dirty || [[ $untracked -gt 0 ]]; then
      color=yellow
    else
      color=green
    fi
    
    local git_symbol="⎇ "
    ref="$git_symbol$ref"
    
    if [[ ${#status_symbols[@]} -gt 0 ]]; then
      ref="$ref ${status_symbols[@]}"
    fi
    
    prompt_segment $color "$ref"
  fi
}

# Directory: current working directory
prompt_dir() {
  prompt_segment blue '%~'
}

# Virtualenv: current virtual environment
prompt_virtualenv() {
  if [[ -n $VIRTUAL_ENV && -z $VIRTUAL_ENV_DISABLE_PROMPT ]]; then
    prompt_segment magenta "🐍 `basename $VIRTUAL_ENV`"
  fi
}

# Status: exit code, root indicator, background jobs
prompt_status() {
  local symbols
  symbols=()
  [[ $RETVAL -ne 0 ]] && symbols+="%F{red}$RETVAL✘"
  [[ $UID -eq 0 ]] && symbols+="%F{yellow}⚡"
  [[ $(jobs -l | wc -l) -gt 0 ]] && symbols+="%F{cyan}⚙"

  [[ -n "$symbols" ]] && prompt_segment black "$symbols"
}

# Command execution time
prompt_exec_time() {
  if [[ "$AGNOSTER_SHOW_EXEC_TIME" != "true" ]]; then
    return
  fi
  
  if [[ $CMD_EXEC_TIME -gt 5 ]]; then
    local human_time
    local hours=$(( CMD_EXEC_TIME / 3600 ))
    local minutes=$(( (CMD_EXEC_TIME % 3600) / 60 ))
    local seconds=$(( CMD_EXEC_TIME % 60 ))
    
    if (( hours > 0 )); then
      human_time="${hours}h${minutes}m${seconds}s"
    elif (( minutes > 0 )); then
      human_time="${minutes}m${seconds}s"
    else
      human_time="${seconds}s"
    fi
    
    prompt_segment black "⏱ $human_time"
  fi
}

## Main prompt
prompt_agnoster_main() {
  RETVAL=$?
  CMD_EXEC_TIME=0
  
  prompt_status
  prompt_context
  prompt_dir
  prompt_git
  prompt_virtualenv
  prompt_end
}

# Right prompt
prompt_agnoster_right() {
  prompt_exec_time
  prompt_end
}

# Setup command execution time tracking
prompt_agnoster_precmd() {
  local stop=$SECONDS
  local start=$cmd_start_time
  (( start )) && CMD_EXEC_TIME=$(( stop - start ))
  cmd_start_time=()
}

prompt_agnoster_preexec() {
  cmd_start_time=$SECONDS
}

# Initialize prompt
prompt_agnoster_setup() {
  autoload -Uz add-zsh-hook
  autoload -Uz vcs_info

  add-zsh-hook precmd prompt_agnoster_precmd
  add-zsh-hook preexec prompt_agnoster_preexec

  zstyle ':vcs_info:*' enable git
  zstyle ':vcs_info:*' check-for-changes false
  zstyle ':vcs_info:*' formats '%b'
  zstyle ':vcs_info:*' actionformats '%b'

  PROMPT='%{%f%b%k%}$(prompt_agnoster_main) '
  RPROMPT='%{%f%b%k%}$(prompt_agnoster_right)'
}

# Agnoster prompt setup
prompt_agnoster_setup