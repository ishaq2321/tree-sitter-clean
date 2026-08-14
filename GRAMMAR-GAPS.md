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

The current verified baseline (v1.2.1): corpus **60/60** (5 new import
regression tests); Eastwood (36 `.icl` files) **1897 ERROR nodes vs 2238**
on the previous grammar; clean-stdlib root `Std*` files (25) **0/0**;
Clyde+cloogle (123 `.icl`/`.dcl` files) **1786 vs 1790**; **0 action-table
overflows**. (The v1.2.0 baseline of 1833 across 120 files was measured on
a slightly different corpus selection and is superseded by the above,
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

## 1. `!!` and other `!`-containing operators

`!` is the strictness marker (`!x`), strict-field-access marker (`r!f`),
and part of list markers (`[!a]`, `[a:b!]`), so it is deliberately excluded
from the generic `operator` charset (`/[~%^*+\-\\<>\/?|$]+/`). Bare
`xs !! i` (the stdlib's `(!!) infixl 9` list index) therefore fails to
lex as an operator.

**Real code:** `args!!0`, `listItems!!r`, `therow!!c`, `fs!!(` — 20 bare
uses across Clyde/cleantools. The parenthesized form `(!!)` in definitions
already lexes via `parenthesized_operator`'s charset
(`/[~%^*+\-\\<>\/?!#$&=@.:|]+/`), and `xs !! i` with surrounding spaces
does parse (the `!!` becomes two `!` strict markers in the current grammar
only when adjacent to the identifier, i.e. `args!!0`).

**Failed approach — dedicated `operator_bang_bang` token (`!!`, prec 1):**
added to `binary_expression` and/or `_operator_symbol`. Fixed
Foundation.icl's whole-file wrapper (caused by `args!!0`) but the token's
presence in expression states tipped recovery in unrelated files:
PmEnvironment.icl 0 → 160, IdeState.icl 21 → 180, PmFiles.icl 8 → 117,
PmDirCache.icl 232 → 247/265. Net suite result: worse. Reverted.

**Why it failed:** the new token adds a shift action to every expression
state, and error recovery (which searches states for one that can shift the
lookahead token) finds these new states instead of the intended resync
points, causing the whole-stack pop that wraps the file in one `ERROR`.

## 2. Same-column continuation bindings in `#!` / `#` groups

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

## 3. Dot-less strict array index `a![i]`

Clyde writes strict array indexing without the dot:
`subdirs![subdir_i]`, `arr![i]` (3 uses). The grammar's `index_access`
requires `record!.[i]` or `record.[i]`; `a![i]` currently misparses as
`field_access` with a MISSING field plus a list argument (no ERROR, wrong
shape).

**Failed approach — `choice("!.", "!", ".")` selector (no bare `[`):**
fixed the construct but the `!` transition after expression atoms changed
recovery in Console.icl 0 → 154 and flipped PmDirCache.icl from local
errors (232) to a whole-file wrapper. Also risked breaking the
application `arr [i]` (which must stay an application — a bare `[` is a
list argument). Reverted.

**Note:** the earlier `optional("!")` + `optional(".")` variant made
`arr[i]` (no selector at all) parse as `index_access`, which is wrong —
Clean requires the `.`; bare `[` must remain application.

## 4. Deeper-column continuation bindings

`# a = e` followed by a binding indented deeper than the group:

```clean
# (subdir,subdirs) = subdirs![subdir_i]
  cache             = update_dir_cache (n`,p`,m`) subdir.subdir_cache
  subdirs & [subdir_i] = {subdir & subdir_cache=cache}
```

(PmDirCache.icl's `DC_HUpdate`.) The deeper column is indistinguishable
from a multi-line application continuation at the lexer level (312 real
value-continuation lines in the corpus would break if a separator were
emitted at every deeper line). Requires the same member/separator
mechanism as #2 plus a binding-lookahead heuristic — both blocked by the
same walls.

## 5. Record update by type name: `{ T | field = value, ... }`

Eastwood constructs records with the type-name pipe form (the main
remaining source of its errors — the whole-file wrapper in
`EastwoodCleanLanguageServer.icl` starts at this definition):

```clean
{ ServerCapabilities
| textDocumentSync = {openClose = True, save = True}
, declarationProvider = True
}
```

**Failed approaches (all measured on the full build, not probes):**

- A dedicated `record_update_by_type` rule (`{` + `constructor` + `_pipe`
  + field list) wired into `_expression_atom` — **199 overflow warnings**.
  (The unwired rule measured ~0 because dead rules are pruned before table
  generation — a dead-code measurement that misled early.)
- The same rule with literal-only field values — **13468 overflows**: the
  cost is the `|` after a constructor merging with the guard/context/
  comprehension pipe states, not the value expression.
- A dedicated pipe token / literal `"|"` / precedence tweaks — no help:
  the `{`-opener context is already shared by record_expression,
  record_update, record_pattern, array_expression and both
  comprehensions; any new `{`-form forks all of them.

Fitting this needs more headroom (a larger refactor like section 0's) or
a tree-sitter version with wider action encoding.

## 6. `=>` qualified imports and `as` aliases

`StdOverloadedList.icl` (currently a 0-error stdlib file) contains
`import StdOverloadedList => qualified subscript_error, ...` — a *third*
qualified form. Today `=>` lexes as `=` + `>` (a bare `=` is not in the
operator alphabet), so the import false-passes with a wrong tree in some
positions and errors in others. The `as` alias form (`import M as N`) is
the same family; `as` cannot be reserved because it is a stdlib
parameter name (`zip2 as bs`). Both remain open; they are not in the
maintainer-reported Eastwood file.

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
