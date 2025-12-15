# Custom Zsh Theme - Enhanced Dev Theme
# Based on robbyrussell with modern enhancements

# Color palette for consistency
typeset -gA COLORS=(
  RED '%F{red}'
  GREEN '%F{green}'
  YELLOW '%F{yellow}'
  BLUE '%F{blue}'
  MAGENTA '%F{magenta}'
  CYAN '%F{cyan}'
  WHITE '%F{white}'
  BOLD_RED '%F{196}'
  BOLD_GREEN '%F{46}'
  BOLD_YELLOW '%F{226}'
  BOLD_BLUE '%F{33}'
  BOLD_MAGENTA '%F{201}'
  BOLD_CYAN '%F{51}'
  RESET '%f'
)

# Git status function
git_prompt_info() {
  local ref
  ref=$(command git symbolic-ref HEAD 2> /dev/null) || \
  ref=$(command git rev-parse --short HEAD 2> /dev/null) || return 0

  local git_status=''
  local untracked=$(git ls-files --other --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
  local modified=$(git ls-files --modified 2>/dev/null | wc -l | tr -d ' ')
  local staged=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')

  # Status indicators
  if [[ $modified -gt 0 ]]; then
    git_status+="${COLORS[YELLOW]}●${COLORS[RESET]}"
  fi
  if [[ $staged -gt 0 ]]; then
    git_status+="${COLORS[GREEN]}▲${COLORS[RESET]}"
  fi
  if [[ $untracked -gt 0 ]]; then
    git_status+="${COLORS[RED]}+${COLORS[RESET]}"
  fi

  echo " ${COLORS[CYAN}${ref#refs/heads/}${COLORS[RESET]}${git_status}"
}

# Node.js version display
node_version() {
  if command -v node &> /dev/null; then
    local version=$(node --version 2>/dev/null)
    echo " ${COLORS[GREEN}⬢ ${version}${COLORS[RESET]}"
  fi
}

# Python virtual environment display
python_env() {
  if [[ -n $VIRTUAL_ENV ]]; then
    local env_name=$(basename $VIRTUAL_ENV)
    echo " ${COLORS[YELLOW}🐍 ${env_name}${COLORS[RESET]}"
  fi
}

# Rust toolchain display
rust_toolchain() {
  if command -v rustc &> /dev/null && [[ -f $PWD/Cargo.toml ]]; then
    local version=$(rustc --version 2>/dev/null | cut -d' ' -f2)
    echo " ${COLORS[RED}🦀 ${version}${COLORS[RESET]}"
  fi
}

# Go module display
go_module() {
  if [[ -f $PWD/go.mod ]]; then
    local module=$(grep '^module' go.mod | cut -d' ' -f2)
    echo " ${COLORS[CYAN}🐹 ${module}${COLORS[RESET]}"
  fi
}

# Docker context display
docker_context() {
  if command -v docker &> /dev/null; then
    local context=$(docker context inspect --format '{{.Name}}' 2>/dev/null)
    if [[ -n $context ]]; then
      echo " ${COLORS[BLUE]🐳 ${context}${COLORS[RESET]}"
    fi
  fi
}

# Kubernetes context display
k8s_context() {
  if command -v kubectl &> /dev/null; then
    local context=$(kubectl config current-context 2>/dev/null)
    local namespace=$(kubectl config view --minify --output 'jsonpath={..namespace}' 2>/dev/null)
    if [[ -n $context ]]; then
      if [[ $namespace == "default" ]]; then
        echo " ${COLORS[MAGENTA}☸️ ${context}${COLORS[RESET]}"
      else
        echo " ${COLORS[MAGENTA]☸️ ${context}:${namespace}${COLORS[RESET]}"
      fi
    fi
  fi
}

# Execution time display
cmd_exec_time() {
  local stop=$SECONDS
  local start=$cmd_start_time
  [[ $cmd_start_time ]] || return
  local elapsed=$((stop - start))
  local human elapsed duration
  
  if (( elapsed <= 5 )); then
    return
  elif (( elapsed < 60 )); then
    human="${elapsed}s"
  elif (( elapsed < 3600 )); then
    human="$(( elapsed / 60 ))m$(( elapsed % 60 ))s"
  else
    human="$(( elapsed / 3600 ))h$(( (elapsed % 3600) / 60 ))m"
  fi
  
  echo " ${COLORS[YELLOW]⏱️ ${human}${COLORS[RESET]}"
}

# Host and directory display
host_dir_info() {
  local host_color="${COLORS[GREEN]}"
  if [[ -n $SSH_CONNECTION ]]; then
    host_color="${COLORS[RED]}"
  fi
  
  local dir='%~'
  local prompt_symbol="${COLORS[BOLD_GREEN}❯${COLORS[RESET]}"
  
  # Change prompt color based on last command exit code
  if [[ $RETVAL -ne 0 ]]; then
    prompt_symbol="${COLORS[BOLD_RED}❯${COLORS[RESET]}"
  fi
  
  echo "${host_color}%n@%m${COLORS[RESET]} ${COLORS[BLUE]}${dir}${COLORS[RESET]}"
}

# AWS profile display
aws_profile() {
  if [[ -n $AWS_PROFILE ]]; then
    echo " ${COLORS[YELLOW]☁️ ${AWS_PROFILE}${COLORS[RESET]}"
  fi
}

# Main prompt function
prompt_dev_theme_setup() {
  # Store execution time
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec cmd_start_time=$SECONDS
  add-zsh-hook precmd RETVAL=$? cmd_exec_time

  # Build the prompt
  PROMPT=''
  
  # First line: host, directory, and git info
  PROMPT+='$(host_dir_info)'
  PROMPT+='$(git_prompt_info)'
  PROMPT+=$'\n'
  
  # Second line: dev environments and prompt
  PROMPT+='$(node_version)$(python_env)$(rust_toolchain)$(go_module)$(docker_context)$(k8s_context)$(aws_profile)'
  PROMPT+=$'\n'
  PROMPT+='${COLORS[BOLD_GREEN}❯${COLORS[RESET]} '

  # Right prompt: execution time and time
  RPROMPT=''
  RPROMPT+='$(cmd_exec_time)'
  RPROMPT+='%F{8}%D{%H:%M:%S}%f'
}

# Set the theme
prompt_dev_theme_setup