# Editor Integration Files

This directory contains the configuration snippets needed to add Clean language support
to various editors that use tree-sitter.

## Neovim (native treesitter)

Since nvim-treesitter is now archived, Neovim uses its built-in treesitter.
Add this to your Neovim config:

```lua
-- Add Clean parser
vim.treesitter.language.register('clean', { 'icl', 'dcl' })

-- Install via nvim-treesitter (if still using it)
vim.api.nvim_create_autocmd('User', { pattern = 'TSUpdate',
  callback = function()
    require('nvim-treesitter.parsers').clean = {
      install_info = {
        url = 'https://github.com/ishaq2321/tree-sitter-clean',
        revision = '260af40',
        files = { 'src/parser.c', 'src/scanner.c' },
        generate = true,
      },
      filetype = { 'icl', 'dcl' },
    }
  end
})
```

Copy `queries/` to `~/.config/nvim/queries/clean/` (or install via `:TSInstall clean`).

## Helix

Submit a PR to [helix-editor/helix](https://github.com/helix-editor/helix) adding the
block in `helix-languages.toml` (see file in this directory) to `languages.toml`.

## Zed

Create an extension repository with an `extension.toml`:

```toml
[extension]
name = "Clean"
description = "Clean programming language support"
version = "1.0.0"

[language.clean]
grammar = "clean"
path = "."
```

See [zed-industries/zed extensions docs](https://github.com/zed-industries/zed/tree/main/docs).
