# Terminal Color Schemes

## Catppuccin Mocha (Dark Theme)
A modern, warm dark theme with excellent readability and syntax highlighting.
Popular among developers with carefully balanced colors.

### macOS Terminal / iTerm2
Copy these values to Terminal > Preferences > Profiles > Colors

**Basic Colors:**
- Background: `#1E1E2E` (Base)
- Foreground: `#CDD6F4` (Text)
- Bold Text: `#CDD6F4`
- Cursor: `#F5E0DC` (Rosewater)
- Cursor Text: `#1E1E2E`
- Selection: `#585B70` (Surface2)
- Selection Text: `#CDD6F4`

**ANSI Colors:**
- Black: `#45475A` (Surface1)
- Red: `#F38BA8` (Red)
- Green: `#A6E3A1` (Green)
- Yellow: `#F9E2AF` (Yellow)
- Blue: `#89B4FA` (Blue)
- Magenta: `#F5C2E7` (Pink)
- Cyan: `#94E2D5` (Teal)
- White: `#BAC2DE` (Subtext1)

**Bright ANSI Colors:**
- Bright Black: `#585B70` (Surface2)
- Bright Red: `#F38BA8` (Red)
- Bright Green: `#A6E3A1` (Green)
- Bright Yellow: `#F9E2AF` (Yellow)
- Bright Blue: `#89B4FA` (Blue)
- Bright Magenta: `#F5C2E7` (Pink)
- Bright Cyan: `#94E2D5` (Teal)
- Bright White: `#A6ADC8` (Subtext0)

### For iTerm2 Users
You can also import the official Catppuccin theme:
1. Visit: https://github.com/catppuccin/iterm
2. Download the Mocha variant
3. Import via iTerm2 > Preferences > Profiles > Colors > Color Presets > Import

### For Alacritty Users
Add to `~/.config/alacritty/alacritty.yml`:
```yaml
colors:
  primary:
    background: '#1E1E2E'
    foreground: '#CDD6F4'
  cursor:
    text: '#1E1E2E'
    cursor: '#F5E0DC'
  normal:
    black: '#45475A'
    red: '#F38BA8'
    green: '#A6E3A1'
    yellow: '#F9E2AF'
    blue: '#89B4FA'
    magenta: '#F5C2E7'
    cyan: '#94E2D5'
    white: '#BAC2DE'
  bright:
    black: '#585B70'
    red: '#F38BA8'
    green: '#A6E3A1'
    yellow: '#F9E2AF'
    blue: '#89B4FA'
    magenta: '#F5C2E7'
    cyan: '#94E2D5'
    white: '#A6ADC8'
```

### Additional Resources
- Official Catppuccin website: https://catppuccin.com
- Full color palette reference: https://github.com/catppuccin/catppuccin