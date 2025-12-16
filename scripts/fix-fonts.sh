#!/bin/bash

# Script to fix font installation by moving fonts from subdirectory to main directory
set -e

FONT_DIR="$HOME/.local/share/fonts"
NERDFONTS_SUBDIR="$FONT_DIR/NerdFonts"

echo "Fixing font installation..."

if [ -d "$NERDFONTS_SUBDIR" ]; then
    echo "Found fonts in subdirectory. Moving to main fonts directory..."
    mkdir -p "$FONT_DIR"
    
    # Move all font files from subdirectory to main directory
    # Use -exec to handle filenames with spaces correctly
    export FONT_DIR
    find "$NERDFONTS_SUBDIR" -type f \( -name "*.ttf" -o -name "*.otf" \) -exec sh -c '
        for font; do
            filename=$(basename "$font")
            dest_file="$FONT_DIR/$filename"
            if [ ! -f "$dest_file" ]; then
                echo "Moving $filename..."
                mv "$font" "$dest_file"
            else
                echo "Skipping $filename (already exists in main directory)"
                rm -f "$font"
            fi
        done
    ' sh {} +
    
    # Remove empty subdirectory
    if [ -d "$NERDFONTS_SUBDIR" ]; then
        rmdir "$NERDFONTS_SUBDIR" 2>/dev/null && echo "Removed empty subdirectory." || echo "Subdirectory not empty, keeping it."
    fi
    
    # Refresh font cache
    if command -v fc-cache &> /dev/null; then
        echo "Refreshing font cache..."
        fc-cache -fv
        echo "Font cache refreshed."
    fi
    
    echo "Font installation fixed!"
else
    echo "No fonts found in subdirectory. Fonts should be in: $FONT_DIR"
    echo "Checking current font installation..."
    if [ -d "$FONT_DIR" ]; then
        font_count=$(find "$FONT_DIR" -type f \( -name "*.ttf" -o -name "*.otf" \) | wc -l)
        echo "Found $font_count font files in $FONT_DIR"
    else
        echo "Font directory does not exist."
    fi
fi

