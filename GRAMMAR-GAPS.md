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

## 4. Deeper-column continuation bindings

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

What remains open is the *scanner* half of gap #4. Re-adding the
scanner-side SEMICOLON branch (binding-shaped deeper lines, zero-width
SEMICOLON) on top of these grammar fixes still measures **+7** on the
corpus (811 vs 804): it fixes coloured_line 35→0, PmDirCache 15,
projdocument 29, PmCleanSystem 5, and PmPath 14, but breaks the
where-block membership via GLR fork priority (PmFileInfo 4→49: the
SEMICOLON splits a guard-body continuation correctly, but the extra
forks push the 11-version GLR race past the where-block-continue fork,
escaping the whole declaration) and trips the error-recovery phantom
stack in case bodies (PmDriver 31→50 with a whole-file ERROR). A
workable scanner-side fix needs to emit the separator without creating
the extra LALR fork — likely the `[$._binding_tail]`-style GLR fork
applied at the layoutBlockMembers separator, which the current
shared-rule structure does not expose — a structural redesign, not an
additive fix.

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
