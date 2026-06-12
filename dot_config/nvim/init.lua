-- Minimal Neovim config

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

-- Leader key
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Line numbers
vim.opt.number = true
vim.opt.relativenumber = true

-- Indentation
vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.smartindent = true

-- Search
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.hlsearch = false
vim.opt.incsearch = true

-- Appearance
vim.opt.termguicolors = true
vim.opt.signcolumn = "yes"
vim.opt.cursorline = true
vim.opt.scrolloff = 8

-- System clipboard
vim.opt.clipboard = "unnamedplus"

-- Splits
vim.opt.splitright = true
vim.opt.splitbelow = true

-- Undo
vim.opt.undofile = true
vim.opt.swapfile = false

-- Performance
vim.opt.updatetime = 250
vim.opt.timeoutlen = 300

-- Whitespace characters
vim.opt.list = true
vim.opt.listchars = { tab = "» ", trail = "·", nbsp = "␣" }

-- Track textwidth (set by .editorconfig) for the colorcolumn guide.
vim.opt.colorcolumn = "+0"

-- Keymaps
vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<CR>")
vim.keymap.set("n", "<leader>w", "<cmd>w<CR>", { desc = "Save" })
vim.keymap.set("n", "<leader>q", "<cmd>q<CR>", { desc = "Quit" })

-- Move between splits
vim.keymap.set("n", "<C-h>", "<C-w>h")
vim.keymap.set("n", "<C-j>", "<C-w>j")
vim.keymap.set("n", "<C-k>", "<C-w>k")
vim.keymap.set("n", "<C-l>", "<C-w>l")

-- Move lines in visual mode
vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv", { desc = "Move line down" })
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv", { desc = "Move line up" })

