# Changelog

All notable changes to `tree-sitter-clean` are documented here. The
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **`=.=` is lexed (Clean's generic equality, `Data.GenEq`).** It was not in
  any operator token: the catch-all alphabet is `[~%^*+\-\\<>/?$]+`, and `=.=`
  contains a `.`, which must stay a separate token for qualified names and
  field access. Any expression containing it —
  `(validSymbolMap symbolMap =.= True) /\ ...` — swallowed the following lines
  as one recovery ERROR. It is now an `operator_compare`, which fixes
  `eastwood/test/LinterTests.icl` completely (**10 → 0** problems, 378 → 0
  error bytes) and removes the derail point in
  `eastwood/test/LanguageServerTests.icl` (89 → 29 problem nodes; its own
  wrapper now starts at line 728 instead of 314). Corpus: 676 → 606 problem
  nodes, no file worse in either metric. Two corpus tests added.

### Changed — the regression gate measures error BYTES and wrapping, not only
### problem-node counts

A node count can improve while the tree gets worse: when error recovery cannot
resynchronise it wraps a region — or the whole file — in **one** ERROR node, so
193 problems become 10 and the file reads as "almost clean" while it is in fact
unparsed. `scripts/corpus_regression.py` now reports three numbers per file and
fails on any of them getting worse:

- **problem nodes** (ERROR + MISSING) — unchanged;
- **error bytes** — source bytes inside ERROR/MISSING nodes (union of ranges);
- **wrapped** — one top-level ERROR covering ≥50% of the file (including the
  case where the parse tree's root is an ERROR and no `source_file` exists).

`scripts/corpus-baseline.tsv` is now
`path<TAB>problem nodes<TAB>error bytes<TAB>wrapped`; a two-column baseline
still loads, with the byte checks reported as skipped instead of silently
passing.

Baseline under the new metric: **606 problem nodes, 260,863 error bytes, 4
wrapped files** — `LanguageServerTests.icl`, `PmParse.icl`,
`_SystemDynamic.icl`, `TestModule.icl`. Before the `=.=` fix below the same
metric read 676 nodes / 261,241 bytes, and it re-confirmed the v1.2.5→HEAD fix
pass as a real improvement (285,752 → 261,241 error bytes; no file worse except
`Symbol.icl` +81 bytes for −50 nodes). See §12 of GRAMMAR-GAPS.md for the
measurements, including two fixes that were reverted after this metric showed
them to be 4× downgrades.

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
