-- All plugin specs in one file. lazy.nvim will load each table entry.

return {
    -- ============================================================
    -- Colorscheme: Catppuccin (matches the rest of the dotfiles theme)
    -- ============================================================
    {
        "catppuccin/nvim",
        name = "catppuccin",
        priority = 1000,
        config = function()
            require("catppuccin").setup({ flavour = "mocha" })
            vim.cmd.colorscheme("catppuccin")
        end,
    },

    -- ============================================================
    -- Treesitter: better syntax highlighting & code understanding
    -- ============================================================
    {
        "nvim-treesitter/nvim-treesitter",
        build = ":TSUpdate",
        event = { "BufReadPost", "BufNewFile" },
        config = function()
            require("nvim-treesitter.configs").setup({
                ensure_installed = {
                    "bash", "c", "cpp", "css", "csharp", "dockerfile",
                    "go", "html", "javascript", "json", "lua", "make",
                    "markdown", "markdown_inline", "python", "rust",
                    "toml", "tsx", "typescript", "vim", "vimdoc", "yaml",
                },
                highlight = { enable = true },
                indent = { enable = true },
                incremental_selection = { enable = true },
            })
        end,
    },

    -- ============================================================
    -- Telescope: fuzzy finder for files, grep, buffers
    -- Requires ripgrep + fd-find (installed by setup-server.sh)
    -- ============================================================
    {
        "nvim-telescope/telescope.nvim",
        dependencies = { "nvim-lua/plenary.nvim" },
        cmd = "Telescope",
        keys = {
            { "<leader>ff", function() require("telescope.builtin").find_files() end, desc = "Find files" },
            { "<leader>fg", function() require("telescope.builtin").live_grep() end,  desc = "Live grep" },
            { "<leader>fb", function() require("telescope.builtin").buffers() end,    desc = "Buffers" },
            { "<leader>fh", function() require("telescope.builtin").help_tags() end,  desc = "Help tags" },
            { "<leader>fr", function() require("telescope.builtin").oldfiles() end,   desc = "Recent files" },
        },
        config = function()
            require("telescope").setup({
                defaults = { path_display = { "smart" } },
            })
        end,
    },

    -- ============================================================
    -- File explorer
    -- ============================================================
    {
        "nvim-tree/nvim-tree.lua",
        dependencies = { "nvim-tree/nvim-web-devicons" },
        keys = {
            { "<leader>e", ":NvimTreeToggle<CR>", desc = "Toggle file tree", silent = true },
        },
        config = function()
            vim.g.loaded_netrw = 1
            vim.g.loaded_netrwPlugin = 1
            require("nvim-tree").setup({
                view = { width = 32 },
                renderer = { group_empty = true },
                filters = { dotfiles = false },
            })
        end,
    },

    -- ============================================================
    -- Statusline
    -- ============================================================
    {
        "nvim-lualine/lualine.nvim",
        dependencies = { "nvim-tree/nvim-web-devicons" },
        event = "VeryLazy",
        config = function()
            require("lualine").setup({
                options = { theme = "catppuccin", globalstatus = true },
            })
        end,
    },

    -- ============================================================
    -- Git signs in the gutter + hunk navigation
    -- ============================================================
    {
        "lewis6991/gitsigns.nvim",
        event = { "BufReadPre", "BufNewFile" },
        config = function()
            require("gitsigns").setup()
        end,
    },

    -- ============================================================
    -- LSP: mason installs servers, lspconfig wires them up
    -- ============================================================
    {
        "neovim/nvim-lspconfig",
        dependencies = {
            { "williamboman/mason.nvim", build = ":MasonUpdate", config = true },
            "williamboman/mason-lspconfig.nvim",
            "hrsh7th/cmp-nvim-lsp",
        },
        event = { "BufReadPre", "BufNewFile" },
        config = function()
            local lspconfig = require("lspconfig")
            local capabilities = require("cmp_nvim_lsp").default_capabilities()

            require("mason-lspconfig").setup({
                ensure_installed = {
                    "lua_ls", "pyright", "gopls", "rust_analyzer",
                    "ts_ls", "bashls", "jsonls", "yamlls",
                },
            })

            -- Default on_attach: buffer-local keymaps
            local on_attach = function(_, bufnr)
                local opts = { buffer = bufnr, silent = true }
                local m = vim.keymap.set
                m("n", "gd", vim.lsp.buf.definition, opts)
                m("n", "gr", vim.lsp.buf.references, opts)
                m("n", "gi", vim.lsp.buf.implementation, opts)
                m("n", "K",  vim.lsp.buf.hover, opts)
                m("n", "<leader>rn", vim.lsp.buf.rename, opts)
                m("n", "<leader>ca", vim.lsp.buf.code_action, opts)
                m("n", "<leader>d",  vim.diagnostic.open_float, opts)
                m("n", "[d", vim.diagnostic.goto_prev, opts)
                m("n", "]d", vim.diagnostic.goto_next, opts)
                m("n", "<leader>F", function() vim.lsp.buf.format({ async = true }) end, opts)
            end

            -- Apply to every server installed via mason-lspconfig.
            for _, server in ipairs(require("mason-lspconfig").get_installed_servers()) do
                lspconfig[server].setup({
                    capabilities = capabilities,
                    on_attach = on_attach,
                })
            end
        end,
    },

    -- ============================================================
    -- Autocompletion
    -- ============================================================
    {
        "hrsh7th/nvim-cmp",
        event = "InsertEnter",
        dependencies = {
            "hrsh7th/cmp-nvim-lsp",
            "hrsh7th/cmp-buffer",
            "hrsh7th/cmp-path",
            "L3MON4D3/LuaSnip",
            "saadparwaiz1/cmp_luasnip",
        },
        config = function()
            local cmp = require("cmp")
            local luasnip = require("luasnip")
            cmp.setup({
                snippet = {
                    expand = function(args) luasnip.lsp_expand(args.body) end,
                },
                mapping = cmp.mapping.preset.insert({
                    ["<C-Space>"] = cmp.mapping.complete(),
                    ["<CR>"]      = cmp.mapping.confirm({ select = true }),
                    ["<Tab>"]     = cmp.mapping.select_next_item(),
                    ["<S-Tab>"]   = cmp.mapping.select_prev_item(),
                }),
                sources = cmp.config.sources({
                    { name = "nvim_lsp" },
                    { name = "luasnip" },
                    { name = "path" },
                    { name = "buffer" },
                }),
            })
        end,
    },

    -- ============================================================
    -- Misc QoL
    -- ============================================================
    { "numToStr/Comment.nvim", event = "VeryLazy", config = true },
    { "windwp/nvim-autopairs", event = "InsertEnter", config = true },
    {
        "folke/which-key.nvim",
        event = "VeryLazy",
        opts = { preset = "modern" },
    },
    {
        "lukas-reineke/indent-blankline.nvim",
        main = "ibl",
        event = { "BufReadPost", "BufNewFile" },
        opts = {},
    },
}