-- Plugins
require("lazy").setup({
  -- File explorer
  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons",
      "MunifTanjim/nui.nvim",
    },
    keys = {
      { "<leader>e", "<cmd>Neotree toggle<CR>", desc = "File explorer" },
    },
    lazy = false,
    init = function()
      -- Auto-open neo-tree when opening a directory
      vim.api.nvim_create_autocmd("VimEnter", {
        callback = function(data)
          if vim.fn.isdirectory(data.file) == 1 then
            vim.cmd("bdelete")
            vim.cmd("Neotree show")
          end
        end,
      })
    end,
    opts = {
      filesystem = {
        follow_current_file = { enabled = true },
        filtered_items = { visible = true },
        use_libuv_file_watcher = true,
      },
      default_component_configs = {
        modified = { symbol = "● " },
        git_status = {
          symbols = {
            added     = "✚",
            modified  = "",
            deleted   = "✖",
            renamed   = "󰁕",
            untracked = "",
            ignored   = "",
            unstaged  = "󰄱",
            staged    = "",
            conflict  = "",
          },
        },
        file = {
          enabled = true,
        },
      },
      window = {
        width = 32,
        mappings = {
          ["s"] = "open_vsplit",
          ["S"] = "open_split",
        },
      },
    },
  },

  -- Treesitter parsers (highlighting is built-in on 0.12, just need parsers)
  {
    "neovim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter").setup({
        install_dir = vim.fn.stdpath("data") .. "/site",
      })
      -- Install parsers not bundled with neovim
      local parsers = { "go", "gomod", "gosum", "javascript", "typescript", "tsx", "json", "bash", "swift" }
      for _, lang in ipairs(parsers) do
        if not pcall(vim.treesitter.language.inspect, lang) then
          vim.cmd("TSInstall " .. lang)
        end
      end
    end,
  },

  -- Mason (auto-install LSP servers)
  {
    "williamboman/mason.nvim",
    opts = {},
  },

  -- LSP configs (provides server definitions for vim.lsp.config)
  {
    "neovim/nvim-lspconfig",
    dependencies = { "williamboman/mason.nvim" },
  },

  -- LSP progress indicator
  {
    "j-hui/fidget.nvim",
    opts = {},
  },

  -- Theme
  {
    "folke/tokyonight.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      require("tokyonight").setup({ style = "night" })
      vim.cmd("colorscheme tokyonight")
    end,
  },

  -- Status line
  {
    "nvim-lualine/lualine.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    opts = {
      options = {
        theme = "tokyonight",
      },
    },
  },

  -- GitHub PR reviews (patched for GHE support)
  {
    "gh-tui-tools/gh-review.nvim",
    cmd = { "GHReview", "GHReviewFiles", "GHReviewSubmit", "GHReviewClose" },
    config = function()
      -- Patch state.lua to parse GHE SSH/HTTPS remotes (not just github.com)
      local state = require("gh_review.state")
      local orig_get_repo_info = state.get_repo_info
      state.get_repo_info = function()
        local obj = vim.system({ "git", "remote", "get-url", "origin" }, { text = true }):wait()
        if obj.code ~= 0 then
          vim.notify("[gh-review] Not in a git repository or no origin remote", vim.log.levels.ERROR)
          return false
        end
        local remote = vim.trim(obj.stdout or "")
        -- SSH: git@<host>:<owner>/<name>.git
        local ssh_owner, ssh_name = remote:match("git@[^:]+:([^/]+)/([^/]+)")
        if ssh_owner then
          state.set_repo_info(ssh_owner, ssh_name:gsub("%.git$", ""))
          return true
        end
        -- HTTPS: https://<host>/<owner>/<name>.git
        local https_owner, https_name = remote:match("https?://[^/]+/([^/]+)/([^/]+)")
        if https_owner then
          state.set_repo_info(https_owner, https_name:gsub("%.git$", ""))
          return true
        end
        return orig_get_repo_info()
      end

      -- Patch init.lua open() URL parsing to accept any host
      local gh_review = require("gh_review")
      local orig_open = gh_review.open
      gh_review.open = function(pr_number_str)
        pr_number_str = pr_number_str or ""
        -- Rewrite GHE URLs to extract owner/name/number before the original parser
        local o, n, num = pr_number_str:match("https?://[^/]+/([^/]+)/([^/]+)/pull/(%d+)")
        if o and not pr_number_str:match("github%.com") then
          -- Set repo info directly and pass just the number
          state.set_repo_info(o, n)
          -- Detect GHE hostname for gh CLI
          local host = pr_number_str:match("https?://([^/]+)/")
          if host then
            vim.env.GH_HOST = host
          end
          return orig_open(tostring(num))
        end
        return orig_open(pr_number_str)
      end

      -- Set GH_HOST from git remote for non-URL usage too
      local obj = vim.system({ "git", "remote", "get-url", "origin" }, { text = true }):wait()
      if obj.code == 0 then
        local remote = vim.trim(obj.stdout or "")
        local host = remote:match("git@([^:]+):") or remote:match("https?://([^/]+)/")
        if host and host ~= "github.com" then
          vim.env.GH_HOST = host
        end
      end
    end,
  },

  -- Pi integration (send code/prompts to running pi session)
  {
    "carderne/pi-nvim",
    cmd = { "Pi", "PiSend", "PiSendFile", "PiSendSelection", "PiSendBuffer", "PiPing", "PiSessions" },
    keys = {
      { "<leader>p", "<cmd>Pi<CR>", mode = { "n", "v" }, desc = "Send to Pi" },
    },
    opts = {},
  },

  -- VCS signs in gutter (git, jj, and more)
  { "mhinz/vim-signify" },

  -- Auto-close brackets/quotes
  {
    "windwp/nvim-autopairs",
    event = "InsertEnter",
    opts = {},
  },

  -- Toggle comments with gc
  {
    "numToStr/Comment.nvim",
    opts = {},
  },

  -- Fuzzy finder
  {
    "nvim-telescope/telescope.nvim",
    branch = "0.1.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      { "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
    },
    keys = {
      { "<leader>f", "<cmd>Telescope find_files<CR>", desc = "Find files" },
      { "<leader>g", "<cmd>Telescope live_grep<CR>", desc = "Live grep" },
      { "<leader>b", "<cmd>Telescope buffers<CR>", desc = "Buffers" },
      { "<leader>s", "<cmd>Telescope lsp_document_symbols<CR>", desc = "Symbols" },
      { "<leader>/", "<cmd>Telescope current_buffer_fuzzy_find<CR>", desc = "Search in buffer" },
    },
    config = function()
      local telescope = require("telescope")
      telescope.setup({
        defaults = {
          file_ignore_patterns = { "node_modules", ".git/" },
        },
      })
      pcall(telescope.load_extension, "fzf")
    end,
  },

  -- Xcode build/run/test for iOS development
  {
    "wojciech-kulik/xcodebuild.nvim",
    dependencies = {
      "nvim-telescope/telescope.nvim",
      "MunifTanjim/nui.nvim",
    },
    ft = "swift",
    opts = {},
    keys = {
      { "<leader>xb", "<cmd>XcodebuildBuild<CR>", desc = "Xcode Build" },
      { "<leader>xr", "<cmd>XcodebuildBuildRun<CR>", desc = "Xcode Build & Run" },
      { "<leader>xt", "<cmd>XcodebuildTest<CR>", desc = "Xcode Test" },
      { "<leader>xd", "<cmd>XcodebuildSelectDevice<CR>", desc = "Xcode Select Device" },
      { "<leader>xp", "<cmd>XcodebuildSelectScheme<CR>", desc = "Xcode Select Scheme" },
      { "<leader>xl", "<cmd>XcodebuildToggleLogs<CR>", desc = "Xcode Toggle Logs" },
    },
  },

  -- Auto-formatting (only when project has formatter config)
  {
    "stevearc/conform.nvim",
    event = "BufWritePre",
    cmd = "ConformInfo",
    keys = {
      { "<leader>cf", function() require("conform").format({ async = true }) end, desc = "Format buffer" },
    },
    config = function()
      local util = require("conform.util")
      require("conform").setup({
        formatters_by_ft = {
          go = { "gofumpt", "goimports" },
          javascript = { "prettier" },
          javascriptreact = { "prettier" },
          typescript = { "prettier" },
          typescriptreact = { "prettier" },
          json = { "prettier" },
          yaml = { "prettier" },
          markdown = { "prettier" },
          css = { "prettier" },
          html = { "prettier" },
          lua = { "stylua" },
          swift = { "swiftformat" },
        },
        format_on_save = function(bufnr)
          local bufname = vim.api.nvim_buf_get_name(bufnr)
          if bufname == "" then return end
          return { timeout_ms = 2000, lsp_format = "fallback" }
        end,
        formatters = {
          prettier = {
            require_cwd = true,
            cwd = util.root_file({
              ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml",
              ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml",
              "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
            }),
          },
          stylua = {
            require_cwd = true,
            cwd = util.root_file({ "stylua.toml", ".stylua.toml" }),
          },
          swiftformat = {
            require_cwd = true,
            cwd = util.root_file({ ".swiftformat" }),
          },
        },
      })
    end,
  },

  -- Diagnostics & quickfix list
  {
    "folke/trouble.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    cmd = "Trouble",
    keys = {
      { "<leader>xx", "<cmd>Trouble diagnostics toggle<CR>", desc = "Diagnostics" },
      { "<leader>xd", "<cmd>Trouble diagnostics toggle filter.buf=0<CR>", desc = "Buffer diagnostics" },
      { "<leader>xs", "<cmd>Trouble symbols toggle focus=false<CR>", desc = "Symbols" },
      { "<leader>xr", "<cmd>Trouble lsp toggle focus=false win.position=right<CR>", desc = "LSP references" },
      { "<leader>xq", "<cmd>Trouble qflist toggle<CR>", desc = "Quickfix" },
    },
    opts = {},
  },

  -- Render markdown in-buffer
  {
    "MeanderingProgrammer/render-markdown.nvim",
    dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" },
    ft = "markdown",
    opts = {},
  },

  -- Keybind hints
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {},
  },

  -- Highlight TODO/FIXME/HACK comments
  {
    "folke/todo-comments.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    opts = {},
  },

  -- Code outline (symbols sidebar)
  {
    "hedyhli/outline.nvim",
    cmd = "Outline",
    keys = {
      { "<leader>o", "<cmd>Outline<CR>", desc = "Toggle outline" },
    },
    opts = {},
  },

  -- Machine-specific extras (loaded from lua/plugins/extras.lua if present)
  { import = "plugins.extras", optional = true },
})

