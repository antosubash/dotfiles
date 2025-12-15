#!/bin/bash

# Terminal Setup Script for macOS
# Configures Terminal.app with custom theme and settings

THEME_NAME="Dev Theme"
BACKGROUND_COLOR="#2E3440"
TEXT_COLOR="#E5E9F0"
BOLD_TEXT_COLOR="#ECEFF4"
CURSOR_COLOR="#88C0D0"

# ANSI Colors
BLACK="#2E3440"
RED="#BF616A"
GREEN="#A3BE8C"
YELLOW="#EBCB8B"
BLUE="#5E81AC"
MAGENTA="#B48EAD"
CYAN="#88C0D0"
WHITE="#E5E9F0"

# Bright Colors
BRIGHT_BLACK="#4C566A"
BRIGHT_RED="#D08770"
BRIGHT_GREEN="#8FBCBB"
BRIGHT_YELLOW="#EBCB8B"
BRIGHT_BLUE="#81A1C1"
BRIGHT_MAGENTA="#B48EAD"
BRIGHT_CYAN="#8FBCBB"
BRIGHT_WHITE="#ECEFF4"

# Create plist for Terminal theme
create_terminal_theme() {
    local theme_plist="$HOME/Library/Preferences/com.apple.Terminal.plist"
    local theme_dir="$HOME/Library/Application Support/com.apple.terminal"
    
    # Ensure theme directory exists
    mkdir -p "$theme_dir"
    
    # Create the theme using AppleScript
    osascript <<EOF
tell application "Terminal"
    -- Create new theme
    set newSettings to current settings of default settings
    
    -- Set colors
    set background color of newSettings to {$BACKGROUND_COLOR}
    set normal text color of newSettings to {$TEXT_COLOR}
    set bold text color of newSettings to {$BOLD_TEXT_COLOR}
    set cursor color of newSettings to {$CURSOR_COLOR}
    
    -- ANSI colors
    set ANSI black color of newSettings to {$BLACK}
    set ANSI red color of newSettings to {$RED}
    set ANSI green color of newSettings to {$GREEN}
    set ANSI yellow color of newSettings to {$YELLOW}
    set ANSI blue color of newSettings to {$BLUE}
    set ANSI magenta color of newSettings to {$MAGENTA}
    set ANSI cyan color of newSettings to {$CYAN}
    set ANSI white color of newSettings to {$WHITE}
    
    set ANSI bright black color of newSettings to {$BRIGHT_BLACK}
    set ANSI bright red color of newSettings to {$BRIGHT_RED}
    set ANSI bright green color of newSettings to {$BRIGHT_GREEN}
    set ANSI bright yellow color of newSettings to {$BRIGHT_YELLOW}
    set ANSI bright blue color of newSettings to {$BRIGHT_BLUE}
    set ANSI bright magenta color of newSettings to {$BRIGHT_MAGENTA}
    set ANSI bright cyan color of newSettings to {$BRIGHT_CYAN}
    set ANSI bright white color of newSettings to {$BRIGHT_WHITE}
    
    -- Save theme
    set name of newSettings to "$THEME_NAME"
end tell
EOF

    echo "✓ Terminal theme '$THEME_NAME' created"
}

# Configure Terminal settings
configure_terminal() {
    # Set default window size
    defaults write com.apple.Terminal "Default Window Settings" -string "$THEME_NAME"
    defaults write com.apple.Terminal "Startup Window Settings" -string "$THEME_NAME"
    
    # Enable keyboard shortcuts
    defaults write com.apple.Terminal FocusFollowsMouse -bool true
    
    # Set window title to show full path
    defaults write com.apple.Terminal ShowWindowTitle -bool true
    
    # Enable visual bell
    defaults write com.apple.Terminal Bell -bool false
    defaults write com.apple.Terminal VisualBell -bool true
    
    echo "✓ Terminal settings configured"
}

