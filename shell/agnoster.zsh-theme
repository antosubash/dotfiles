# Agnoster Theme - Clean, modern Zsh theme
# Based on original Agnoster with enhanced features

# Segments to display
CURRENT_BG='NONE'
SEGMENT_SEPARATOR=''
RIGHT_SEPARATOR=''
LEFT_SEGMENT_SEPARATOR=''
RIGHT_SEGMENT_SEPARATOR=''

# Special powerline characters
() {
  local LC_ALL="" LC_CTYPE="en_US.UTF-8"
  SEGMENT_SEPARATOR=$''
  RIGHT_SEPARATOR=$''
}

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

### Prompt components
# Each component will draw itself, and hide itself if no information needs to be shown

# Context: user@hostname (for remote sessions)
prompt_context() {
  if [[ -n $SSH_CONNECTION ]]; then
    prompt_segment black default "%n@%m"
  else
    # Local session - just show user
    prompt_segment black default "%n"
  fi
}

# Git: branch/detached head, dirty status
prompt_git() {
  local color ref
  is_dirty() {
    test -n "$(git status --porcelain --ignore-submodules 2>/dev/null)"
    [[ $? -eq 1 ]] && return 0
    return 1
  }
  
  ref="$vcs_info_msg_0_"
  if [[ -n "$ref" ]]; then
    if is_dirty; then
      color=yellow
      ref="${ref} $✗"
    else
      color=green
      ref="${ref} ✓"
    fi
    if [[ "${ref/.../}" == "$ref" ]]; then
      ref="$BRANCH $ref"
    else
      ref="$DETACHED ${ref/.../}"
    fi
    prompt_segment $color $ref
  fi
}

# Dir: current working directory
prompt_dir() {
  prompt_segment blue '%~'
}

# Virtualenv: current working virtualenv
prompt_virtualenv() {
  local virtualenv_path="$VIRTUAL_ENV"
  if [[ -n $virtualenv_path && -n $VIRTUAL_ENV_DISABLE_PROMPT ]]; then
    prompt_segment magenta "(`basename $virtualenv_path`)"
  fi
}

# Node.js: current node version, project name
prompt_nodejs() {
  if [[ -f package.json ]] || [[ -d node_modules ]]; then
    local node_version=$(node --version 2>/dev/null)
    prompt_segment green "⬢ $node_version"
  fi
}

# Rust: current rust project
prompt_rust() {
  if [[ -f Cargo.toml ]]; then
    local rust_version=$(rustc --version | cut -d' ' -f2 2>/dev/null)
    prompt_segment red "🦀 $rust_version"
  fi
}

# Go: current go module
prompt_go() {
  if [[ -f go.mod ]]; then
    local module_name=$(grep '^module' go.mod | cut -d' ' -f2)
    prompt_segment cyan "🐹 $module_name"
  fi
}

# Kubernetes: current context and namespace
prompt_k8s() {
  if command -v kubectl &> /dev/null; then
    local context=$(kubectl config current-context 2>/dev/null)
    local namespace=$(kubectl config view --minify --output 'jsonpath={..namespace}' 2>/dev/null)
    if [[ -n $context ]]; then
      if [[ $namespace == "default" ]] || [[ -z $namespace ]]; then
        prompt_segment magenta "☸️ $context"
      else
        prompt_segment magenta "☸️ $context/$namespace"
      fi
    fi
  fi
}

# Docker: current context
prompt_docker() {
  if command -v docker &> /dev/null; then
    local context=$(docker context inspect --format '{{.Name}}' 2>/dev/null)
    if [[ -n $context ]] && [[ $context != "default" ]]; then
      prompt_segment blue "🐳 $context"
    fi
  fi
}

# AWS: current profile
prompt_aws() {
  if [[ -n $AWS_PROFILE ]]; then
    prompt_segment yellow "☁️ $AWS_PROFILE"
  fi
}

# Status: 
# - was there an error
# - am I root
# - are there background jobs?
prompt_status() {
  local symbols
  symbols=()
  [[ $RETVAL -ne 0 ]] && symbols+="%{%F{red}%}✘"
  [[ $UID -eq 0 ]] && symbols+="%{%F{yellow}%}⚡"
  [[ $(jobs -l | wc -l) -gt 0 ]] && symbols+="%{%F{cyan}%}⚙"

  [[ -n "$symbols" ]] && prompt_segment black "$symbols"
}

# Command execution time
prompt_time() {
  if [[ $CMD_EXEC_TIME -gt 5 ]]; then
    local human_time
    local hours=$(( CMD_EXEC_TIME / 3600 ))
    local minutes=$(( (CMD_EXEC_TIME % 3600) / 60 ))
    local seconds=$(( CMD_EXEC_TIME % 60 ))
    
    (( hours > 0 )) && human_time+="${hours}h "
    (( minutes > 0 )) && human_time+="${minutes}m "
    human_time+="${seconds}s"
    
    prompt_segment black "⏱ $human_time"
  fi
}

## Main prompt
prompt_agnoster_main() {
  RETVAL=$?
  local status_code=$RETVAL
  
  # Reset command execution time
  CMD_EXEC_TIME=0
  
  # Print status code if non-zero
  if [[ $status_code -ne 0 ]]; then
    prompt_segment red "$status_code"
  fi
  
  prompt_status
  prompt_context
  prompt_dir
  prompt_git
  prompt_nodejs
  prompt_rust
  prompt_go
  prompt_k8s
  prompt_docker
  prompt_aws
  prompt_virtualenv
  prompt_end
}

# Right prompt
prompt_agnoster_right() {
  prompt_time
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
  zstyle ':vcs_info:*' stagedstr '✓'
  zstyle ':vcs_info:*' unstagedstr '✗'
  zstyle ':vcs_info:*' formats '%b'
  zstyle ':vcs_info:*' actionformats '%b'

  PROMPT='%{%f%b%k%}$(prompt_agnoster_main) '
  RPROMPT='%{%f%b%k%}$(prompt_agnoster_right)'
}

# Agnoster prompt setup
prompt_agnoster_setup