-- LSP server configs (native 0.12 API)
vim.lsp.config["ts_ls"] = {
  cmd = { "typescript-language-server", "--stdio" },
  filetypes = { "javascript", "javascriptreact", "typescript", "typescriptreact" },
  root_markers = { "tsconfig.json", "jsconfig.json", "package.json", ".git" },
}

vim.lsp.config["gopls"] = {
  cmd = { "gopls" },
  filetypes = { "go", "gomod", "gowork", "gotmpl" },
  root_markers = { "go.mod", ".git" },
  settings = {
    gopls = {
      analyses = { unusedparams = true },
      staticcheck = true,
      gofumpt = true,
    },
  },
}

vim.lsp.config["sourcekit"] = {
  cmd = { "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/sourcekit-lsp" },
  filetypes = { "swift", "objective-c", "objective-cpp" },
  root_markers = { "Package.swift", ".git", "*.xcodeproj", "*.xcworkspace" },
}

vim.lsp.enable({ "ts_ls", "gopls", "sourcekit" })

-- Show diagnostics on hover (automatic, no keypress needed)
vim.diagnostic.config({
  virtual_text = true,
  float = { border = "rounded" },
})

-- Native completion (built-in on 0.12)
vim.opt.completeopt = "menu,menuone,noselect"
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(event)
    -- Enable native LSP completion
    vim.lsp.completion.enable(true, event.data.client_id, event.buf, { autotrigger = false })
    vim.keymap.set("i", "<C-Space>", vim.lsp.completion.trigger, { buffer = event.buf, desc = "Trigger completion" })

    -- LSP keymaps
    local map = function(keys, func, desc)
      vim.keymap.set("n", keys, func, { buffer = event.buf, desc = desc })
    end
    map("gd", vim.lsp.buf.definition, "Go to definition")
    map("gr", vim.lsp.buf.references, "Go to references")
    map("gi", vim.lsp.buf.implementation, "Go to implementation")
    map("K", vim.lsp.buf.hover, "Hover docs")
    map("<leader>r", vim.lsp.buf.rename, "Rename symbol")
    map("<leader>a", vim.lsp.buf.code_action, "Code action")
    map("<leader>d", vim.diagnostic.open_float, "Line diagnostics")
  end,
})
