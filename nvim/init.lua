-- Neovim configuration file

-- Basic settings
vim.opt.number = true              -- Show line numbers
vim.opt.relativenumber = true      -- Show relative line numbers
vim.opt.tabstop = 4                -- Number of spaces tabs count for
vim.opt.shiftwidth = 4             -- Number of spaces to use for autoindent
vim.opt.expandtab = true           -- Use spaces instead of tabs
vim.opt.smartindent = true         -- Smart autoindenting
vim.opt.autoindent = true          -- Autoindent new lines
vim.opt.wrap = true                -- Wrap long lines
vim.opt.showcmd = true             -- Show command in bottom bar
vim.opt.wildmenu = true            -- Visual autocomplete for command menu
vim.opt.hlsearch = true            -- Highlight search results
vim.opt.incsearch = true           -- Search as characters are entered
vim.opt.ignorecase = true          -- Ignore case when searching
vim.opt.smartcase = true           -- Override ignorecase if uppercase letters present
vim.opt.scrolloff = 8              -- Number of lines to keep above/below cursor
vim.opt.sidescrolloff = 8          -- Number of columns to keep left/right of cursor
vim.opt.mouse = "a"                -- Enable mouse usage
vim.opt.clipboard = "unnamedplus"  -- Use system clipboard

-- Appearance
vim.cmd("syntax on")               -- Enable syntax highlighting
vim.opt.background = "dark"        -- Dark background
vim.opt.cursorline = true          -- Highlight current line
vim.opt.colorcolumn = "80"         -- Highlight column 80

-- File handling
vim.opt.encoding = "utf8"           -- Use UTF-8 encoding
vim.opt.fileencoding = "utf8"      -- Use UTF-8 for files
vim.opt.backup = false             -- Don't create backup files
vim.opt.writebackup = false        -- Don't create backup files
vim.opt.swapfile = false           -- Don't use swap files

-- Netrw settings
vim.g.netrw_banner = 0             -- Disable banner
vim.g.netrw_liststyle = 3          -- Tree view
vim.g.netrw_winsize = 30           -- 30% of window width

-- Custom mappings
vim.g.mapleader = ","              -- Set leader key

-- Navigation
vim.keymap.set("n", "<C-h>", "<C-w>h", { noremap = true })
vim.keymap.set("n", "<C-j>", "<C-w>j", { noremap = true })
vim.keymap.set("n", "<C-k>", "<C-w>k", { noremap = true })
vim.keymap.set("n", "<C-l>", "<C-w>l", { noremap = true })

-- Search
vim.keymap.set("n", "<leader>h", ":nohlsearch<CR>", { noremap = true })

-- Save and quit
vim.keymap.set("n", "<leader>w", ":w<CR>", { noremap = true })
vim.keymap.set("n", "<leader>q", ":q<CR>", { noremap = true })

-- Split navigation
vim.keymap.set("n", "<leader>s", ":split<CR>", { noremap = true })
vim.keymap.set("n", "<leader>v", ":vsplit<CR>", { noremap = true })

