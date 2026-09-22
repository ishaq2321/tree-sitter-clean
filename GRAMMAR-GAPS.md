# Grammar Gaps

This file catalogues Clean constructs the grammar does **not** (fully) parse,
with the real-world examples that exercise them and — critically — the
approaches that were tried and **failed**, so future work does not repeat
the dead ends. Everything here was verified against the 120-file corpus
(clean-stdlib, Clyde, cloogle.org) before being rejected.

**Why gaps are hard to close:** the grammar's LALR automaton sits at a
fragile equilibrium. Adding a token or rule to expression/operator/name
positions can shift parse states globally and silently break *error
recovery* in files that never use the new construct — typically producing
a whole-file `ERROR` wrapper where the file previously parsed with local
errors. Every rejected approach below was rejected for exactly this reason,
measured on the full suite, not on isolated probes.

The current verified baseline (post-954fe8f + the gap-#2 fix): **197-file
corpus total 803 ERROR nodes** (was 1352 after the `!!` fix, 1401 at
pre-session HEAD), **errFiles 35**, **0 action-table overflows** (max
action id 64620, 2915 under the 65535 ceiling), corpus tests **82/82**.
(The older figures below — 76/76, 2039 across 151 files, etc. — were
measured on smaller file selections and are superseded by the above,
which is apples-to-apples against the previous grammar on identical file
lists.)

## Root cause: the 65536-entry action-table limit

Every "fragile equilibrium" regression below has the same *mechanism*:
the generated `src/parser.c` encodes action ids in 16-bit fields, so any
change that grows the LALR automaton past **65536 actions** silently
corrupts the table. The symptom is not a build error — `tree-sitter
generate` still exits 0 and `cc` succeeds with hundreds of
`unsigned conversion from 'int' to 'short unsigned int' changes value
from '65536' to '0' [-Woverflow]` warnings — but every file, even
`module t`, wraps in a top-level ERROR.

**Verified trigger:** extending the `constructor` token to accept
`_`-prefixed names (`/_[A-Z][a-zA-Z0-9_'`]*/`, `_TypeFixedVar` in
`_SystemDynamic.dcl` is otherwise a genuine gap) produced **349 overflow
warnings** and broke every file in the suite. Reverting restored 0
warnings and the 1833 baseline exactly.

This means the grammar is near a hard tree-sitter generator ceiling, and
it is the reason token-level fixes (`!!`, `=:`, continuation bindings,
`_`-constructors) keep failing *globally* rather than locally. Closing
gaps from here requires either reducing the automaton elsewhere to buy
headroom, or migrating to a tree-sitter version that widens the action
encoding — not adding more tokens.

---

## 0. Fixed in v1.2.1 — qualified / constructor-subset / derive imports

The three import constructs that failed on Eastwood (the subject of
clean-lang.org issue #15) now parse. All three are additions to
`import_declaration` / `_import_item`:

- `import qualified M` / `from M import qualified x` — `optional("qualified")`
  in both branches. (`qualified` was verified to never occur as an
  identifier in any corpus, so reserving it is safe.)
- `:: MaybeError (Ok)` / `:: MaybeError (Ok, Err)` — constructor-subset
  imports. Implemented as a dedicated named rule `constructor_subset`
  (`(` + `constructor` + `, constructor` ... + `)`). Two things make it
  work: the names are CAPITALIZED constructors (`Ok` lexes as
  `constructor`, not `identifier` — the first attempt with `identifier`
  silently never fired), and the dedicated named rule keeps its `(` shift
  isolated from the shared `parenthesized_name`/paren states, exactly like
  the pre-existing `class_method_name` trick. (An inline `seq("(", ...)`
  in the choice never shifted `(` at all.)
- `from M import derive gName Type` — a `derive` import item with the
  generic name as `identifier` and the derived type as a single
  `constructor` (every real-world use is a plain constructor name).

**How they fit the 65536-entry budget:** extracting the shared
`_record_pattern_members`/`_record_pattern_member` helpers from
`record_pattern` (plus the `[$._record_pattern_member, $._expression_atom]`
GLR conflict) restructured the automaton and bought the headroom — the
same additions cost 476 overflows WITHOUT the refactor and 0 with it. The
refactor is behaviour-neutral (all 55 pre-existing corpus tests pass
unchanged; the extraction mirrors the field-list helper `record_update`
already used). This is the "reduce the automaton elsewhere" path the
intro promises, and it is the first verified success of that approach.

---

## 1. ~~`!!` and other `!`-containing operators~~ — FIXED

`!` is the strictness marker (`!x`), strict-field-access marker (`r!f`),
and part of list markers (`[!a]`, `[a:b!]`), so it is deliberately excluded
from the generic `operator` charset (`/[~%^*+\-\\<>\/?|$]+/`). Bare
`xs !! i` (the stdlib's `(!!) infixl 9` list index) failed to lex as an
operator.

**Real code:** `args!!0`, `listItems!!r`, `therow!!c`, `fs!!(` — 20 bare
uses across Clyde/cleantools. The parenthesized form `(!!)` in definitions
already lexes via `parenthesized_operator`'s charset
(`/[~%^*+\-\\<>\/?!#$&=@.:|]+/`).

**Failed approach (pre-v1.2.4) — dedicated `operator_bang_bang` token
(`!!`, prec 1):** added to `binary_expression` and/or `_operator_symbol`.
Fixed Foundation.icl's whole-file wrapper (caused by `args!!0`) but the
NEW token's presence in expression states tipped recovery in unrelated
files: PmEnvironment.icl 0 → 160, IdeState.icl 21 → 180, PmFiles.icl 8 →
117, PmDirCache.icl 232 → 247/265. Net suite result: worse. Reverted.

**Why it failed:** the new token adds a shift action to every expression
state, and error recovery (which searches states for one that can shift the
lookahead token) finds these new states instead of the intended resync
points, causing the whole-stack pop that wraps the file in one `ERROR`.

**v1.2.4 fix:** reuse the EXISTING `!!` token (it was already a symbol —
`anon_sym_BANG_BANG` — for the bare list constructor `[!!]`) instead of
creating a new one. Adding `prec.left(PREC.EXPONENT, seq($._expression,
field("operator", "!!"), $._expression))` to `binary_expression` (the
`infixl 9` tier) makes `args!!0` a `binary_expression` with NO new
symbol, so the lexer DFA is unchanged and error recovery is unaffected in
unrelated files. `[!!]` still parses as the empty strict-list constructor
(the `!!` in list-header position wins, and the operator requires an
operand either side). Corpus: **1352 vs 1374 committed (−22), 0 files
regressed** — Foundation.icl −20 (its `args!!0` whole-file wrapper is
gone), PmCleanSystem.icl −2; the previously-regressed files
(PmEnvironment, IdeState, PmFiles, PmDirCache) are unchanged. Max action
id 62138. New corpus test covers `args!!0`, `l!!child`, `[!!]`, and the
`a + b !! c` precedence nesting.

## 2. ~~Same-column continuation bindings in `#!` / `#` groups~~ — FIXED (post-954fe8f)

A `#!` (or `#`) let-before group whose subsequent bindings drop the `#`:

```clean
#! (delegate,env) = applicationDelegate env
    (wctrl,env)     = msgC_P "ConsoleController\0" "alloc\0" env
    env             = setAction but "hideConsoleWindow:\0" env
```

The `#` applies to the whole group. This is pervasive in Clyde
(Console.icl, outlineviewcontroller.icl, PmEnvironment.icl, ...). When the
value is a simple application the group **misparses without errors** — the
continuation `(wctrl,env)` is absorbed as an extra application argument and
the following `=` becomes a stray `guard_body`. When the value is a
`case`/`let` (which forces a layout level), the group **errors** and can
pop the whole stack:

```clean
result = case userdata_ of
            0 -> outlineViewChildOfItem self cmd ov nn it
            1 -> outlineViewObjectValueForTableColumnByItem self cmd ov nn it
result_ = writeInt result_ 0  result
| result_ <> result_ = undef
= force env (toInt 'p')
```

This is the main source of outlineviewcontroller.icl's residual errors
(127 vs 96 at HEAD) and the same-column variant of PmDirCache's.

**Root cause:** after a binding's value (`g world`), the parser sits in an
application-continuation state that does not request
`LAYOUT_SEMICOLON`. The scanner only emits tokens the parser requests, so
the next line's identifier is lexed as an application argument before the
grammar ever sees a member separator.

**Failed approach A — `continuation_binding` rule (`pattern = expr`) added
to the guard-list member choices:** enabled the probe but polluted the
automaton (StdPathname.icl 6 → 27, UtilDate.icl +1). Reverted.

**Failed approach B — A + a GLR conflict
`[$.application, $.continuation_binding]`:** the conflict applies to every
state where the two rules co-occur, i.e. essentially every application in
every file → GLR version explosion. Suite total went 1871 → **7660**.
Reverted immediately.

**Failed approach C — scanner peek for `pattern =`:** the scanner cannot
emit `LAYOUT_SEMICOLON` when the parser does not request it
(`valid_symbols`); forcing it would be rejected. Requesting it requires the
reduce action that only the (exploding) conflict provides.

### FIXED — the GLR `_binding_tail` structure (post-954fe8f)

The winning structure sidesteps all three blockers by giving the group a
**live GLR fork** instead of fighting the repeat machinery:

- The binding branch (in both `function_declaration` and
  `case_alternative`) becomes `guard_binding` + `optional(with_block)` +
  `[$._binding_tail]` where `_binding_tail` is a **named recursive rule**
  (`_binding_member` followed by either `_binding_tail` or an
  end-alternative), self-paired in `conflicts` as `[$._binding_tail]`.
  The self-conflict keeps the recursion a live GLR fork, so at each member
  boundary the parser explores BOTH paths (continue the group / end it) in
  parallel until the input decides — this is what makes the **second and
  later** continuations work (blocker 1). `prec.right` on the tail+END
  sequence makes the END-shift beat the function-reduce so a guard/body
  after the group binds to the group's function (blocker 2).
- `continuation_binding` (`pattern = expr`, no `#`) is a member of the
  group. Its pattern set is **restricted to the 7 shapes found in the
  corpus** — identifier, tuple, list, paren, constructor, strict, and
  `record_update_pattern` (`subdirs & [i] = ...`) — because a broader
  pattern set pollutes the post-`#` lexer state and regresses
  `_SystemArray.dcl`'s `{32#}` recovery (+17).
- The group's FIRST member uses a dedicated `_guard_binding_group` rule
  (aliased to `guard_binding` in the tree) so the group exists only in the
  binding branches, never in the shared guard-list state.
- The trailing `optional($._layout_end)` inside the `prec.right` tail
  consumes the group's dedent END — without it the corpus is 1141 (+338
  across 17 files). The `_inline_layout_start`-on-the-group variants were
  all worse (1074 / 1045): the zero-width scanner token changes the
  lexer stream everywhere and degrades recovery in deep-nested case files.

**Verified:** corpus **1352 → 803 (−549)**, **errFiles 36 → 35**, **only
regression tabview.icl 0 → 1** (see below); max action id **64620**;
82/82 corpus tests (new "Continuation Binding Group" test). Big wins:
PmDirCache 132 → 22 (its whole-file `DC_HUpdate` wrapper is gone),
PmParse 289 → 198, CloogleServer 155 → 65, Foundation 20 → 0, objc 10 → 0.

**Known residual: tabview.icl +1** — the binding branch's
`optional($._layout_end)` can consume the *enclosing* block's END: in
`instance` member lists the group's END-steal leaves the member-list
closer with nothing, producing one `MISSING ";"` (the member itself
escapes to top level, which is pre-existing at HEAD). Removing the END
optionals fixes tabview but costs +338 across 17 files — the END is worth
keeping. A scanner-level fix (only emit the group's END when the column
matches the group, never an enclosing block's) is the remaining lever.

## 3. ~~Dot-less strict array index `a![i]`~~ — FIXED

Clyde writes strict array indexing without the dot:
`subdirs![subdir_i]`, `arr![i]`. The grammar's `index_access` required
`record!.[i]` or `record.[i]`; `a![i]` misparsed as `field_access` with a
MISSING field plus a list argument (no ERROR, wrong shape).

**Failed approach (pre-v1.2.4) — `choice("!.", "!", ".")` selector (no
bare `[`):** fixed the construct but the `!` transition after expression
atoms changed recovery in Console.icl 0 → 154 and flipped PmDirCache.icl
from local errors (232) to a whole-file wrapper. Also risked breaking the
application `arr [i]` (which must stay an application — a bare `[` is a
list argument). Reverted.

**Note:** the earlier `optional("!")` + `optional(".")` variant made
`arr[i]` (no selector at all) parse as `index_access`, which is wrong —
Clean requires the `.`; bare `[` must remain application.

**v1.2.4 fix:** `index_access` now takes the selector
`choice(seq(optional("!"), "."), "!")` — the dotted `!.`/`.` or the bare
strict `!`, never a bare `[`. The bare `!` no longer regresses recovery
(verified against the pre-v1.2.4 failures; the spine-strict GLR fork now
owns the `!` transition). A second, subtler change was required:
`index_access` was added to `_record`, so `cache![mid].subdir_name`
(field access on an index result, which PmDirCache.icl uses inside a
`#`-group) chains — without it the now-correct `index_access` parse
stranded the trailing `.field` and regressed PmDirCache +5. Corpus:
**1374 vs 1378 committed** (−4, PmAbcMagic), **0 files regressed**; max
action id 61283. New corpus test covers `a![i]`, `a!.[i]`, `a.[i]`,
`a![i].field`, and bare `arr [i]` (still an application).

## 4. ~~Deeper-column continuation bindings~~ — PARTIALLY CLOSED (guard/case body blocks, post-902130e)

`# a = e` followed by a binding indented deeper than the group:

```clean
# (subdir,subdirs) = subdirs![subdir_i]
  cache             = update_dir_cache (n`,p`,m`) subdir.subdir_cache
  subdirs & [subdir_i] = {subdir & subdir_cache=cache}
```

(PmDirCache.icl's `DC_HUpdate` / `DC_HSearch`, and projdocument.icl's
`initProjDocument` guard-list bindings.) The deeper column is
indistinguishable from a multi-line application continuation at the
lexer level, so the fix needs the same member/separator mechanism as #2
plus a way to tell a binding from an application continuation. Every
mechanism tried in this pass was measured against the 197-file corpus
and rejected:

- **Scanner-side SEMICOLON at binding-shaped deeper lines** (a
  `pattern = ...` lookahead peek, excluding `#`/`|`/`=`/keyword starters
  and lines at root level). The emitted SEMICOLON is *ambiguous* in the
  LALR automaton: after `member SEMICOLON` the parser cannot distinguish
  "another member" from "the final-member closer", and it resolves to
  the closer — so the continuation escapes to top level as a fresh
  function/declaration. Measured: projdocument.icl 32→**276**, full
  corpus **1415** vs 803 (even with the `#`-exclusion and a pushed-level
  gate). The same-column case works only because the enclosing structure
  then errors, killing the escape fork; deeper lines parse as valid new
  declarations, so nothing disambiguates.
- **`continuation_binding` as a guard-body-block member** (the
  `layoutBlockMembers` choice inside `guard_equation`). Fixes
  same-column guard-body continuations (probe 3→0 errors) and
  PmAbcMagic −6, but perturbs the SHARED layoutBlockMembers automaton
  states: `_SystemArray.dcl` +17 (its `instance Array {32#} Int where`
  size annotations misparse), net 814 (+11). layoutBlockMembers is
  reused by class/instance/special/where blocks, so any member-choice
  change leaks into all of them.
- **`continuation_binding` in the four guard-list member choices**
  (function/operator/case/generic definitions). 885 (+82): confirms the
  gap-#2 warning that the shared guard-list states cannot take the
  continuation rule without polluting every expression in the corpus.

### PARTIALLY CLOSED (post-0345746) — record-update indexes + block-local continuation members

A follow-up pass combined three *additive* grammar changes (no scanner
change, no layoutBlockMembers redesign) and measured a net **−13** on
the 239-file corpus (791 vs 804), 83/83 tests, action-table ceiling
64042 (< 65535):

- **`record_update_pattern` widened to accept `[index]` fields**
  (mirroring the expression side's `update_field`, including ranges
  `[a..b]`). This closes the `subdirs & [subdir_i] = e` sub-gap
  documented above — real Clean 2.3 syntax (`# a & [i]=x` desugars to
  `# a = {a & [i]=x}`). PmDirCache's 8 array-update bindings parse.
- **`continuation_binding` added as a member of the `guard_equation`
  body block** (the layoutBlockMembers choice inside `guard_equation`)
  AND **the two case-alternative member choices** (the binding-first
  `repeat1` and the guard-first `repeat`). Unlike the four
  *guard-list* sites measured above (+82), these three sites do NOT
  share their automaton states with the rest of the corpus, so the
  pollution is small: per-file, PmDirCache 22→14, PmAbcMagic 49→43,
  and the only regression is PmDriver 31→32 (+1).

### CLOSED for guard/case body blocks (post-902130e) — scanner-side separator

The scanner half is now closed for the *guard/case body block* case
(LEVEL_KIND_START levels). At a block-member boundary the scanner peeks
each binding-shaped deeper line (a top-level `=`, outside strings/chars
and bracket nesting, excluding `#`/`|`/`=` starters and `where`/`with`
keywords) and emits a zero-width LAYOUT_SEMICOLON, letting the parser
reduce the previous member and continue the block with a
`continuation_binding`. Measured on the 239-file corpus: **791 → 731
(−60)**, 83/83 tests, action-table ceiling unchanged at 64042.

Two exclusions were essential (both measured):

- **Multi-line record values** (`x = { ... }` with the `}` on a later
  line): self-delimited by the `}`, and separating the binding disturbs
  the where-block GLR fork (PmFileInfo 4→49 without it). Single-line
  records (`subdirs & [i]={...}`) still get the separator — they need
  it (suppressing them was PmDirCache 62).
- **`where`/`with` keyword lines** (StdList +4 without it): they attach
  a nested block, never a continuation.

Wins: coloured_line 35→0, PmDriver 32→19, PmCleanSystem 9→4,
projdocument 31→29 (real `#!`-group continuation fixes), PmPath 16→14,
projactions 3→0, Process 3→2. The only regression is PmDirCache 14→15
(+1): the guard-body fix changes DC_HSearch's block member structure
and the following `setup_h` signature boundary mis-nests slightly worse
— the same GLR fork-priority class as the PmFileInfo where-block escape
above, but on a 1-error scale. The `_binding_tail`-style GLR fork at
the separator was tried on top (named `_guard_body_members` rule +
self-conflict, table 63376 < 65535) but measured neutral for PmDirCache
and +1 projdocument — reverted.

Still open: the INLINE-level case (function guard lists / where-block
member levels, e.g. projdocument's `#!`-group `ptr = malloc 16` lines).
Those levels have no `continuation_binding` member, so the separator
error-recoveries into a phantom stack (PmDriver whole-function
wrappers) and the lines remain silently swallowed as application
arguments — a pre-existing misparse, unchanged.

## 5. ~~Record update by type name: `{ T | field = value, ... }`~~ — FIXED in v1.2.3

Eastwood constructs records with the type-name pipe form (previously the
main remaining source of its errors — the whole-file wrapper in
`EastwoodCleanLanguageServer.icl` started at this definition):

```clean
{ ServerCapabilities
| textDocumentSync = {openClose = True, save = True}
, declarationProvider = True
}
```

**How it was fixed.** The pipe is a dedicated `_pipe` token (prec 2, used
for ADTs/guards/comprehensions), and `record_update` accepts
`choice("&", $._pipe)` — one rule for by-variable (`{ r & f = v }`) and
by-type-name (`{ T | f = v }`) updates, reusing the `&`-rule's states.

The blocker was the 16-bit action table. `_pipe` after an *expression*
(`{ expr | ... }`) coexists with the generic `operator` token (which
historically contained `|`), doubling the action rows in that state and
overflowing the table (976 warnings). The fix removes `|` from the generic
`operator` alphabet entirely and introduces `operator_pipe` (prec 12) for
`|`-*containing* operators (`++|`, `<|-`, `<|>`, `++||`), with a regex that
requires a leading non-`|` char so a lone `|` / `||` / `|*` never matches
it. `|` now always lexes as `_pipe` (separators) or `operator_or` (`||`).

**Verified (v1.2.3):** 0 overflow warnings; corpus 71/71 (the `=>` import,
error-handler and higher-kinded-kind fixes added 3 tests); the
maintainer's `EastwoodCleanLanguageServer.icl` dropped from **180 → 110
errors**; `{ T | f = v }` in expression, argument and tuple positions all
parse as `record_update`; total corpus errors **2948 → 2346** (−602)
across 151 files (Std* 0).

## 5b. ~~Multi-guard case alternatives: `case x of p | c1 -> b1 | c2 -> b2`~~ — FIXED in v1.2.4

A case alternative whose guard list continues on later lines (common in
Clyde's `coloured_line.icl`, `CloogleServer.icl`, `builddb.icl` and a few
Eastwood test files):

```clean
case parse_state of
	_
		| isDigit line.[i]
			-> pL {state & parse_state = Precedence} end
		| isLower line.[i]
			-> pL {state & parse_state = Other} end
```

The continuation guard (`| c2 -> b2` after a completed `| c1 -> b1`) sits
in a deeper layout block. Before v1.2.3 the `|` lexed as part of the
generic `operator` and the continuation was silently swallowed as a binary
operator of the previous body (wrong tree, no error). After removing `|`
from the generic operator, the continuation lexes as `_pipe` and errors,
**regressing 10 files by a total of +187 errors** (net across all 151
corpus files is still **-567**).

**Failed fixes (all measured):** extending `case_alternative` with a
guard-continuation `repeat` — the scanner's `_layout_start` before each
continuation is ambiguous with the case block's nested-alternative layout,
the required `[$.case_alternative]` self-conflict explodes GLR (parses hang
on even `module M`), `prec.left` resolves it but grows the table so large
parsing stalls (parser.c 55MB -> 97MB, cc takes >10min), `prec.right`
likewise grows the table (97MB), `optional($._layout_start)`-after-pattern
restructuring (to make the scanner push the guard level so the
continuation dedents like the working function case) explodes the table
by **21436 overflows**, and allowing `_pipe` as a binary operator
(restoring the old swallow) overflows by 1346.

**Root cause of the bloat:** the continuation's `_layout_start` enters the
lookahead of the case-alternative body-completion state, a high-fan-in
state reached after every guarded alternative in the grammar; any
acceptance of `_layout_start` there forks its reduce paths globally. The
scanner cannot distinguish the case continuation (deeper `|`-line after a
completed body, stack top = case block) from a function's nested guard
(deeper `|`-line after a condition, same stack shape) — both emit
LAYOUT_START from an identical indent state. A real fix needs the
`_layout_start` ambiguity resolved at the scanner level or table headroom
from a larger refactor.

**v1.2.3 partial mitigation:** `=>` error-handler definitions now parse
(`name => expr` as a function body), and the old-style `=>` imports parse,
which cut two of the ten regressed files (builddb 42 -> 31, CloogleServer
53 -> 52) and improved Eastwood by a further 15.

**v1.2.4 investigation — the cost is quantified, and it is a pure
action-budget wall, not a grammar-design problem.** Every structural
variant of the continuation was measured (max generated action id vs the
65535 limit; the released v1.2.3 grammar sits at **64932**, headroom
**603**):

| Variant (all on the v1.2.3 baseline) | max action id | delta |
|---|---|---|
| baseline (v1.2.3) | 64932 | — |
| `prec.right(2)` on the plain guard branch (no continuation) | 63310 | **-1622** |
| + inline `repeat(seq(_pipe, cond, arrow, body))` | 74480 | +9548 vs plain |
| + inline repeat with bare-`->` multi-body option | 79265 | +15955 |
| + `case_guarded` rule + repeat (continuation isolated) | 78712 | +15402 |
| + `repeat(_pipe)` (bare pipe only, isolates the token cost) | 73145 | +9835 |
| + `repeat(arrow)` (bare arrow only) | 76575 | +13265 |
| nested-body-block (pushes the guard level, continuation dedents) | 82629 | +17697 |
| same, `prec.right` instead of GLR | 79720 | +14788 |
| same, single-member block + GLR | 81733 | +14801 |

Key facts established:

1. **The token acceptance after the case body is the whale.** Adding
   `_pipe` (or `arrow`) to the body-completion state costs ~**10-13k**
   actions because that state is shared with every expression completion
   in the grammar; the merged states all get new action signatures. No
   structural rearrangement (separate rule, isolated states, pushed
   blocks, GLR vs precedence) avoids it.
2. **`_layout_start` acceptance is even worse** (97MB tables, generate
   timeouts, GLR hangs) — confirmed again.
3. **The escape hatch does not exist yet:** tree-sitter **0.25.1** (latest
   CLI, 2026) still generates `const uint16_t *parse_table` — the 16-bit
   action encoding is unchanged since 0.24.7. Upgrading the CLI does not
   widen the ceiling.
4. The only measurable saving found is `prec.right(2)` on the case guard
   branch (~1.6k actions, by resolving existing GLR forks statically); it
   is far short of the ~10k needed.

**FIXED in v1.2.4 — the zero-action-cost solution.** The winning structure
reuses the function machinery instead of building new states: the case
alternative's binding branch (branch 3) gained a *guard-first* variant —
`pattern` then `guard_equation` (the function's own rule) then an optional
repeat of guard bindings/bodies/equations. `guard_equation` already pushes
its body block (`| cond` + `_layout_start` + deeper `->`/`=` bodies +
`_layout_end`), so the scanner delivers a continuation guard as a dedent +
direct `|` — no new `_pipe`-after-body acceptance is needed anywhere.
Measured cost: **+108 actions** (max action id 64932 -> 65040), resolved
by `prec.left(1)` on the branch (no GLR conflict). The tree is the
semantically correct shape: one `case_alternative` holding one
`guard_equation` child per guard.

**v1.2.4 verification:** 0 overflows; corpus 73/73 (+2 regression tests:
multi-guard alternative, module alias); total **2346 -> 2236** (−110, net
**−712** vs v1.2.0) with **0 files regressed** vs v1.2.3 — coloured_line
115 -> 35 (now *better* than v1.2.0's 55), CloogleServer 200 -> 191,
PmCleanSystem 55 -> 45, Pass_DocError 19 -> 8.

## 6. ~~`=>` qualified imports and `as` aliases~~ — FIXED in v1.2.3 + v1.2.4

**Status: fully fixed.**

- `import M => qualified x, y` (the old qualified form, 5 real uses:
  CloogleServer.icl, builddb.icl, Symbol.icl, test_LanguageServerTests.icl,
  StdOverloadedList.icl's error handler) now parses as a proper
  `import_declaration` with the `=>`-listed items. The `qualified` marker
  is an anonymous keyword (dropped from the tree), consistent with
  `import qualified M` and `from M import qualified x` — verified the
  trees are identical in shape to the other qualified forms.
- `name => expr` error-handler definitions (StdOverloadedList.icl's
  `subscript_error => abort "..."`) now parse as a function with an `=>`
  body instead of the old silent mis-parse (`name = > expr`).

**v1.2.4: the `as` alias form is fixed too.** `import qualified M as N`
(3 real uses: CloogleServer.icl, PmCleanSystem.icl, Pass_DocError.icl)
now parses with `module` and `alias` fields, via an import-context literal
`"as"` — the same mechanism as `qualified`: `as` is only a literal in the
import state, so stdlib parameter uses (`zip2 as bs`) lex as identifiers
and are unaffected (verified). Cost: +96 actions (max action id 65040 ->
65136, well within budget).

## 7. ~~Single-quoted qualified names: `'Data.Error'.isError`~~ — FIXED in v1.2.2

**Status: fixed.** Eastwood (and a handful of Clyde/cloogle files) write
module-qualified names with the module in single quotes: `'Data.Error'.isError`,
`'Data.Error'.Ok`, `'Clean.Types'.Type`. **224 uses** (214 Eastwood, 6 Clyde,
4 cloogle) in expression, type-signature, and pattern positions
(`'syntax'.PD_Function pos id`). This was the biggest remaining source of
Eastwood's errors after the v1.2.1 import fixes; it is now parsed in all three
positions.

**How it fits:** the token design from the v1.2.1 investigation was correct —
one token `single_quoted_name` (`'` + module + `'` + `.` + member) lexes
`'Data.Error'.isError` by longest-match over the char literal `'D'`, while
lone `'a'`/`'D'`/`'\n'` stay chars. The blocker was the 65535-action ceiling:
the token adds ~17 distinct parse actions with only ~8 free (9 overflows).
The winning lever, found and measured this session:

**Merge the two boolean literals into one token.**
`boolean: choice("True", "False")` (two anonymous tokens) became
`boolean: token(prec(1, choice("True", "False")))` — one named token. Two
critical findings made this safe:

1. **The naive merge is a generator trap.** `token(choice("True", "False"))`
   and `/True|False/` both generate a `boolean` symbol with *zero* lexer
   acceptance — `True`/`False` silently fall through to `constructor`, a
   tree-shape regression. Only `token(prec(1, choice(...)))` produces a
   properly lexed token. Verified directly in the generated `ts_lex` DFA
   (ACCEPT_TOKEN(sym_boolean) present only with `prec`).
2. **The merge is behavior-neutral** in every position: expression `x = True`
   stays `(boolean)`; pattern `f True = 1` stays `(constructor_pattern
   (constructor))`; `data Bool = True | False` keeps its pre-existing shape —
   byte-identical trees vs. the old grammar on all boolean probes. The corpus
   tests lock this in.

**Wiring:** `single_quoted_name` is in `_expression_atom`, `_type_atom`, and
as an alternative head of `constructor_pattern` (so pattern arguments like
`'syntax'.PD_Function pos id` follow it). A bare-atom entry in `_pattern` was
tried and removed: it competed with `constructor_pattern` and made the parser
reduce before seeing arguments (a GLR state-merge artifact); `constructor_pattern`
with a zero-argument repeat covers bare usage.

**Measured impact (same file lists, HEAD vs new, 0 table overflows):**

| Corpus | HEAD | New |
|---|---|---|
| Corpus tests | 60/60 | **64/64** (+4) |
| Eastwood .icl (36 files) | 1897 | **1118** |
| Eastwood .dcl (27 files) | 131 | **65** |
| Eastwood headline `EastwoodCleanLanguageServer.icl` | 425 | **180** |
| stdenv `Std*` (25 files) | 0 | **0** |
| Clyde + cloogle (123 files) | 1786 | **1773** |

All remaining Eastwood errors trace to gap #5 (record update by type name).
Parse performance is unchanged or better (the headline file parses in ~20 ms
vs ~34 ms on HEAD — fewer errors means less error recovery).

## Regression hygiene

When experimenting, ALWAYS re-measure the full corpus suite
(`bash /tmp/regress2.sh <mine.so> <head.so>`) and compare against the
committed baseline (**1833**). A construct that parses in isolation but
moves the suite total up is a regression, not a fix. Also check for the
overflow corruption above: `cc ... 2>&1 | grep -c overflow` must be **0**
before trusting any measurement. The head reference parser can be rebuilt
with:

```bash
git worktree add /tmp/ts-head HEAD
cd /tmp/ts-head && ln -s /home/ishaq2321/tree-sitter-clean/node_modules node_modules
npx tree-sitter generate && cc -shared -fPIC -O2 -I src -o /tmp/clean_head.so src/parser.c src/scanner.c
```

## 7. New fixes in 716051f (post-v1.2.3, for v1.2.4)

Verified on the full 151-file corpus (0 regressions, 0 overflows, 76/76
corpus tests, deterministic):

- **`class` import member lists** — `class Text(concat,join,toLowerCase)`:
  `class_method_name` now accepts a comma-separated list of identifiers
  (previously only a single `(name)`).
- **Record-subset imports** — `:: ClassDef{class_ident,class_pos}`: new
  `record_subset` rule (isolated `{` shift) for importing a record type
  with only listed fields.
- **Backtick-operator imports** — `from Data.Func import ..., `on``: the
  plain import branch now accepts `backtick_operator`.
- **`(->)` / `(+)` as type atoms** — `instance Functor ((->) r)` and
  `f :: (->) a b`: `parenthesized_operator` added to `_type_atom`; the
  derive rule was simplified (its `parenthesized_operator` branch became
  redundant) to avoid the resulting conflict.
- **`derive` with comma-separated types** — `derive JSONEncode Kind, Type,
  RequestCacheKey`: name accepts constructors, types may be comma-listed.

Net effect vs v1.2.3: total **2236 -> 2039** (−197; **−909** vs v1.2.0),
PmCleanSystem 45 -> 14, Symbol.icl 109 -> 71, CloogleServer 191 -> 155,
builddb 71 -> 49, SemVer.dcl 6 -> 0, GoToModule1 33 -> 20.

### Rejected: uniqueness-typed type-synonym parameters

`:: * Input *a = ...` (PmParse:17) — extending the synonym's parameter list
to accept `uniqueness_type` / `* type_variable` (direct choice, named
`_type_parameter` rule, and prec(1)-resolved named rule) each shifted the
parse-table state for **where-block case alternatives with `?` patterns**
(`?Just infos = ... | ?None = False`), silently dropping the second
alternative and adding **+2 ERROR nodes in LanguageServerTests.icl**
(82 -> 84) for a −3 gain (PmParse −2, Symbol −1). Reverted: net loss. The
fix would need the where-block case continuation to be robust first.

### Rejected: root-level `#` bindings followed by a `|` guard

`Start w` / `# (a,b) = g w` / `| isError a` — a col-0 let-before block whose
guard comes after the FIRST binding works, but a guard after the SECOND
binding is dropped (the parser reduces the function at the repeat1
boundary). Real occurrences: CloogleServer:158 (`Start w`), test_Common.icl.
The fix needs the same repeat1-continuation state surgery as the
multi-guard wall (measured: no headroom in the 16-bit table); deferred.

## 8. ~~Spine-strict list literals: `[a:b!]`, `[b!]`~~ — FIXED

Expression-position spine-strict list literals (`_cons a b = [a:b!]`, the
stdlib's `_SystemStrictLists.icl`) errored at the `!`: the element's
`!`-shift into strict field access (prec ACCESS) beat the list-close reduce
(implicit 0), so the spine path was never taken. Types (`[#.e!]`) and
patterns (`_decons [a:b!] = (a,b)`) already worked; only expressions failed.

**Mechanism of the fix.** The conflict is a reduce-reduce at the atom —
element (`_expression`) vs. field-access record — that LALR resolves toward
the record. Extracting the anonymous inline record
`choice(atom, field_access, application)` into a named hidden `_record`
rule (shared by `field_access` and `index_access`; a separate rule for
either would make the reduce-reduce three-way and the fork never fire) lets
the fork be declared: `[$._expression, $._record]` in `conflicts`. The fork
fires only at `!` lookahead (a bare `_expression` is never followed by `.`),
so `r.f` and `[b!x]` never fork — `[b!x]` still parses as strict field
access, `[a:b!]` / `[b!]` as spine-strict. The list structure stays HEAD's
`repeat` (the recursive `_list_tail` variant that also enabled the fork
regressed error recovery in error-heavy files: projwindowcontroller 3→98,
PmPath 19→54 — measured, reverted).

**Headroom lever — removed a dead rule.** The fork pushed the action table
2 ids over the 65536 ceiling (65537). `range_expression` (`[1..10]`,
`[1,3..n]`) never fired — those parse as `list_expression` holding a
`binary_expression` with `range_operator`, byte-identical trees with or
without the rule (verified at HEAD) — and its 4232 actions were the
headroom needed: removing it from `_expression` / `_expression_atom` and
deleting the rule drops the max action id to **61305**, 4230 under the
ceiling, with **0 overflow warnings**.

**Verified (post-716051f, 197-file corpus, cache-busted vs HEAD):** max
action id 61305 (0 overflows); corpus 76/76 tests (80/80 after adding 4
spine-strict regression tests); total errors **1401 → 1378** with **0
files regressed** — `_SystemStrictLists.icl` 6→0 (both copies),
`UtilStrictLists.dcl` 3→0, `Link.icl` 16→12, `PmProject.icl` 60→58,
`UtilStrictLists.icl` 8→6. The previous 65537-attempt (same fork, no
range-rule removal) silently truncated one table entry
(`ACTIONS(65537)` → `RECOVER` on a `with`-block inline-layout state); the
corpus measured identical (1378), but it is a latent corruption — do not
ship without the headroom.

## 9. Post-v1.2.4 easy wins (487-corpus pass)

Three additive fixes measured on the 239-file corpus, **791 → 487
(−304)** from the d3d9b5f-era baseline (731 → 487 since 902130e), 83/83
tests, action-table ceiling **64767** (< 65535), 0 overflow warnings.
The only regression remains PmDirCache +1 (the 902130e boundary shift).

### 9a. Dotted field paths in record updates

`update_field` accepted only a bare identifier or `[index]`. Clean
updates any selector path: `{ r & a.b.c = v }`, `{ r & cache.[i] = v }`
(PmAbcMagic's `cache.[cache_index]`), `{ T | tde_typedef.td_name = "Bool" }`.
Added a dotted/indexed `repeat1` path to `update_field` (+27 table ids).
This alone cleared Predef's 57 → 28 and PmProject's 35 → 9 — Predef's
`builtin_classes` record list had been derailing the whole file head into
one [0,0]-[139,5] recovery ERROR.

### 9b. `{ T | default & f = v }` — explicit default record base

Predef's `{ TypeDoc | gDefault{|*|} & description = ... }`: a type-named
update whose base is an explicit default expression instead of the
implicit generic default. A full `_expression` base after the pipe blew
the action table (68180 > 65535 — the base forks against `update_field`
at every `{ r & ident`, and the `&`/`|` branch split to avoid it doubled
the damage). Restricted the base to `identifier` + optional
`kind_expression` (`gDefault{|*|}`) — the only shape the corpus uses —
for +696 ids (64765, fits).

### 9c. `<-:` array element generator

`{f x \\ x <-: arr}` lexed `<-:` as `<-` + `:` (cons) and errored —
outlineviewcontroller's comprehensions (83 errors) and CloogleServer's
(65). A dedicated `array_generator_sep` token at the same lexical
precedence as `generator_sep` (longest-match picks `<-:` whole) added to
the `generator` rule. outlineviewcontroller 83 → 2, CloogleServer 65 →
28, and smaller wins in _SystemDynamic, UtilOptions, PmPath,
projwindowcontroller, Array.

### Re-measured dead ends (post-v1.2.4, before v1.2.5)

Two further attempts at the remaining clusters, both measured on the
239-file corpus at the 487-error state and reverted:

- **`continuation_binding` in the two `function_declaration` guard-list
  member choices** (the INLINE gap — PmParse's `# x = ...` + deeper
  `y = inc x;` derail). Fixes the FindSym shape (probe 12→0) but the
  shared guard-list states pollute every guard-bearing file: **487 →
  665 (+178)** — PmParse +62, UtilStrictLists +45, StdPathname +20,
  _SystemArray.dcl +18, PmProject +13, PmAbcMagic +11. The table also
  went 64767 → 65399 (136 headroom left). This is the +82 gap-#4
  measurement, re-confirmed on the current grammar: the function
  guard-list member choices cannot take the continuation rule.
- **`_`-prefixed constructors** (`constructor: (?:[A-Z]|_[A-Z])[...]` —
  the stdlib's `_Nil`, `_Pointer`, `_TypeFixedVar`). Probe fixes and
  PmAbcMagic 32→11, PmParse −11, _SystemDynamic −7, but a lexer-DFA
  perturbation (PmProject has zero `_`-uppercase names yet +41) made the
  net **+6 regression** (493 vs 487) and turned PmAbcMagic into a
  whole-file [0,0] ERROR. The underscore-constructor gap needs a
  context-sensitive (pattern-position-only) solution, not a lexical one.

Both are recorded here so the v1.2.5 release at 487 is a known,
documented plateau: the remaining errors are these two families plus the
pre-existing `;`-chain and _System-module issues — none reachable by an
additive change without breaking the shared automaton states.

## 10. Headroom audit (2026-09-21, bbcaa9f) — four measured dead ends

A targeted hunt for cheap action-table headroom, run because the 16-bit
ceiling (max action id **64767**) is what blocks the lexical `_`-constructor
fix. Metric: `grep -oE "ACTIONS\([0-9]+\)" src/parser.c | … | tail -1`,
same as every earlier measurement; safety check `cc | grep -c overflow`.
All five probes were measured on the tagged v1.2.5 grammar.

| Probe | Result | Max action id |
|---|---|---|
| Remove the 7 "unnecessary conflicts" declarations | `parser.c` **byte-identical** | 64767 (0) |
| Remove the dead `_context_head` rule (0 references) | pruned by the generator | 64767 (0) |
| Remove 9 duplicate alternatives from `_expression` (also reachable via `_expression_atom`) | tables change | 64767 (0) |
| Make `operator_or` an **anonymous inline token** (same lexing, same precedence, no named node) | tables change | 64767 (0) |
| Delete the whole `operator_or` tier (`binary_expression` alternative only) | **−606** | 64161 |

What this establishes:

1. **Declared-conflict and dead-rule cleanups are free but buy nothing.**
   Unreachable rules are pruned before table construction, and a conflict
   that never fires never added states. (Hygiene only: the 7 declarations and
   `_context_head` were removed so `tree-sitter generate` is warning-free.)
2. **Max action id is insensitive to symbol identity and to choice
   duplication.** Reordering/canonicalising alternatives (9 duplicates removed
   from `_expression`) and renaming a named token rule to an anonymous token
   both changed `parser.c` bytes yet left the id at 64767. Only removing the
   token's *acceptance in expression-completion states* moved it.
3. **The per-tier operator tokens are load-bearing and their ~600 actions/tier
   are irreducible.** The tiers exist to encode precedence lexically (`2 + 3 *
   4` nests by token class, not by lookahead); with a single token class the
   parser cannot know `*` binds tighter than `+`, so the tier cannot be
   dropped, and (2) shows it cannot be made cheaper by renaming.
4. **Removing an operator's own tier is not a viable trade**: −606 actions
   but `||`/`or` stop parsing entirely.

The historical big win (`range_expression`, −4232, §8) was a *reachable but
shadowed* named rule whose parses were identical to paths that already
existed — a lucky structural redundancy, not a repeatable pattern. The four
probes above found no second one.

**Consequence for the remaining gaps.** Neither outstanding family is
actually headroom-blocked:

- the INLINE continuation family *fits* (its attempt reached 65399, under the
  ceiling) — it fails on shared-state pollution (+178 corpus errors), so it
  needs state **isolation**, not headroom;
- the `_`-constructor family needs a **context-sensitive** solution
  (pattern-position-only), which is cheaper than the lexical regex that
  overflowed.

So the next productive move is isolated-state/context-sensitive designs for
those two families — not further automaton re-engineering.

---

## 11. Post-audit fix pass (2026-09-21, after 7a42e3a): 1013 → 676

Measured with the same gate (`scripts/corpus_regression.py`, 312 real-world
files, ERROR+MISSING, cache-free parser built from `src/`), the same metric
commands (`ACTIONS(N)` max action id, `cc | grep -c overflow`), and
`npx tree-sitter test` for the 98 corpus tests. Starting point: the checked-in
v1.2.5 baseline of **1013** problem nodes; **676** after this pass (**−337,
−33%**), **32 files improved**, **1 file regressed by +1** (see the open item
at the end). Max action id **64913** (< 65535, 622 spare), **0 overflow
warnings**, generate warning-free.

### 11a. Qualified name as a constructor-pattern ARGUMENT — FIXED

`constructor_pattern` accepted `single_quoted_name` as its HEAD but
`_pattern_atom` (the argument position) did not, so
`('syntax'.PD_Function pos id _ _ {'syntax'.rhs_alts=...} 'syntax'.FK_Caf)`
derailed the whole definition (BasicValueCAFs 13 → 2, then 0 with 11d).
Adding `$.single_quoted_name` to `_pattern_atom` **reduced** the max action id
(65056 → 64879): a new atom in an existing choice can merge states rather than
add them.

### 11b. `[a..]` / `[a,b..]` — open-ended ranges — FIXED (bracket-scoped)

Clean has infinite enumerations (Cloogle's own syntax reference lists `[i..]`,
`[i..k]`, `[i,j..]`, `[i,j..k]`; 32 corpus lines use them). `range_expression`
required both endpoints.

**Dead end (measured):** making the endpoint optional in `range_expression` —
the general fix — scored **731 → 740** overall and blew up `PmDriver.icl`
**18 → 56**: a range that may complete right after `..` *anywhere* lets a
finished expression swallow the following definition. The shipped fix offers a
dedicated `open_range_expression` rule **only in the list/array element
position** (`list_expression`), which is the only place Clean allows the form:
**719 → 676** with **0 regressions** (9 files improved, incl. outlineview-
controller 5 → 2, PmDriver 18 → 17).

### 11c. Array type CONSTRUCTORS `{!}` / `{#}` / `{32#}` — FIXED

`array_type` required an element type, so the same braces could not stand
alone as a type argument — which is exactly how every `_SystemArray` and
`_SystemDynamic` instance head is written (`instance Array {!} a where`,
`instance Array {#} Int where`, `instance Array {#} {#.a} where`). Each head
failed with a missing argument and cascaded through the module:

| file | before | after |
|---|---|---|
| `clean-stdlib/_SystemArray.dcl` | 27 | **0** |
| `clean-stdlib/_SystemArray.icl` | 21 | 12 |
| `Prelude/Data/Array.dcl` | 2 | **0** |
| `Prelude/Data/Array.icl` | 3 | 1 |

Making the element type `optional` in `array_type` scored **719 → 676**
(−43, 7 files improved, **0 regressions**).

### 11d. `mod` / `rem` are names, not operator words — FIXED

`operator_mul` included `"mod"`/`"rem"`. Those are prelude **functions**
(`infixl 7 mod`), so a parameter or argument named `mod` at the end of a
definition body lexed as the *operator* and swallowed the next line as its
right operand — `diag severity lines mod` followed by `where` even lexed
`where` as an identifier. Dropping both strings fixes the pattern
(BasicValueCAFs 13 → 0; builddb 6 → 2, Cache 11 → 7, PmDirCache 4 → 3) and
costs nothing in the tables (max action id unchanged). `x mod y` now parses as
the application it is in Clean's prelude.

Consequence: the fixity *report* form (`infixl 7 mod`) needed an `identifier`
in its operator slot — Clean declares fixity for functions, not only for
symbolic operators (previously `infixl 7 div` was broken for the same reason).

### 11e. Measured dead end: closing a layout block mid-line (scanner)

A `case` whose alternatives start on a deeper line but whose block ends at a
delimiter on the SAME line (`(\port opts -> case (toInt port, port) of ...
Ok {Options | opts & port=p})`) can only be closed by an inserted MISSING
layout token, so the scanner's indent stack keeps the level the parser already
closed. The next line is then measured against a stale level, gets a spurious
`LAYOUT_END` where the sibling `LAYOUT_SEMICOLON` was needed, and the following
declaration is swallowed as an application argument.

**Attempted fix (reverted):** emit a real zero-width `LAYOUT_END` and pop the
level when the parser asks for one at a mid-line position with a closing
delimiter next. It fixes four minimal probes and **regresses the corpus
(751 → 767; `CloogleServer.icl` 22 → 35)** — the stale level turned out to be
load-bearing for the existing corpus (with it popped, the *next* dedented list
line gets a spurious `LAYOUT_START` instead). A follow-up guard against
`LAYOUT_START` at a continuation/comma token measured identically (that state
never requested one). Not re-tried without a corpus-wide layout invariant.

### 11f. Open item: `if c a b.[i]` inside a comprehension (+1 file)

`Clyde/cleantools/Pm/PmPath.icl` is **8 → 9** (one extra node in an
already-broken region; four of the region's five nodes were there before).
Minimal repro:

```clean
p9 = [if (c) a b.[i] \\ i<-[0..n]]
```

The function form of `if` outranks access (13 > `PREC.ACCESS` 11) so its
alternative reduces at the `.`, stranding the access (`index_access` is then
rebuilt with a MISSING record) and `\\` lexes as the generic `operator`
instead of `comprehension_sep`. Confirmed **pre-existing** (the same probe
fails at HEAD), and two cheap levers were measured and rejected: a
`[$.if_expression, $.index_access]` conflict (the generator reports it
*unnecessary* — no shift is even considered) and `PREC.ACCESS` 11 → 14
(**byte-identical tables**, so the precedence pair is not what decides it).

## 12. The metric itself: problem nodes can LIE (2026-09-21, after b5413c1)

### Problem nodes collapse when recovery gives up on the whole file

Error recovery, when it cannot resynchronise, wraps a region — or the entire
file — in **one** ERROR node. Node counts then *improve* while the tree
degrades into garbage:

```
(ERROR                                <- one problem node...
  (module_declaration ...)
  (import_declaration ...)
  ...                                <- ...around the whole file
```

Measured, this session: a `guard_head` alternative (a `| cond` whose
bindings/body are sibling members at the guard's own column) plus per-parameter
uniqueness in `type_definition` took **PmParse.icl 193 → 10 problem nodes** —
which reads as a triumph — while `PmParse.icl` stayed *wrapped* (one ERROR over
lines 107–1426) and the corpus error bytes went **261,241 → 1,030,861**
(a 4× downgrade: PmDriver +78,036, PmProject +39,165, coloured_line +30,832,
…). Reverted in full. A node count of `1` is not "almost clean" — for a
1300-line file it is the worst possible parse.

The same discipline applies to every fix below: a change that shrinks a
problem count while growing error bytes is a downgrade, and both
formulations rejected in this section claimed a smaller number for the file
they targeted.

### The gate now measures three things per file

`scripts/corpus_regression.py` reports and enforces, per file:

- **problem nodes** — ERROR + MISSING (as before);
- **error bytes** — source bytes inside ERROR/MISSING nodes (union of ranges),
  which a wrapping ERROR cannot hide;
- **wrapped** — one *top-level* ERROR covering ≥50% of the file, i.e. recovery
gave up on the FILE rather than on a construct.

The gate fails on any of the three getting worse. `scripts/corpus-baseline.tsv`
is now `path<TAB>nodes<TAB>bytes<TAB>wrapped` (a 2-column baseline still loads;
the byte checks are then reported as skipped rather than silently passing).
Verified by doctoring one baseline line (PmParse bytes 56599 → 1): the gate
fails with `bytes 1 -> 56599; newly wrapped` and exit code 1.

### Honest baseline after b5413c1

| metric | value |
|---|---|
| problem nodes | 676 |
| error bytes | 261,241 (17% of 1,460,707 corpus bytes) |
| error bytes, excluding the 100 KB synthetic fixture `tooLarge.icl` | 161,239 (11%) |
| wrapped files | **4** |

The four wrapped files are the real remaining work, and they are exactly the
ones that matter to the users who filed the issues:

| file | nodes | error bytes |
|---|---|---|
| `eastwood/test/LanguageServerTests.icl` | 9 (was 89) | 62,593 |
| `Clyde/cleantools/Pm/PmParse.icl` | 193 | 56,599 |
| `clean-stdlib/_SystemDynamic.icl` | 21 | 17,663 |
| `eastwood/test/suite-default/someLib/TestModule.icl` | 3 | 152 |

(`LanguageServerTests.icl`'s node count dropped 89 → 29 → 9 from the `=.=` and
strict-comprehension fixes below while its error bytes did not move at all —
the numbers in that row are the reason the metric had to change. Its wrapper
is now caused by exactly ONE construct, at line 1217.)

(`tooLarge.icl`, 100,002 bytes in 2 nodes, is a 5-line fixture holding a
single-line 100 000-element list literal, written to overflow cocl's stack —
not a grammar gap.)

**Re-validated:** the §11 fixes were measured under the *old* node-only metric
(1013 → 676). Under the byte metric they hold up: `bbcaa9f` → `b5413c1` is
285,752 → 261,241 error bytes, and every file is equal or better except
`Symbol.icl` (+81 bytes for −50 nodes — the one file where a node-count
improvement partly wrapped).

### Re-measured dead ends (byte metric)

- **`guard_head`** — a `| cond` with no body of its own, as a sibling member of
the block it sits in. It parses the jagged guard chains
(`| c1 / # a = 1 / | c2 / # b = 2 / = b`, 141 such same-column `|`-after-`#`
pairs in the corpus) and fixes two minimal probes, but it re-resolves the
parse table for every guard list: 23 files improve on *nodes* while 67 lose
their whole-file structure, error bytes go ×4, and generation slows from
~2m06 to ~2m39. Reverted.

  The narrower `optional(...)` on `guard_equation`'s body (the obvious
  formulation) does not finish generating in 180 s at all — the same
  table-explosion class as the §7 rejections.

- **Per-parameter uniqueness in `type_definition`** (`:: * Input *a = …`) —
  re-attempted with a `_type_parameter` rule, the form §7 already records as
  rejected. Confirmed again: `PmParse.icl` 193 → 191 nodes and still wrapped,
  because the file's failure is *not* the type head — its head parses once the
  rule exists; the file's collapse is the guard chain above. The grammar's own
  comment at `type_definition` already describes the intended syntax, so the
  rule is correct in principle and merely not worth the table shift until the
  guard chains are handled.

### Found by the byte metric: `=.=` (Data.GenEq equality) was never lexed

Region-level bisection of the largest wrapped file (parse `head -N` for every
N, report where problems first appear) put `LanguageServerTests.icl`'s derail
point at line 318, not at the `where`/`#`-binding shapes the node counts had
pointed at:

```clean
= ( name "all expected symbols and kinds are generated" (validSymbolMap symbolMap =.= True) /\
    name "all expected comments are generated" (commentResults symbolMap =.= expectedCommentResults)
  , world
  )
```

Minimal repro (`f x y = (x =.= y) /\ (g x =.= True)`, and even
`f = a =.= b`) failed: `=.=` is not in the catch-all `operator` alphabet, which
only covers `[~%^*+\-\\<>/?$]+`. `=.=` cannot be lexed by that alphabet at all,
because the run contains a `.` — and `.` must stay its own token for qualified
names (`Data.List.map`) and field access (`r.f`). So the operator needs a
spelling of its own; it is now a choice in `operator_compare` (a TOKEN added to
an existing choice, which is the free direction).

Measured: `LinterTests.icl` **10 → 0** (378 → 0 error bytes), the corpus
606 nodes / 260,863 bytes, no file worse, and the real Eastwood fragment above
parses clean with both `=.=` operands and the multi-line `/\` chain. In
`LanguageServerTests.icl` the *first* derail point moved from line 314 to line
728 — the file is still wrapped by a *later* construct, which is why its bytes
are unchanged. Two corpus tests cover the operator (plain conjunction and the
multi-line `where`-block shape).

The follow-on target is therefore `LanguageServerTests.icl:728–755` (a
`where`-block function whose `#` binding value spans four lines through `$`
and a nested `where`, plus a `= ( ExistsIn ... )` body at column 4) — 62,593
error bytes, 24% of the corpus total, in one wrapper.

### From the byte metric: strict list comprehensions were MISparsed

Continuing the same region bisection past the `=.=` fix put
`LanguageServerTests.icl`'s next derail point at line 768:

```clean
# locations = [! fAndLn \\ fAndLn <- Map fileAndLineToLocation filesAndLineNumbers | isJust fAndLn !]
```

`list_comprehension` accepted only `[` + `optional($._pipe)` + body, while
`list_expression` accepts `!`, `!!`, `#`, `#!` and `|` after the bracket and
`array_comprehension` already accepted `!`/`#`. So a strict list
comprehension was never a comprehension: `[! fAndLn \\ fAndLn <- ls]` was
parsed as a **two-element list** whose first element was the unary expression
`!fAndLn` with a generic `\\` operator (element separators are optional, so
nothing rejected it — a silent wrong tree, worse than an error), and the
moment the comprehension GUARD `|` appeared the parse collapsed.

The rule now takes the same leading markers as `list_expression` plus the
spine-strict `!` close. Minimal repros (`[! x \\ v <- ls | isJust v !]`,
`[! x \\ v <- ls | isJust v]`) parse as `list_comprehension` with a generator
and a guard; `LinterTests.icl` was already clean and the corpus moves
606 → 586 problem nodes with no file worse. Two corpus tests added.

### Open item: let-before bindings inside a lambda (`\w` / `# …` / `-> …`)

`LanguageServerTests.icl`'s remaining wrapper is now this ONE construct
(lines 1215–1225):

```clean
goToDeclarationOfStdEnvFuncWhenLibraryIsPartOfConfig =:
	accUnsafe \w
	# (currentDirectory, w) = appFst fromOk $ getCurrentDirectory w
	->	(goToTestAbsolutePaths Declaration SUITE_DEFAULT … , w)
```

Minimal repro (fails, 1 problem node):

```clean
module m

f = \w
	# y = w
	-> y
```

whereas `f = \w` / `\t-> y` and `f = \w -> y` both parse — so the gap is
specifically let-before bindings between a lambda's parameters and its
body, and the corpus contains it exactly once (the only one of the file's 80
`=:` blocks with a `#` or `->` line in it).

**Two formulations measured and rejected** (both reverted):

| shape | parser.c | generate | languageServerTests | corpus |
|---|---|---|---|---|
| baseline | 56.6 MB | 1m15 | 9 | 586 nodes |
| layout block (`_layout_start` + bindings + `optional(_layout_end)`) | 62.2 MB | 3m14 | 54 (whole file wrapped) | regressions |
| token-only (`repeat` of `guard_binding`, no layout tokens) | 60.6 MB | 4m07 | **588** | regressions |

The layout form makes the scanner push a level at a place where nothing had
gone before (the `#` line's column equals the body's first line), and the
token-only form re-resolves lambdas — the most common construct in the
language — so both lose far more than the one file they fix. `no file worse`
is the test that kills them, not the file count they claim.

### Consequence for the remaining work

Ranking the corpus by *nodes* put `Util.icl`, `PmAbcMagic`, `BasicValueCAFs`
and a long tail first; ranking by *bytes* puts **four wrapped files** first,
and they account for 52% of all error bytes. Node counts remain useful for
tree-shape regressions (MISSING tokens), but a file that is *wrapped* needs the
region-level diagnosis, not a node count.

---

## 13. `//` inside a block comment, and the `_`-constructor ceiling (2026-09-21, after 1688746)

### 13a. `*/` after `//` does not close a block comment — FIXED

Eastwood's own fixture `test/suite-default/someLib/TestModule.icl` is a module
header wrapped in deliberately hostile comments:

```clean
/* This comment // will make it harder */
 * for the module name resolver */

// module thisIsNotTheModuleHeader

/* to find the module name */ implementation   module /* */ someLib.TestModule
```

Its test (`LanguageServerTests.icl`, "hierarchical modules are correctly
compiled") asserts that **both** `TestModule.dcl` and `TestModule.icl` produce
`noDiagnostics`, i.e. the file compiles; the resolver must still find
`someLib.TestModule`. The scanner treated the `*/` on line 1 as closing the
comment, so line 2's `*/` was a syntax error and the file was wrapped
(3 problem nodes, 152 error bytes).

Clean's actual rule — a `//` inside a block comment starts a **line** comment,
so the rest of that line is inert and a `*/` on it closes nothing — is stated
verbatim in the fixture author's own comment scanner,
`eastwood/src/languageServer/Util.icl`:

```clean
| s.[i]=='/' 
    | s.[i+1]=='*' // nested multi-line comments
        = scanMultiLineComment =<< scanMultiLineComment (i+2)
    | s.[i+1]=='/' // */ after // does not close a multi-line comment
        = scanMultiLineComment (skipToEndOfLine (i+2) s)
```

`scan_block_comment_body` now implements it, so the fixture parses exactly as
intended (one `block_comment` spanning lines 1–2, the line comment, and an
`implementation module someLib.TestModule` whose header even carries its own
inner `/* */`). **3 → 0 problem nodes, 152 → 0 error bytes, wrapped files
4 → 3.**

Blast radius (measured, not assumed): across all 312 corpus files exactly
**one** single-line block comment contains a `//`, and it is this fixture, so
the two readings are indistinguishable everywhere else — which the gate
confirms: it reports this file as the *only* change.

### 13b. `_`-prefixed constructors: type names are now affordable, patterns are not

`_TypeFixedVar`, `_UnificationEnvironment`, `_Consa`, `_Justi` … are ordinary
Clean constructor/type names (`_[A-Z]`; `_[a-z]` names such as `_aconcat` and
`_value` are variables/fields and stay `identifier`). They cannot join the
`constructor` token — see the intro of this file. `_SystemDynamic.icl` has been
wrapped since before the byte metric existed, and its first derail point is
line 11, `:: _UnificationEnvironment` / `:== UnificationEnvironment`.

Measured on 2026-09-21 with tree-sitter **0.26.9** (`tree-sitter generate`,
ABI 14, which refuses to emit a parser once the action count exceeds 65535):

| formulation | action count | verdict |
|---|---|---|
| HEAD (no `_`-support) | 64620 | 915 actions of headroom |
| + `underscore_constructor` token in `type_definition` **and** `data_constructor` names (alias → `constructor`) | under 65535 | **SHIPPED** |
| + the same token in `constructor_pattern` | 66572 | over the ceiling |
| + a `prec.left` `_pattern_atom` alternative (`_Cap` + `repeat(_pattern_atom)`) | 66428 | over the ceiling |

The two shipped sites fix the whole of `_SystemDynamic.dcl` (**5 → 0** problems,
6 → 0 error bytes) and the `:: _UF :== UF` shape, cost nothing measurable
(`parser.c` 56,650,832 → 56,640,372 bytes) and regress nothing; the alias makes
the tree read `name: (constructor)`, so downstream queries cannot tell the
difference.

The **pattern** site is the expensive one and is what keeps
`_SystemDynamic.icl` wrapped (`is_valid_type (_TypeFixedVar _)`, line 40):
either formulation alone needs ~1800–1950 actions, i.e. ~1000 more than the
load-bearing 915 available. An intermediate attempt that shipped all three
sites *generated* under the repo's pinned CLI (0.24.7) but **segfaulted** the
runtime on six corpus files (`StdGeneric.dcl`/`.icl`, `GoToModule1.dcl`,
`GoToModule2.dcl`, `SymbolMapExample.dcl`/`.icl`) and regressed the
existential-record shape `:: T = E.a:` with a record body — the 65535 ceiling
must be treated as hard, whichever CLI is in use.

So the remaining `_`-constructor gap is now a precise headroom problem, not a
grammar-design problem: **buy ~1000 actions** (§10's "reduce the automaton
elsewhere" path) and `constructor_pattern` can take the third alternative.

---

## 14. The ceiling is hard, and where the cheap bytes are (2026-09-21, 9daa9ef)

A pass aimed at the remaining wrapped files. It closed one open question,
corrected the measurement method, and shipped one gap. Starting point:
**577 problem nodes / 260,705 error bytes / 4 wrapped**; pinned CLI 0.24.7
`src/parser.c` max action row id **65233** (302 spare under 65535).

### 14a. No escape hatch: ABI 15 enforces the same 65535 limit

§10 and §13b left open "migrating to a tree-sitter version that widens the
action encoding". It does not exist. tree-sitter **0.26.9** defaults to
**ABI 15** and refuses to emit a parser for the same grammar:

```
$ tree-sitter generate --abi 15
Error when generating parser
Caused by:
    Parse table action count 66572 exceeds maximum value of 65535
```

(That run is the `constructor_pattern` variant of §14c; the ceiling message is
the point.) ABI 15 does not widen the field, so no CLI/runtime upgrade buys
headroom. The 302 spare rows at HEAD are the entire budget, and the metric
that matters is the **pinned** CLI's — 0.26.9 counts differently (it reported
64620 for the same tree), so all §14 numbers are 0.24.7 numbers.

### 14b. What an addition actually costs (measured, not guessed)

Cost is **per token per state**, not per alternative or per rule (§10 probe 4
said as much for token identity; this quantifies it):

| probe (from HEAD) | rows | Δ | states |
|---|---|---|---|
| HEAD | 65233 | — | 39851 |
| `binary_expression`: 15 precedence alternatives → 1 | 58036 | **−7197** | 36149 |
| same 15 alternatives, but each precedence level's alternatives **merged into one inline `choice`** | 65233 | **0** | 39851 (byte-identical `parser.c`) |
| both operands replaced by a narrower symbol (`$.application`) | 88471 | +23238 | 54089 |
| `underscore_constructor` added to `constructor_pattern` | 66570 | +1337 | 40857 |

Three consequences:

1. **~514 rows per operator tier** (7197/14) — matching §10's −606 for
   deleting `operator_or` outright. The tiers are load-bearing (they *are*
   the precedence), so this is not a savings opportunity.
2. **Merging same-precedence alternatives is a no-op** — the generator
   expands `choice` inside a `seq` into the same productions, so
   `operator_add`/`backtick_operator`/`operator`/`operator_pipe`/
   `monad_bind`/`operator_dot` at `prec.left(ADD)` cost exactly what one
   alternative with an inline choice costs.
3. **A precedence-cascade rewrite is not the lever** either: replacing the
   broad operands with narrower symbols made the automaton *bigger*
   (+23238 rows), because a symbol's state set depends on where it is used,
   not on how small its own rule is.

The only levers are therefore (a) fewer tokens acceptable in a given state, or
(b) fewer states — and both are blocked by real language features.

### 14c. `_`-constructor patterns: closed as a dead end

§13b proposed buying ~1000 actions so `constructor_pattern` could take a third
alternative. Measured at HEAD with the pinned CLI: **+1337 rows** (66570, i.e.
1035 *over* the ceiling when the 302 spare are spent), and the variant is not
even a win —

- `clean-stdlib/_SystemDynamic.icl` still wraps (the whole file becomes one
  ERROR node: 20 → 1 problem nodes, **identical 17,663 error bytes**);
- `clean-stdlib/_SystemDynamic.dcl` **regresses 0 → 10 problem nodes**, purely
  from the token becoming acceptable in pattern-start states;
- the target shape `(_TypeFixedVar _)` is the **only** occurrence of
  `(_[A-Z]…)` in all 312 corpus files.

So headroom would have to be bought *and* spent to make one line parse, at the
cost of a file that is currently clean. Closed. (`_SystemDynamic.icl` needs
three further independent constructs anyway: `{s & [pos] = c \\ c <-: h & pos <- [i..]}`
at line 63, and the `instance … where` block from line 66.)

### 14d. Method correction: find derail points from the first local ERROR

A line-prefix bisect ("smallest prefix that fails") is **invalid**: truncating
at line *n* leaves a declaration whose `=` is on line *n+1*, which is a real
syntax error. `_SystemDynamic.icl` bisected to a bare `\t\t\t\t=\tis_valid_type type`,
a file fragment with no context. The reliable signal is the first ERROR that is
not a top-level wrapper, in the *whole* file. Doing that gives the ranking that
should drive the work (error bytes, first local ERROR):

| bytes | file | first local ERROR |
|---|---|---|
| 62593 | eastwood/test/LanguageServerTests.icl | line 728 (lambda let-before) — §12 |
| 56599 | Clyde/cleantools/Pm/PmParse.icl | guard chains — §12 |
| 17663 | clean-stdlib/_SystemDynamic.icl | 40:18 `(_TypeFixedVar _)` |
| 16461 | eastwood/src/languageServer/Symbol.icl | 1:1 wrapper |
| 1231 | clean-stdlib/_SystemArray.icl | 401:30 `{#} a` |
| 1138 | Clyde/cleantools/Pm/PmDriver.icl | 644:2 `# ds = {ds & …}` |
| 625 | eastwood/src/languageServer/Target.dcl | 55:25 `instance toString Target, Platform, …` |
| 541 | eastwood/src/languageServer/Compiler.icl | 72:21 `:: DiagnosticSource \| Compiler` |
| 519 | eastwood/src/languageServer/SemVer.icl | 47:12 `JSONEncode{\|Version\|} _ v = …` |
| 503 | Clyde/Clyde/projdocument.icl | 462:3 `&& trace_n …` |
| 465 | Clyde/cleantools/Pm/PmDirCache.icl | 94:2 `removedups :: ![DirCacheElem] -> …` |
| 391 | cloogle.org/backend/CloogleServer.icl | 158:1 `Start w` + column-0 layout |

Everything below the top four is under 1.3 KB, i.e. the long tail is ~44 KB
across ~40 files at roughly 1 KB each. **The tail is a queue of small,
independent rule gaps, not a headroom problem** — which is why §14e/§14f were
measured patch-by-patch instead of by node count.

### 14e. Shipped: ADT extension declarations (`:: T | C`)

Clean lets a module add constructors to a type it imported, and that list
starts with `|` — no `=`. Eastwood declares one per linter pass
(`:: DiagnosticSource | TrailingWhitespacePass`), so every pass module derailed
at that line. New alternative in `type_definition` (`prec.left(1)` so the `|`
shift beats the plain-abstract branch's reduce), reusing the existing
`data_constructors` rule so the tree matches `:: T = C`:

```
(type_definition (constructor)
  (data_constructors (data_constructor (constructor))))
```

Cost **+12 rows** (65245, 290 spare), 0 overflow warnings, 107 → 108 corpus
tests. Measured effect: **577 → 544 problem nodes, 260,705 → 260,010 error
bytes**, five files improved, none worse —
`TrailingWhitespace.dcl` 3 → 0 (**clean**), `BasicValueCAFs.dcl` 3 → 0
(**clean**), `Compiler.icl` 25 → 3 (541 → 1 byte), `DocError.icl` 2 → 1,
`SymbolMapExample.dcl` 10 → 6.

`DocError.icl`'s remaining byte is the file's **own** bug, not the grammar's:
line 67 `commentsContentWithLine :: ([Either (ParseError, Int) (FunctionDoc, [(ParseWarning, Int)])]))`
has four `(`and five `)`. `Compiler.icl`'s residual is a negative literal in
pattern position (`indexOfNewlineBefore -1 = -1`, line 118), a separate gap.

### 14f. Measured and rejected in this pass

| patch | rows | verdict |
|---|---|---|
| `instance toString Target, Platform, Architecture` (comma-separated instance types, Target.dcl, 625 B) | **+2252** | unaffordable — a `,` after an instance-argument type atom touches ~750 instance states |
| `import code from "NSWindow+DvA.o"` (Clyde, 116 B) | +19 | affordable, but **fires nothing**: `code` lexes as `module_identifier` (`/[a-zA-Z_][a-zA-Z0-9_'`]*/`, defined earlier) and wins the equal-length tie, so `import code` still parses as a module import. Making it work needs either a separate `token(prec(...))` for `code` — which would change keyword-vs-identifier lexing globally — or a `module_name "from" string` form, i.e. a new shift/reduce choice at a declaration boundary. Not worth 19 rows for 116 bytes; reverted. |

### 14g. Shipped: braces inside a string in a `code` block (lexer-only, 0 rows)

`abc_instruction: token(/[^{}]+/)` made the body of `code { ... }` stop at any
brace — including one **inside a quoted string**. Every
`buildAC "StdArray:select ({#} a) should not be called"` line in
`clean-stdlib/_SystemArray.icl` therefore ended the body early, left the block's
own `}` MISSING, and derailed the rest of the file: **12 problem nodes /
1231 error bytes**, with the reported errors sitting *inside string literals*,
which is the tell-tale of a lexer, not a parser, gap.

The token is now `/(?:"[^"\n]*"|[^{}])+/`: a quoted string is part of the body,
and a quote may not span a newline so an unbalanced quote cannot swallow the
rest of the block.

Because the token's *symbol* is unchanged this is **lexer-only**: max action
row id 65245 → 65245 (**0**), state count unchanged, and the tokenization of
pre-existing blocks is unchanged as well (the quoted part falls inside the same
longest-match run), so all 108 existing corpus tests pass untouched.
Effect: `_SystemArray.icl` **12 → 0 problem nodes, 1231 → 0 error bytes** — a
clean-stdlib file that now parses clean. 109 corpus tests (one added).

**Generalisation worth keeping:** a lexer-only fix costs no action rows at all,
which makes it the cheapest kind of fix available at this ceiling — and its
symptom is a reported error *inside* a literal (string/char/number), never at a
token boundary. Check that symptom before touching the grammar.

## 15. Batch before v1.2.6: four gaps, one of them huge (2026-09-21, after 601b3f4)

Corpus: **532 → 386 problem nodes, 258,779 → 157,923 error bytes** (a 39% cut),
15 files improved, none worse, 3 wrapped, 116 corpus tests, and still only **153
spare action rows**. The progression, each step measured on its own:

| step | nodes | bytes |
|---|---|---|
| baseline (601b3f4) | 532 | 258,779 |
| + capitalized generic names | 510 | 258,416 |
| + trailing `;` on guard members | 450 | 258,138 |
| + negative literals in patterns | 439 | 258,183 |
| + `'abc'` char lists | **386** | **157,923** |

### 15a. `'abc'` — Clean's "special syntax for [Char] lists" (**the big one**)

Cloogle's own syntax reference (`Syntax.icl`) states the rule:

```clean
abc = ['a', 'b', 'c']     // Individual elements
abc = ['a':['b':['c':[]]] // Head and tail, ending with the empty list
abc = ['abc']             // Special syntax for [Char] lists
abc ['abc':rest] = True   // The special syntax can als be used to patternmatch
```

A single-quoted literal of MORE THAN ONE character is a `[Char]` list, exactly
like the double-quoted form — and it is valid in patterns too. The `char` token
matched exactly one character, so `'abc'` lexed as *nothing*. What that cost:
**`eastwood/test/suite-default/tooLarge.icl` is `Start = ['111…1']`, one
100,000-character literal, and it alone was 38% of the corpus's error bytes.**
`Predef.icl`'s 123 bytes were the same shape (`['1,1,2,3,5':s]`), as were
`PmAbcMagic.icl`'s 177 and `UtilOptions.icl`'s 29.

Fixed as a new `char_list` token (two or more *units*, a unit being a plain
character or an escape) added wherever `char` already is: `_expression_atom`,
`_pattern_atom`, `_pattern`. One character still lexes as `char`, and
`'Data.Map'.toList` still lexes as `single_quoted_name` because that token is
longer — the §7 fix is untouched (there is a corpus test for exactly that). In
the same edit the `char` regex stopped allowing a quoted character to span a
newline, so an unbalanced `'` can no longer swallow the rest of a file.
Measured effect of this change alone: **439 → 386 problem nodes, 258,183 →
157,923 error bytes**; `tooLarge.icl` **100,002 → 0**, `Predef.icl` **123 → 0**,
`PmAbcMagic.icl` 177 → 0, `PmParse.icl` 155 → 137 nodes.

**Two things worth keeping.**

1. Cost is **+1 action row** (65,381 → 65,382 of 65,535). A new *token* whose
   states are already reachable is nearly free; it is new *symbols in new
   positions* that cost thousands (§14d/§14e).
2. `(unit){2,}` does **not** work in a tree-sitter regex: the engine compiled the
   open-ended repetition as exactly `{2}`, so `'ab'` lexed and `'abc'` did not
   (an ERROR over the literal, which is the tell-tale of a lexer gap). Written
   `unit unit+` it is correct. If a new token fails to match in a suspiciously
   quantised way, check this first.

### 15b. Capitalized generic names (`JSONEncode{|Version|}`)

`generic_case_definition` required a lowercase `identifier` for its name, but
Clean's built-in generics are CAPITALIZED (`JSONEncode{|Version|}`,
`JSONDecode{|Version|}` in Eastwood's `SemVer.icl`/`LockFile.icl`) and lex as
`constructor`. Allowing `choice($.identifier, $.constructor)` fixed
`LockFile.icl` (10 → 0 problem nodes) and **reduced** the action table by 28
rows — this one paid for itself.

### 15c. Trailing `;` on every member of a guard chain

Clyde ends EVERY member of a guard chain with `;`, including an inline
`| c = e;` guard (`Link.icl`'s `FindChar`/`FindQuoteChar`, `PmAbcMagic.icl`'s
`SubStringToInt`). The `#`-binding branch already absorbed the terminator; the
guard branches did not. Both guard branches (function and operator definitions)
now accept it per iteration **and** once at the end of the chain — the
per-iteration optional alone cannot absorb the last one, because at that `;` the
repeat's reduce wins over the shift (the same shape `case_alternative`'s
guard-first branch already uses). Tried in the same batch and reverted: the same
absorption on `case_alternative`'s guard bodies — it introduces conflicts and
still does not fix its target.

### 15d. Negative literals in pattern position

`indexOfNewlineBefore -1 = -1` (Eastwood's `Compiler.icl`) needs `-1` as a
**pattern**; `number` accepted only `~` as a sign prefix. Adding `-` to that
prefix is neutral in expression position — the per-tier operator tokens carry
lexical precedence and so still win the match, so `x -1` stays a
`binary_expression` (verified by comparing trees before and after) — while in
pattern position no `-` operator is valid, so `-1` finally lexes as one number.
`Compiler.icl` is now **clean** (1 → 0 error bytes).

One honest note: this change ALONE made the gate flag `Predef.icl` (+1 problem
node, +46 error bytes). That was not a lexing change at all but error-recovery
noise in an already-derailed region — the added region is nested inside an
existing ERROR, and the reported token diff for the whole file was a single
`->` that recovery consumed differently. Fixing the region's **root cause**
(15a) removed the noise completely. A recovery-only delta in an already-broken
file is a symptom to chase to its root, not automatically a reason to abandon a
correct change — but it must be chased, not waved away.

### 15e. Two measured dead ends in the same area

* **`:: T *a = ...` — uniqueness on a type PARAMETER** (Clyde's
  `:: * Input *a = { … }`, the first line of the wrapped `PmParse.icl`). A hidden
  `_type_parameter: choice($.type_variable, seq(choice($.uniqueness_star, "!"),
  $.type_variable))` used in `type_definition`'s two parameter positions costs
  **+23 rows** (65,382 → 65,405) and parses every probe
  (`:: T *a =`, `:: *T *a =`, `:: T a *b =`, `:: T *a`, `:: T !a =`), moving
  `PmParse.icl`'s derail point from line 18 to line 146 (`| sym.repr==BarSymID
  && char<>0` / `# (input,sym,line,char) = …`, the guard-chain-with-`#` family).
  It does **not** unwrap the file (still 56,572 bytes) and it flips
  `Config.icl` from 3 to 4 problem nodes: same first error, but a different
  recovery shape. **Not shipped** — the gain is 2 nodes in a file that stays
  wrapped, against a gate regression. Note the trap that cost a build: the bare
  `"*"` literal in the new position does NOT work, because in the state after
  `:: T` the generic `operator` token is also valid and the lexer picked it, so
  `*a` lexed as an operator; the `uniqueness_star` rule (lexical precedence 2)
  is what makes it lex correctly.

* **`instance C T derive g` — derived instances.** Real Clean, six sites in the
  corpus (`instance ConstructFromYAML CompilerSettingsConfig derive
  gConstructFromYAML`, `instance == (Range t) | == t derive gEq`, …); without it
  `Config.icl` cannot parse past line 26, and its signature on line 28 is the
  visible casualty. `optional(seq("derive", field("generic", $.identifier)))`
  after the instance head costs **+2,110 rows** — over the ceiling, with an
  overflowed action table and a broken parser (67,645 rows). Blocked: this needs
  headroom first.

### The remaining picture

Wrapped files: 3, and they are now 87% of what is left (136,828 of 157,923
bytes).

| wrapped file | error bytes | first real derail |
|---|---|---|
| `eastwood/test/LanguageServerTests.icl` | 62,593 | 1217 — `# (currentDirectory, w) = …` / `-> …`: let-before bindings after lambda parameters |
| `Clyde/cleantools/Pm/PmParse.icl` | 56,572 | 146 — a guard chain whose first member is a `#` binding (`\| c` / `# (…) = …` / `\| c`) |
| `clean-stdlib/_SystemDynamic.icl` | 17,663 | 40 — `(_TypeFixedVar _)`: a `_`-constructor used as a *pattern* |

Free action rows: **153**. Zero-row fixes (§14g, §15a) are the only kind that
fits without shrinking the automaton first.

## 16. Three dead ends measured against the same ceiling (2026-09-22, after edee2f1)

Method note for future sessions: the scratch harness in `/tmp` does not survive a
host restart. Rebuild it by compiling `src/parser.c` + `src/scanner.c` with
`cc -shared` and loading that `.so` through `ctypes`, exactly as
`scripts/corpus_regression.py` does — never through `npx tree-sitter parse`,
whose cache is keyed by the language NAME only (see that script's docstring).

**The headroom metric**: `action rows` = the highest index in
`ts_parse_actions[]` in `src/parser.c`. It agrees with the gate and with the
generator's own refusal message (a table of 66,572 rows is reported as
"exceeds maximum value of 65535"). HEAD (`edee2f1`) = **65,382 rows, 153 free**.

### 16a. Unique type parameters (`:: * Input *a = …`) — real Clean, parses, but +1 byte

Clyde's `PmParse.icl` line 17 defines `:: * Input *a = { … }` (and `PmDriver`'s
`add_subdir` declares `!*{#SubdirElem}`); the isolation matrix shows exactly one
failing piece, the marked *parameter*:

| shape | HEAD |
|---|---|
| `:: PState = { offside :: !Bool, curpos :: !Int }` (record type with field signatures) | clean |
| the same with a trailing `};` | clean |
| `:: * Input = { … }` (unique result, no parameters) | clean |
| `:: Input *a = { file :: !a }` | **fails (3 bytes)** |
| `:: * Input *a = { … }` | **fails (28 bytes)** |

The fix is a one-line change in the parametrized branch of `type_definition`:

```js
repeat1(seq(optional($.uniqueness_star), field("parameter", $.type_variable)))
```

Two properties matter. The `parameter` field stays on the `type_variable`, so
the tree shape is unchanged (`(type_definition (uniqueness_star) parameter:
(type_variable) …)`); and an inline `optional` is required rather than a new
named rule — a `_type_parameter` helper raises an unresolved conflict
(`'::' constructor type_variable • identifier`, "specify a higher precedence")
and generates the same tables anyway.

Measured: **+23 rows** (65,382 → 65,405, spare 130); `PmParse.icl` **137 → 135
problem nodes** (its first derail moves from line 18 to line 146, the `#` chain
that is itself blocked); `PmDriver.icl` **union byte coverage 1138 → 1139**.

That one byte is the blocker, and it is worth understanding before anyone
retries this. Diffing the merged error *regions* against the committed build
shows exactly one region changing — the ERROR at byte offset 78128 growing from
7 to 8 bytes:

```
HEAD (78128, 78135) | TP (78128, 78136)   src = 'FModified :: !String '
```

One **space** character, at the end of line 1606 of a file whose parse is
already broken 16 lines earlier by the `where` + `case` derail at line 1589
(§16b). The signature itself is fine in isolation in all five combinations
tried (with and without the trailing `;`, `!Files` as a strict constructor type,
`(!DATE, !Files)` as a tuple of strict types). So the artifact is recovery
noise nested inside an existing ERROR, not tree-shape damage — but it is still a
byte the gate counts, and the gate fails on it. **Not shipped**; the change
becomes shippable the moment the §16b `case` gap stops breaking line 1589.

### 16b. `;` after a non-first `#`-group member in a case alternative (real gap, unaffordable)

Clyde's `PmDriver.icl` lines 1593-1602 (the true reason its `where` block
derails at line 1589) is a case alternative whose body is a `#` group:

```clean
    = case method of
        CompileAsync _
            # (compiler_process_ids,ps) = getCompilerProcessIds ps
            # (_,ps) = ClearCompilerCaches compiler_process_ids ps;
            -> ps
```

The isolation matrix isolates the trigger to a trailing `;` on a member that is
*not* the first binding of the group (a `;` on the first binding is absorbed by
the next member's leading separator and works):

| shape (two `#` bindings, `;` on the second) | HEAD |
|---|---|
| `;` then `-> ps` on the next line | 1 problem |
| `; -> ps` on the SAME line (no layout token involved) | 1 problem |
| `;` then `-> ps` one level deeper | 1 problem |
| no `;` at all | **clean** |
| `;`, blank line, then `-> ps` | 1 problem |
| `;` then `| a -> ps` | 1 problem |

The winning parse ends the alternative at the `;` and invents
`pattern: (MISSING identifier)` for the following `-> ps` — a body-less
alternative plus a phantom pattern. Because the same-line variant fails too,
this is **not** a layout/scanner problem.

Four candidate fixes, all measured:

* `optional(";")` after each member, in both the binding-first and guard-first
  branches: **+424 rows** (65,829 — over the ceiling, spare −294) and the shapes
  *still* fail. The cost lands in `case_alternative`'s 1,531-state generated
  repeat.
* `[$._case_alternative]` self-conflict → the generator answers
  "unnecessary conflicts".
* `[$.case_expression, $.case_alternative]` → also "unnecessary conflicts".
* deleting the binding-first branch's trailing stray-`;` optional: **−77 rows**
  (65,305, spare 230 — the cheapest row *saving* found in this pass) but the
  shapes still fail, so it is a behaviour reduction with no compensating fix.
  Reverted.

The declarations are no-ops because the ambiguity lives inside the *generated*
repeat rule (`case_alternative_repeat1`, visible in `--report-states-for-rule`),
which has no name that `conflicts` can reference — the same reason the function
body's member list is written as the hand-recursive `_binding_tail` (that one
*is* declarable, and its declared conflict is what makes the trailing-`;`
continuation win there). The equivalent re-expression here
(`seq(pattern, guard_binding, $._binding_tail)`) is not a drop-in: it raises an
unresolved `guard_body` + `with_block` conflict and regresses the multi-guard
shape `pat | a -> ps | b -> q` from clean to 2 problems / 71 bytes.

### 16c. Leading-operator continuation lines: disproved as a scanner problem

Clean lets a line begin with an infix operator to continue the expression above
it, and the corpus relies on it: 18 `&&`-led lines and 10 `||`-led lines at
bracket depth 0 (`projdocument.icl` 462-463, `_SystemDynamic.icl` 116-122,
`PmProject.icl` 307-316), plus 12 `!*`-led and 88 `->`-led type continuations.

The tempting theory — that the scanner must not emit a layout token there — is
**wrong**, and the measurement says so. At HEAD the `&&`-led guard condition
parses **structurally correctly** with one zero-width ERROR (0 bytes) where the
scanner's `LAYOUT_START` was consumed by error recovery. Suppressing that token
(step 6 of `scan_impl`) makes it strictly worse: 0 → **92 bytes**, because the
whole guard then becomes an ERROR. It also regresses the plain multi-guard shape
`f cons` / `| a` / `= 1` / `| b` / `= 2` from clean to 1 problem (3 bytes).
Suppressing at the same-column site (step 7) and at the deeper-binding site
(step 8) changes nothing at all: the `||`-at-same-column shape still fails, so
that one is a *grammar* gap, not a token-stream gap. All three scanner edits
were reverted.

Practical consequence: the `&&`/`||` continuation lines are not a byte cost at
HEAD — they cost one phantom zero-width node each, which the *node* metric
counts and the byte metric does not. They should not be chased as a scanner bug.

### 16d. The `..` binary-range tier is load-bearing

`prec.right(PREC.RANGE, seq($._expression, $.range_operator, $._expression))`
costs about as much as any other operator tier (~514 rows, §14b), and `..`
looked like a candidate for removal because Clean's `..` is normally a
*list-range* token (`[0..n]`). Measured: removing that one alternative
**increases** the table from 65,382 to **68,633 rows** (+3,251): the `..` token
is then threaded through the other alternatives instead of having its own tier.
Reverted. This closes the "find a spurious precedence level" idea for headroom.

### What this pass leaves

* Free rows: **153** (unchanged).
* The two giant wrapped files are gated by the same ~1,632-row lambda/guard `#`
  fix (§12), and `_SystemDynamic.icl` by `(_TypeFixedVar _)` (§13b, +1,337 rows).
* The one change that is *verified to parse new real Clean* (`:: T *a`) is held
  back by a single space byte of recovery noise in `PmDriver.icl` — i.e. by the
  `case` gap in §16b. Those two are coupled: fix the `;` and both become
  shippable together.
* Cheapest row *savings* found: −77 (delete a stray-`;` optional, no fix), and
  the ±23 of the `*a` parameter itself.

## 17. v1.2.6 pass: five fixes shipped, the ceiling characterised, four blockers pinned (2026-09-22)

Baseline for this pass: `edee2f1` (386 problem nodes / 157,923 error bytes /
3 wrapped, action rows 65,382 of 65,535). End of pass: **322 nodes /
156,254 bytes / 3 wrapped, action rows 65,462 (73 spare)**, `npx tree-sitter
test` 116/116, gate PASS with no file worse in either metric.

### 17a. Where the automaton's bulk actually lives

`npx tree-sitter generate --report-states-for-rule -` prints a states-per-rule
census (a state is counted for every rule in its closure, so the numbers
overlap). The head of the report at HEAD:

| rule | states | | rule | states |
|---|---|---|---|---|
| `binary_expression` | 10,257 | | `lambda_expression` | 1,770 |
| `let_expression` | 3,541 | | `case_alternative_repeat1` | 1,531 |
| `case_alternative` | 3,224 | | `where_block_repeat1` | 1,412 |
| `case_expression` | 2,694 | | `let_before_expression` | 1,392 |
| `if_expression` | 2,428 | | `case_expression_repeat2` | 1,364 |
| `guard_equation` | 2,104 | | `array_expression` | 1,296 |

The expression cascade is the whole story: every `_expression` context
instantiates the operator tiers' states, and the *reduce* states split by
lookahead (that is what the declared GLR conflicts buy). Consequence: the two
things that cost thousands of rows are both "add a token to the follow set of a
construct whose sub-states are multiplied by every context" (lambda parameters,
guard lists) — not anything local.

### 17b. The conflict list is load-bearing — audited, nothing removable

All 33 entries of the `conflicts` table were checked by re-generating: the
generator emits *"Unnecessary conflict"* warnings for entries it does not
need, and there are **zero** such warnings at HEAD. (The one entry that once
was unnecessary — `case_alternative` — was removed in the §16 pass.) So no
headroom is available from pruning the table.

Two changes were measured and rejected for cost this pass:

* **`;` after a non-first `#` member of a case alternative** (Clyde's
  PmDriver L1596): per-member absorption **+424 rows** (spare goes negative),
  deleting the branch-end stray-`;` optional saves 77 rows but fixes nothing,
  and declaring the conflict is a no-op because the ambiguity sits inside a
  *generated* repeat rule. PmDriver's 1,138 bytes stay blocked by this.
* **An inline (`_inline_layout_start`) member block in `guard_equation`** —
  the right shape for §17d below, but `guard_equation` is 2,104 states and the
  layout-block member choice is shared with class/instance/special/where
  blocks (§ note: "layoutBlockMembers is reused … any member-choice change
  leaks into all of them"), so it needs headroom we do not have.

### 17c. The four wrapped files are *one* family, and it is the `#` follow set

| file | error bytes | first derail |
|---|---|---|
| `LanguageServerTests.icl` | 62,593 | `\params` then a `#`-group then `=` body |
| `PmParse.icl` | 56,572 | the same, nested in a `#`-group |
| `_SystemDynamic.icl` | 17,663 | `(_TypeFixedVar _)` (a `_`-constructor application) |
| `Symbol.icl` | 16,461 | the same lambda/`#` shape as LanguageServerTests |

Together **153,289 of the 156,254 remaining error bytes (98%)**. The lambda
half is the ~1,632-row fix (§12); the `_`-constructor half is ~1,337 rows
(§13b). With 73 spare rows, the v1.2.6 release cannot move any of them — this
is a headroom problem, not a grammar-shape problem.

### 17d. What the *tail* actually was (the fixes this release ships)

Every fix below was isolated with a minimal probe first, then measured on the
gate; none regressed a file in either metric.

| construct | cost | result |
|---|---|---|
| functional `if` condition may be a field/index access | **0 rows** | PmProject 390→0, CloogleServer 391→13, Link 216→16, builddb 36→0 |
| `=?=` added to the existing `operator_compare` terminal | **0 rows** | Target.icl 138→52 |
| `foreign export <Constructor>` (name may be a `constructor`) | +80 for three | projdocument 503→0 |
| `derive` import over any `_type_atom` (not just a constructor) | (same batch) | Hover.dcl 28→0 |
| `:: T (=: C …)` parenthesised abstract newtype | (same batch) | SymbolMapExample 48→4 |

Two lessons for the next pass:

1. **A zero-row fix is one that adds a lexeme or a production to a terminal
   that already exists** — `=?=` joined `operator_compare`, and the `if`
   widening reused `field_access` in a position where the automaton already
   had the states. The `'abc'` fix (§14g) is the same shape.
2. **Never introduce a hidden helper rule to "widen" a keyword's operand.**
   Wrapping the widened `if` condition in `_if_condition: choice(…)` — a
   single-reference hidden rule, i.e. one tree-sitter inlines — made *every*
   `if c t e` in the corpus parse as an application (`if` re-lexed as a plain
   identifier) and *freed* 52 rows while doing it. The inline `choice` at the
   call site behaves correctly at the same row count. Root cause not chased;
   the observable is recorded here because a row *decrease* paired with a
   lexer regression is a trap for a measurement-driven pass.

### 17e. Blockers pinned for the next pass (all measured, none shipped)

* **PmDirCache.icl (465 B)** — not the `where` block it was thought to be
  (§16): the trigger is `dropWarn f cons=:[a:x] | f a # (wrn,x) = dropWarn f x`
  — a **`#` binding on the SAME LINE after an inline guard**. Six-shape matrix:
  the inline guard with a deeper `= body` parses; adding a same-line `#`
  member does not, because `| cond`'s condition is an `_expression` and a `#`
  can start a `let_before_expression`, so the parser prefers to shift `#` as
  another application argument to the condition and strands the bodies.
  Closing it needs the inline member block of §17b.
* **SemVer.icl (208 B)** — a case alternative whose guard block sits on
  *DEEPER lines than the pattern*:
  `0` / `| s == "0" -> Ok 0` / `| otherwise -> …` / `i` / … The grammar's
  case-alternative branches both expect the `#`/`|` members at the pattern's
  own level (`case_alternative`'s comment argues a `_layout_start` after a
  pattern is unreachable in the pattern-continuation states). Same cost
  problem as above.
* **`import code from "NSWindow+DvA.o"` (windows.icl, 116 B)** — the form is
  parseable, but `code` lexes as `module_identifier` in the import state, so
  the alternative never fires (adding it is free: rows unchanged). Forcing it
  with a dedicated `token(prec(3, "code"))` *does* fire — and breaks `code`
  used as an ordinary identifier (`g code = code + 1` stops parsing), which is
  legal Clean. Rejected: 116 bytes is not worth sacrificing a legal name.
* **`instance C T1, T2` comma lists in instance heads** (Target.dcl, 625 B) —
  +2,252 rows (§14), still unaffordable.
