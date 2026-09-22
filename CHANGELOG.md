# Changelog

All notable changes to `tree-sitter-clean` are documented here. The
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **ADT extension declarations: `:: DiagnosticSource | TrailingWhitespacePass`.**
  Clean lets a module add constructors to a type it imported, and that
  constructor list starts with `|` — there is no `=`. Every Eastwood linter
  pass declares its own diagnostic source that way, so each pass module
  derailed at that line. The new `type_definition` alternative reuses the
  existing `data_constructors` rule, so the tree reads exactly like
  `:: T = C`. Measured: **577 → 544 problem nodes, 260,705 → 260,010 error
  bytes**, five files improved and none worse — `TrailingWhitespace.dcl` and
  `BasicValueCAFs.dcl` now parse **clean**, `Compiler.icl` drops 541 → 1 error
  byte. Costs +12 of the 302 spare action rows (0 overflow warnings). One
  corpus test added. The comma-separated instance form
  (`instance toString Target, Platform, Architecture`) was measured at +2252
  rows and rejected; see §14f of GRAMMAR-GAPS.md.

- **`//` inside a block comment no longer lets a `*/` close it.** Clean's rule
  is that a `//` inside `/* ... */` starts a *line* comment, so the rest of
  that line is inert and a `*/` on it closes nothing (stated verbatim in
  Eastwood's own comment scanner, `src/languageServer/Util.icl`). The external
  scanner closed the comment at line 1 of Eastwood's
  `test/suite-default/someLib/TestModule.icl` fixture, making its second line a
  syntax error. The fixture — a module header wrapped in hostile comments,
  which its test asserts is *valid* — now parses exactly as intended, with the
  header's inner `/* */` intact: **3 → 0 problem nodes, 152 → 0 error bytes**,
  wrapped files 4 → 3. A corpus-wide scan shows this is the only such comment
  in the corpus (so no other file can change); three corpus tests added.

- **`_`-prefixed type names: `:: _UnificationEnvironment`, `| _TypeFixedVar`.**
  Clean allows `_`-prefixed *capitalized* names as constructors and type names
  (`clean-stdlib`'s `_SystemDynamic`, `_SystemStrictLists`,
  `_SystemStrictMaybes` are built on them). They cannot join the `constructor`
  token, which is load-bearing for the action-table ceiling, so they are
  re-typed by a new `underscore_constructor` token and used **only** where
  Clean requires a constructor — type-definition names and ADT member names —
  aliased back to `constructor`, so the tree is indistinguishable from
  ordinary Clean. `clean-stdlib/_SystemDynamic.dcl` goes **5 → 0 problem
  nodes, 6 → 0 error bytes**. The same token in `constructor_pattern` needs
  66572 actions (ceiling 65535) and is documented as the remaining
  `_SystemDynamic.icl` blocker in §13b of GRAMMAR-GAPS.md. Two corpus tests
  added.

- **Strict list comprehensions: `[! x \\ x <- xs | p x !]`.**
  `list_comprehension` accepted only `[` and the overloaded `[|` marker,
  while `list_expression` accepts `!`/`!!`/`#`/`#!`/`|` after the bracket and
  `array_comprehension` already accepted `!`/`#`. The result was not an
  error but a **silent misparse**: `[! fAndLn \\ fAndLn <- ls]` became a
  two-element list whose first element was the unary expression `!fAndLn`
  (element separators are optional, so nothing rejected it), and adding the
  comprehension guard `|` collapsed the parse — Eastwood's
  `LanguageServerTests.icl` wrapped 1783 lines in one ERROR from line 768.
  The rule now takes the same leading markers plus the spine-strict `!`
  close. Corpus 606 → 586 problem nodes, no file worse; two corpus tests.

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

Baseline when the metric was introduced: **586 problem nodes, 260,863 error
bytes, 4 wrapped files** — `LanguageServerTests.icl`, `PmParse.icl`,
`_SystemDynamic.icl`, `TestModule.icl`. After the two fixes in this section the
baseline is **577 problem nodes, 260,705 error bytes, 3 wrapped files**
(`_SystemDynamic.icl` is the one still wrapped). Before the two fixes below the same
metric read 676 nodes / 261,241 bytes, and it re-confirmed the v1.2.5→HEAD fix
pass as a real improvement (285,752 → 261,241 error bytes; no file worse except
`Symbol.icl` +81 bytes for −50 nodes). See §12 of GRAMMAR-GAPS.md for the
measurements, including four formulations that were reverted after this metric
showed them to be downgrades.

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
