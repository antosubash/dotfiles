-- Core editor options.

local opt = vim.opt

-- Line numbers & cursor
opt.number = true
opt.relativenumber = true
opt.cursorline = true
opt.scrolloff = 8
opt.sidescrolloff = 8
opt.signcolumn = "yes"

-- Indentation (4 spaces)
opt.tabstop = 4
opt.shiftwidth = 4
opt.expandtab = true
opt.smartindent = true
opt.autoindent = true

-- Wrapping
opt.wrap = true
opt.breakindent = true

-- Search
opt.hlsearch = true
opt.incsearch = true
opt.ignorecase = true
opt.smartcase = true

-- UI
opt.termguicolors = true
opt.background = "dark"
opt.showcmd = true
opt.wildmenu = true
opt.colorcolumn = "80"
opt.splitright = true
opt.splitbelow = true
opt.completeopt = { "menu", "menuone", "noselect" }

-- Mouse & clipboard
opt.mouse = "a"
opt.clipboard = "unnamedplus"

-- File handling
opt.encoding = "utf8"
opt.fileencoding = "utf8"
opt.backup = false
opt.writebackup = false
opt.swapfile = false
opt.undofile = true                  -- persistent undo
opt.undodir = vim.fn.stdpath("data") .. "/undodir"

-- Performance / responsiveness
opt.updatetime = 250
opt.timeoutlen = 400

-- Netrw (used until file explorer plugin loads)
vim.g.netrw_banner = 0
vim.g.netrw_liststyle = 3
vim.g.netrw_winsize = 30
