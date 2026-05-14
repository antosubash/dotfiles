-- Neovim entry point — bootstrap lazy.nvim and load config modules.

-- Set leader keys BEFORE loading plugins (so lazy keymaps see them).
vim.g.mapleader = ","
vim.g.maplocalleader = ","

-- Core editor settings & keymaps.
require("config.options")
require("config.keymaps")

-- Plugin manager + plugin specs.
require("config.lazy")
