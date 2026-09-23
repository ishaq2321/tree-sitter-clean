# Changelog

All notable changes to `tree-sitter-clean` are documented here. The
project follows [Semantic Versioning](https://semver.org/).

## [v1.2.7] - 2026-09-23

Five grammar changes measured against the same 312-file corpus gate
(`scripts/corpus_regression.py`): **322 → 297 problem nodes, 156,254 →
78,193 error bytes (−78,061), wrapped files 3 → 2**. No file gets worse in
problem nodes; the corpus suite stays green (123/123). The action table is at
**64,484 rows of the 65,535 ceiling (1,051 spare)**.

### Fixed

- **Multi-line list comprehensions whose body chains two or more `++`
  operators** (`[ … ++ … ++ … \\ gen, let q = e ]`). The element repeat's
  *optional* separator let the catch-all `operator` token start a new element
  at `++` as a prefix-unary expression; that branch outlived the comprehension
  and ate the `\\` generator as operator soup — a visible error when a `let`
  qualifier followed, and a *silent* mis-parse (zero `generator` nodes) when it
  did not. The separator is now required, which is what Clean's syntax demands
  anyway. Collapsing the element-restart machinery also freed **2,694
  parse-table rows**.
- **Lambdas whose body is a let-before (`#`) binding**:
  `\dir world # paths = readDirectory dir world = (paths, world)` (Symbol.icl's
  scanDirectories, LanguageServerTests' root derail). The lambda body now
  accepts a `#` binding closed by `= result`; `prec.dynamic(-1)` keeps the
  comprehension interpretation winning when a `\\` follows a comprehension
  body. LanguageServerTests **62,593 → 436 bytes**, TextDocumentUtil 8 → 0.
- **The same `#`-body closed by a `|`-guard**
  (`\args world # (x, w) = f p w | isError x -> …`, GotoUtil.icl L236's mapSt
  lambda): the closer set becomes `= | |`. This one change carries the release:
  GotoUtil.icl **10,428 → 635 bytes** (its L236 wrap collapses to the L121
  `->` residual), and — because a state change anywhere in the automaton can
  re-decide an unrelated GLR fork — the `let`-qualifier region of Symbol.icl
  now wins its fork instead of wrapping the file: **20,905 → 94 bytes**, with
  SemVer.icl **208 → 69**.
- **The `!?` operator** (`lines !? lineNr`, GotoUtil L104) joined the
  `operator_compare` token alongside `=?=` and `=.=`. Reusing the terminal
  leaves the automaton unchanged.
- **`let` qualifier precedence.** `let_qualifier` carries `prec.right(1)` so a
  multi-binding qualifier's continuation lines (`let a = e` then a
  deeper-indented `b = e2`, Symbol.icl L470-472) stay reachable: with no
  separator token between the value and the next binding, shift/reduce defaults
  to SHIFT and the application swallows the next binding's name. Measured in
  isolation the precedence change does not move the corpus numbers; it is kept
  because it is what makes the continuation competitive at all.

### Known recovery site (see GRAMMAR-GAPS §19)

- **GotoUtil.icl 25 → 635 bytes** — the file's L121 lambda,
  `\(_, line) # firstColon = … -> if …`, closes its `#` body with an
  **arrow**. Adding `$.arrow` to the closer set removes this residual (and
  finishes LanguageServerTests at 0 bytes) but measurably re-wraps Symbol.icl
  (94 → 20,905 bytes) and raises SemVer.icl (69 → 208): a net loss of 19,879
  bytes, so the arrow is deliberately absent. The remaining 635 bytes are the
  smaller side of that trade.

## [v1.2.6] - 2026-09-22

Five more constructs from the 239-file Clean corpus (Clyde, clean-stdlib,
Eastwood, cloogle.org), each isolated with a minimal probe and verified by the
byte gate (`npm run regress`) and `npx tree-sitter test` (116/116).

Against the committed baseline the gate moves **386 → 322 problem nodes,
157,923 → 156,254 error bytes**, three wrapped files unchanged, **no file
worse in either metric**. The action table is at **65,462 rows of the 65,535
ceiling (73 spare)** — the automaton's hard limit is what keeps the four big
files wrapped (see §17 of GRAMMAR-GAPS.md).

### Fixed

- **Functional `if` with a field/index access as its condition: `if r.flag a b`.**
  In Clean `if` is an ordinary function (`if c t e`), and the grammar's
  function-form operands were `_expression_atom` only — a field/index access is
  listed separately in the application rule, not in the atom set. So both
  `(if lo1.link_resources (…) True)` (PmProject) and
  `if opts.reload_cache (doInBackground reloadCache) id (db,w)` (CloogleServer)
  derailed: **PmProject 390 → 0 error bytes, CloogleServer 391 → 13, Link.icl
  216 → 16, builddb.icl 36 → 0.** Only the CONDITION is widened: widening all
  three operands asks tree-sitter for a `!`-fork conflict with `_record`, and a
  hidden helper rule for the widened condition broke `if` keyword lexing
  outright (the declaration reparsed as an application). Zero action rows.

- **`=?=` lexed as a comparison operator.** Eastwood's
  `instance < Target where (<) x y = (x =?= y)=:LT` derailed because the
  operator alphabet excludes `=` on purpose (it would swallow the definition
  `=`), leaving `=` + `?=`. The lexeme joins the existing `operator_compare`
  terminal rather than a new token, so the parse table is byte-identical
  (**Target.icl 138 → 52 error bytes, zero action rows**).

- **`foreign export` of a constructor** (`foreign export Build`,
  `foreign export BuildAndRun` — Clyde's projdocument.icl). The exported name
  accepted only a lowercase `identifier`, but a capitalised name lexes as a
  `constructor`, so the declaration failed on its own name. Five sites in the
  corpus.

- **`derive` imports over any type atom**:
  `from LSP.Internal.Serialize import derive gLSPJSONEncode [!]` (Hover.dcl)
  requires the derived type to be a list atom, and the import item demanded a
  `constructor`. The atom starts with `constructor`, so the tree of the
  existing form is unchanged. Ten sites in the corpus.

- **Abstract newtypes: `:: AbstractNewType (=: AbstractNewTypeConstructor Int)`**
  (SymbolMapExample.dcl) — the parenthesised `=:` body of a definition module,
  reusing the same synonym rule as the bare `:: T =: rhs` form.

- **Multi-character single-quoted literals (`'abc'`) — Clean's "special syntax
  for `[Char]` lists".** A single-quoted literal of two or more characters is a
  list of characters, exactly like the double-quoted form, and it is valid in
  patterns as well; Cloogle's own syntax reference documents it
  (`abc = ['abc']`, `abc ['abc':rest] = True`), and Eastwood's `tooLarge.icl` is
  a single 100,000-character one. The grammar accepted only ONE character, so
  `'abc'` lexed as nothing at all and every file using the form derailed —
  `tooLarge.icl` alone was 38% of the corpus's error bytes. New `char_list`
  token, offered wherever `char` already is (`_expression_atom`,
  `_pattern_atom`, `_pattern`). One character still lexes as `char`, and
  `'Data.Map'.toList` still lexes as `single_quoted_name` (that token is
  longer), so nothing else changes. Costs **+1** of the spare action rows and
  takes the corpus from **439 → 386 problem nodes, 258,183 → 157,923 error
  bytes**: `tooLarge.icl` 100,002 → 0, `cloogle.org/…/Predef.icl` 123 → 0,
  `PmAbcMagic.icl` 177 → 0, `PmParse.icl` 155 → 137. Five corpus tests added.

- **Negative literals in pattern position: `indexOfNewlineBefore -1 = -1`.**
  `number` accepted only `~` as a sign prefix, so a negative literal could not
  be used as a pattern anywhere (Eastwood's `Compiler.icl`). Adding `-` is
  neutral in expression position — the per-tier operator tokens carry lexical
  precedence and so still win the match, which leaves `x -1` a
  `binary_expression` (verified by comparing trees before and after) — while in
  pattern position no `-` operator is valid, so `-1` finally lexes as one
  number. `Compiler.icl` now parses **clean** and `PmParse.icl` drops a further
  9 problem nodes.

- **Capitalized generic names: `JSONEncode{|Version|}`.**
  `generic_case_definition` required a lowercase `identifier` for its name, but
  Clean's built-in generics are capitalized and lex as `constructor`; Eastwood's
  `SemVer.icl` and `LockFile.icl` declare them that way. Costs nothing — the
  action table *shrank* by 28 rows — and `LockFile.icl` goes 10 → 0 problem
  nodes, `SemVer.icl` 519 → 208 error bytes.

- **Trailing `;` on every member of a guard chain.** Clyde ends each member with
  one, including an inline `| c = e;` guard (Eastwood-adjacent `Link.icl`'s
  `FindChar`/`FindQuoteChar`, `PmAbcMagic.icl`'s `SubStringToInt`); the
  `#`-binding branch already absorbed the terminator but the guard branches did
  not. Both guard branches (function and operator definitions) now accept it per
  iteration and once at the end of the chain.

- **Braces inside a string in a `code { ... }` block.** The `abc_instruction`
  token stopped at any brace, including one inside a quoted string, so
  `buildAC "StdArray:select ({#} a) should not be called"` ended the ABC body
  early, left the block's `}` MISSING and derailed the rest of the file. The
  token now consumes quoted strings (which may not span a newline, so an
  unbalanced quote cannot swallow the block). Because the token's *symbol* is
  unchanged this is a lexer-only fix that costs **no action rows** — the
  cheapest kind at the 65535 ceiling — and `clean-stdlib/_SystemArray.icl` goes
  **12 → 0 problem nodes, 1231 → 0 error bytes**. One corpus test added.

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
[v1.2.6]: https://github.com/ishaq2321/tree-sitter-clean/releases/tag/v1.2.6
