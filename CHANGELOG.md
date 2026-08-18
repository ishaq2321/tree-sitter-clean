# Changelog

All notable changes to `tree-sitter-clean` are documented here. The
project follows [Semantic Versioning](https://semver.org/).

## [v1.2.5] - 2026-08-18

Three additive grammar fixes, verified against the 239-file Clean corpus
(Clyde, clean-stdlib, Eastwood) and `npx tree-sitter test` (83/83 green):

- **Dotted field paths in record updates**: `{ r & a.b.c = v }`,
  `{ r & cache.[i] = v }`, `{ T | tde_typedef.td_name = "Bool" }`.
  Predef 57→28 (its `builtin_classes` record list had derailed the whole
  file head into one recovery ERROR), PmProject 35→9, PmAbcMagic 43→32,
  PmFileInfo 4→0.
- **Explicit-default record base**: `{ TypeDoc | gDefault{|*|} &
  description = ... }` — a type-named update starting from an explicit
  default record expression instead of the implicit generic default.
- **`<-:` array element generator**: `{f x \\ x <-: arr}` now lexes as one
  token (was `<-` + `:`, breaking every array comprehension).
  outlineviewcontroller 83→2, CloogleServer 65→28, plus _SystemDynamic,
  UtilOptions, PmPath, projwindowcontroller, Array.

Corpus result: **487 parse errors**, down from **731 in v1.2.4 (−244)**
with **zero file regressions** (every file improved or stayed the same).
Action-table ceiling 64767 (< 65535), 0 overflow warnings. The remaining
errors are documented in GRAMMAR-GAPS.md as a measured plateau — the
INLINE deeper-binding family and `_`-prefixed constructors, both shown
unreachable by additive changes (re-measured and reverted).

## [v1.2.4] - 2026-08-18

Parsing fixes, all verified against the 239-file Clean corpus (Clyde,
clean-stdlib, Eastwood) and `npx tree-sitter test` (83/83 green):

- **Spine-strict list literals**: `[a:b!]`, `[b!]` in expressions.
- **`!!` list-index operator** (`xs !! i`).
- **Dot-less strict array index** `a![i]` and index-access chains.
- **`#!` group continuation bindings** (`#! a = f x` followed by deeper
  members), via a GLR binding tail.
- **Array-index record-update bindings**: `subdirs & [i] = { ... }`
  (`# a & [i]=x` desugars to `# a = {a & [i]=x}` in Clean 2.3), plus
  `continuation_binding` members in guard and case-alternative body
  blocks.
- **Deeper-column continuation bindings in guard/case body blocks**: a
  binding-shaped line indented below the enclosing block level (a
  top-level `=` that is not `==`/`=>`/`=:`/`!=`/`<=`/`>=`, outside
  strings and brackets, excluding `#`/`|`/`=` starters, `where`/`with`
  keywords, and multi-line record values) now starts a
  `continuation_binding` member instead of being swallowed as an
  application argument of the previous member's value expression.
- **Class member lists, record-subset imports** (`import Foo (r)`),
  backtick imports, `(->)` type atoms, and derive lists.
- **Multi-guard case alternatives** (`case x of p | c1 -> b1 | c2 -> b2`)
  and module-alias imports.

Corpus result: **731 parse errors** (down from 791 at the previous
checkpoint), with the only regression being a single shifted error in
PmDirCache.icl. Action-table ceiling unchanged at 64042 (< 65535).

## [v1.2.3] - 2026-08-15

- Qualified / constructor-subset / derive imports.
- `=>` qualified imports and `as` aliases.
- Record update by type name: `{ T | field = value, ... }`.
- Single-quoted qualified names: `'Data.Error'.isError`.

## [v1.2.0] - 2026-08

- Initial published release (npm, PyPI, crates.io).

[v1.2.0]: https://github.com/ishaq2321/tree-sitter-clean/releases/tag/v1.2.0
[v1.2.3]: https://github.com/ishaq2321/tree-sitter-clean/releases/tag/v1.2.3
[v1.2.4]: https://github.com/ishaq2321/tree-sitter-clean/releases/tag/v1.2.4
[v1.2.5]: https://github.com/ishaq2321/tree-sitter-clean/releases/tag/v1.2.5