# Install and configure iTerm2 if available
configure_iterm() {
    if [[ -d "/Applications/iTerm.app" ]]; then
        # iTerm2 color scheme
        local iterm_colors_dir="$HOME/Library/Application Support/iTerm2/DynamicProfiles"
        mkdir -p "$iterm_colors_dir"
        
        cat > "$iterm_colors_dir/DevTheme.json" <<EOF
{
  "Profiles": [
    {
      "Name": "Dev Theme",
      "Guid": "dev-theme-guid",
      "Background Color": {
        "Red Component": 0.18039,
        "Green Component": 0.20392,
        "Blue Component": 0.25098,
        "Alpha Component": 1
      },
      "Foreground Color": {
        "Red Component": 0.89804,
        "Green Component": 0.91373,
        "Blue Component": 0.94118,
        "Alpha Component": 1
      },
      "Cursor Color": {
        "Red Component": 0.53333,
        "Green Component": 0.75294,
        "Blue Component": 0.81569,
        "Alpha Component": 1
      },
      "Bold Color": {
        "Red Component": 0.92549,
        "Green Component": 0.93725,
        "Blue Component": 0.95686,
        "Alpha Component": 1
      },
      "Ansi 0 Color": {"Red Component": 0.18039, "Green Component": 0.20392, "Blue Component": 0.25098, "Alpha Component": 1},
      "Ansi 1 Color": {"Red Component": 0.74902, "Green Component": 0.38039, "Blue Component": 0.41569, "Alpha Component": 1},
      "Ansi 2 Color": {"Red Component": 0.64314, "Green Component": 0.74510, "Blue Component": 0.54902, "Alpha Component": 1},
      "Ansi 3 Color": {"Red Component": 0.92157, "Green Component": 0.79608, "Blue Component": 0.54510, "Alpha Component": 1},
      "Ansi 4 Color": {"Red Component": 0.36863, "Green Component": 0.50588, "Blue Component": 0.67451, "Alpha Component": 1},
      "Ansi 5 Color": {"Red Component": 0.70588, "Green Component": 0.55686, "Blue Component": 0.67843, "Alpha Component": 1},
      "Ansi 6 Color": {"Red Component": 0.53333, "Green Component": 0.75294, "Blue Component": 0.81569, "Alpha Component": 1},
      "Ansi 7 Color": {"Red Component": 0.89804, "Green Component": 0.91373, "Blue Component": 0.94118, "Alpha Component": 1},
      "Ansi 8 Color": {"Red Component": 0.29804, "Green Component": 0.40000, "Blue Component": 0.41569, "Alpha Component": 1},
      "Ansi 9 Color": {"Red Component": 0.81569, "Green Component": 0.52941, "Blue Component": 0.43922, "Alpha Component": 1},
      "Ansi 10 Color": {"Red Component": 0.56078, "Green Component": 0.73725, "Blue Component": 0.73333, "Alpha Component": 1},
      "Ansi 11 Color": {"Red Component": 0.92157, "Green Component": 0.79608, "Blue Component": 0.54510, "Alpha Component": 1},
      "Ansi 12 Color": {"Red Component": 0.50588, "Green Component": 0.63137, "Blue Component": 0.75686, "Alpha Component": 1},
      "Ansi 13 Color": {"Red Component": 0.70588, "Green Component": 0.55686, "Blue Component": 0.67843, "Alpha Component": 1},
      "Ansi 14 Color": {"Red Component": 0.56078, "Green Component": 0.73725, "Blue Component": 0.73333, "Alpha Component": 1},
      "Ansi 15 Color": {"Red Component": 0.92549, "Green Component": 0.93725, "Blue Component": 0.95686, "Alpha Component": 1}
    }
  ]
}
EOF
        
        echo "✓ iTerm2 color scheme created"
    fi
}

# Setup starship.rs if available
setup_starship() {
    if command -v starship &> /dev/null; then
        cat > "$HOME/.config/starship.toml" <<'EOF'
add_newline = false

[format]
format = """
$username\
$hostname\
$directory\
$git_branch\
$git_status\
$nodejs\
$python\
$rust\
$golang\
$docker_context\
$kubernetes\
$aws\
$fill\
$cmd_duration\
$time"""

[line_break]
disable = true

[character]
success_symbol = "[❯](bold green)"
error_symbol = "[❯](bold red)"

[username]
show_always = true
style_user = "green"
style_root = "red"

[hostname]
ssh_only = false
style = "dimmed green"

[directory]
truncation_length = 3
style = "blue"

[git_branch]
style = "cyan"
symbol = "⎇ "

[git_status]
style = "yellow"
modified = "●"
staged = "▲"
untracked = "+"

[nodejs]
style = "green"
symbol = "⬢ "

[python]
style = "yellow"
symbol = "🐍 "

[rust]
style = "red"
symbol = "🦀 "

[golang]
style = "cyan"
symbol = "🐹 "

[docker_context]
style = "blue"
symbol = "🐳 "

[kubernetes]
style = "magenta"
symbol = "☸️ "
disabled = false

[aws]
style = "yellow"
symbol = "☁️ "

[cmd_duration]
min_time = 5000
style = "yellow"
symbol = "⏱️ "

[time]
style = "dimmed white"
format = "[$time]($style)"
EOF
        
        echo "✓ Starship configuration created"
    fi
}

echo "🎨 Setting up terminal themes and configurations..."

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script is designed for macOS"
    exit 1
fi

# Install theme
create_terminal_theme
configure_terminal
configure_iterm
setup_starship

echo ""
echo "✨ Terminal setup complete!"
echo "📋 Next steps:"
echo "   1. Restart Terminal.app"
echo "   2. Set 'Dev Theme' as default profile"
echo "   3. Update your ~/.zshrc to use the custom theme:"
echo "      ZSH_THEME='dev-theme'"
echo "   4. Enjoy your beautiful new terminal! 🚀"