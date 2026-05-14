-- General keymaps (plugin-specific maps live with their plugin spec).

local map = vim.keymap.set

-- Window navigation (Ctrl + hjkl)
map("n", "<C-h>", "<C-w>h")
map("n", "<C-j>", "<C-w>j")
map("n", "<C-k>", "<C-w>k")
map("n", "<C-l>", "<C-w>l")

-- Clear search highlight
map("n", "<leader>h", ":nohlsearch<CR>", { silent = true })

-- Save / quit
map("n", "<leader>w", ":w<CR>", { silent = true })
map("n", "<leader>q", ":q<CR>", { silent = true })
map("n", "<leader>Q", ":qa!<CR>", { silent = true })

-- Splits
map("n", "<leader>s", ":split<CR>", { silent = true })
map("n", "<leader>v", ":vsplit<CR>", { silent = true })

-- Buffer navigation
map("n", "<S-l>", ":bnext<CR>", { silent = true })
map("n", "<S-h>", ":bprevious<CR>", { silent = true })
map("n", "<leader>bd", ":bdelete<CR>", { silent = true })

-- Better indenting in visual mode (keep selection)
map("v", "<", "<gv")
map("v", ">", ">gv")

-- Move visual selection up/down
map("v", "J", ":m '>+1<CR>gv=gv")
map("v", "K", ":m '<-2<CR>gv=gv")

-- Keep cursor centered on big jumps
map("n", "<C-d>", "<C-d>zz")
map("n", "<C-u>", "<C-u>zz")
map("n", "n", "nzzzv")
map("n", "N", "Nzzzv")
