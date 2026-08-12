// Tree-sitter grammar for the Clean programming language.
//
// References:
//   - Clean Language Report: https://clean-lang.org/
//   - Clean Book: https://clean.cs.ru.nl/Clean
//
// Design notes
// ------------
// * Operator precedence is encoded as an explicit Pratt-style ladder via
//   `prec.left(N, ...)` so that `1 + 2 * 3` nests correctly. Fixity/precedence
//   *declarations* in source (`infixl 6`, `infixr 5`) are captured as nodes
//   but, like Clean's own compiler, they inform the *reader*; the static
//   precedence here mirrors Clean's built-in operator defaults.
// * Application binds tighter than every operator.
// * Algebraic data types, type synonyms, abstract types, records (incl.
//   existential/strict/uniqueness fields), and class/instance declarations
//   with contexts are all supported.
// * Layout (offside rule) is delegated to an external scanner (`scanner.c`)
//   which also balances nested block comments — a Clean-specific requirement.
// * The grammar exposes supertypes (`_expression`, `_pattern`, `_type`,
//   `_declaration`) so editor tooling can navigate the tree generically.

// Shared body of every layout block (where/with/class/instance/case): any
// number of SEMICOLON- or `;`-separated members, then a REQUIRED final
// member closed by LAYOUT_END or `;`, then an optional trailing LAYOUT_END
// (which closes the block when the last member was `;`-terminated).
// LAYOUT_END appears ONLY in closing positions — never as a plain separator
// inside the repeat — so a dedent always CLOSES the block. The old
// `repeat1(member (SEMI|END|";"))` treated END as just another separator:
// after the last member the repeat happily continued, and any identifier at
// a lower indentation (e.g. the next top-level declaration) silently joined
// the block as a new member instead of ending it.
// `where { m1; m2; }` — the EXPLICIT (brace) layout form. Members are
// separated by literal `;` and the block is closed by `}` (a trailing `;`
// before the closing brace is optional). Used by class/instance where-blocks
// in the stdlib's `_System*` modules; `let`/`case`/`with` never use it.
function bracedBlockMembers($, member) {
  return seq("{", repeat(seq(member, optional(";"))), "}");
}

function layoutBlockMembers($, member, semi_closer) {
  return seq(
    repeat(seq(member, choice($._layout_semicolon, seq(";", optional($._layout_semicolon))))),
    // The final member may be closed by END (a dedent, or EOF when the block
    // pushed a level), by `;`, or by the trailing SEMICOLON the scanner emits
    // at EOF for blocks that never pushed a level (e.g. an inline `case`).
    // `case` alternatives drop the literal `;` closer (semi_closer = false):
    // a trailing `;` there continues the alternative list (the inline form
    // below), and letting it ALSO close the block would make the parser
    // reduce the case after the first alternative, stranding the rest.
    seq(member, choice($._layout_end, ...(semi_closer === false ? [] : [";"]), $._layout_semicolon)),
    optional($._layout_end),
  );
}

const PREC = {
  // Term-expressions (highest number binds tightest)
  APPLICATION: 12,
  ACCESS: 11, // record/array field access, indexing: a.b, a.[i]
  UNARY: 10, // ~ (negate), prefix strictness in terms is handled separately
  EXPONENT: 9,
  MULTIPLY: 8,
  ADD: 7,
  RANGE: 6, // .. in [1..n]
  COMPARE: 5,
  AND: 4,
  OR: 3,
  CONSTRUCTOR: 2, // list cons [h:t] and type-like constructors
  LAMBDA: 1,
  // Declarations / statements (looser)
};

module.exports = grammar({
  name: "clean",

  word: ($) => $.identifier,

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  // External tokens produced by the scanner in `src/scanner.c`:
  //   - the three layout tokens implement Clean's offside rule, and
  //   - `block_comment` is externalised so nested /* ... /* ... */ ... */ is
  //     balanced correctly (Clean comments nest, unlike C).
  externals: ($) => [
    $._layout_semicolon,
    $._layout_start,
    $._inline_layout_start,
    $._layout_end,
    $.block_comment,
  ],

  // `word` enables keyword extraction so reserved words used as string
  // literals in the grammar (module, import, class, ...) never fragment into
  // bare identifiers. No explicit `reserved` set is required.

  supertypes: ($) => [
    $._declaration,
    $._expression,
    $._pattern,
    $._type,
  ],

  conflicts: ($) => [
    // type_application vs. end-of-type (followed by context `|` or `=`)
    [$._type, $.type_application],
    // a data constructor `Just a` vs. a type atom (when RHS could be a synonym)
    [$.data_constructor, $._type_atom],
    // strict attribute vs. array element-type attribute (`{!Int}`)
    [$._type, $.strict_type],
    // constructor_pattern `Just a` vs. constructor as expression atom
    [$.constructor_pattern, $._expression_atom],
    // record pattern `{x, y}` vs. record expression `{x = a}` — same `{ name`
    // prefix, disambiguated by what follows (`,`/`}` = pattern, `=` = expr)
    [$.record_pattern, $._expression_atom],
    // comprehension generator body is an expression; in `case`/`with`/let the
    // same tokens could start a pattern. Disambiguate expression vs. pattern.
    [$._pattern, $._expression_atom],
    // function vs. macro LHS both start with `name pat...`
    [$.function_declaration, $.macro_definition],
    // record-update pattern `ds & f` vs. a bare identifier pattern
    [$._pattern, $.record_update_pattern],
    // a let-before block's `= expr` member vs. ending the function body there
    [$.function_declaration, $.guard_body],
    [$.operator_definition, $.guard_body],
    // a trailing `;` after a let-before/guard member: continue the member list
    // (the `;` is the next member's separator) vs. end the declaration (the
    // `;` is a stray statement terminator). GLR keeps both; the error-free
    // continuation wins. NOT resolved by precedence — see function_declaration.
    [$.function_declaration],
    [$.operator_definition],
    // compound expression as application atom vs as a full expression
    // (e.g. a lambda used as a guard body: `| cond \x -> x = ...`)
    [$._expression, $._expression_atom],
    // class head: trailing type variables vs. context parsing
    [$.class_declaration],
    // context `,` may continue the item list (`| Eq a, Ord a`) or start
    // uniqueness constraints (`| Ord a,[u v <= w]`) — GLR explores both;
    // no precedence on class_context so the branch is not pruned
    [$.class_context],
    // derive argument list ambiguity
    [$.derive_declaration],
    // `class ==(..)` — the `(` after a class import is either the `(..)`
    // all-members suffix or a new parenthesised operator item
    [$._import_item],
    // a multi-line import block: after a member + separator, the next line
    // either continues the block or the import ends (the first member served
    // as both the repeat and the final member) — GLR keeps both and the
    // error-free continuation wins
    [$.import_declaration],
    // instance head: `instance Foo (Bar a)` — parenthesised type vs. tuple
    [$.instance_declaration],
    // where/with block repeat: continue with another member vs. end the block
    [$.where_block],
    [$.with_block],
    // case alternatives: continue with another alternative vs. end the case
    [$.case_expression],
    // `;` after an alternative: continue the list vs. end the case (the `;`
    // belongs to the enclosing statement) — shift into a new alternative vs.
    // reduce the case
    [$.case_expression, $.case_alternative],
    // special members: continue with another member vs. end the block
    [$.special_block],
    [$.macro_definition, $.function_declaration, $.let_qualifier],
    [$.function_declaration, $.let_qualifier],
    // `let (r,st1) = ...`: `(r` starts a tuple/paren pattern or an operator name
    [$.parenthesized_name, $._pattern],
    // `(op) infix N` — fixity declaration vs. start of a type signature
    // (`(op) infix N :: type`); resolved by what follows
    [$.fixity_declaration, $.signature_name],
    // `:: T a b = ...`: parameters vs. a new declaration starting after a
    // bare abstract type (`:: T` followed by `a b = ...`)
    [$.type_definition],
    // `infix N op ;` — the `;` may close the fixity declaration or act as the
    // next declaration's separator; both consume it, shape differs only
    [$.fixity_declaration],
    // `FModified :: ... -> ...;` — the `;` may close the type signature or
    // act as the enclosing block's member separator; both consume it
    [$.type_signature],
    // empty list [] in pattern vs expression context
    [$.list_pattern, $.list_expression],
    // a list element followed by `!`: the `!` starts a strict field access on
    // the element (`[b!x]`) or closes the list as the spine-strict marker
    // (`[b!]` / `[b:c!]`). field_access's prec(ACCESS) beats the element
    // reduce's implicit 0, so the spine path is never taken without a fork.
    [$._expression, $.field_access],
    // case_alternative with guard: body expression consuming `->` vs arrow separator
    [$.binary_expression, $.case_alternative],
    // guard block members: continue with another member vs. end the block
    // (nested guards: `| cond` then deeper `#`/`=` lines)
    [$.guard_equation],
  ],

  rules: {
    // ─────────────────────────────────────────────────────────────────────
    // Top level
    // ─────────────────────────────────────────────────────────────────────

    source_file: ($) =>
      seq(
        optional($._layout_start),
        // Top-level declarations are separated by LAYOUT only — a literal `;`
        // after a declaration is NEVER valid Clean at the top level (the `;`
        // appears only inside member lists: guard/let-before chains, case
        // alternatives, where/with blocks). NOT accepting it here keeps a `;`
        // after a member unambiguous: the parser must continue the member
        // list instead of ending the declaration early and letting the `;`
        // leak to the top level.
        repeat(seq($._declaration, optional($._layout_semicolon))),
        optional($._layout_end),
      ),

    _declaration: ($) =>
      choice(
        $.module_declaration,
        $.import_declaration,
        $.fixity_declaration,
        $.type_definition,
        $.type_signature,
        $.function_declaration,
        $.operator_definition,
        $.macro_definition,
        $.generic_case_definition,
        $.class_declaration,
        $.instance_declaration,
        $.generic_declaration,
        $.derive_declaration,
        $.special_block,
        $.foreign_export,
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Modules & imports
    // ─────────────────────────────────────────────────────────────────────

    // `module M` | `definition module M` | `implementation module M` | `system module M`
    module_declaration: ($) =>
      seq(
        optional(choice("implementation", "definition", "system")),
        "module",
        field("name", $.module_name),
        // `.dcl` modules: `definition module X;`
        optional(";"),
      ),

    // A module path component: Clean module names are uppercase
    // (StdEnv, StdFunc, StdIO), so module identifiers accept the full
    // identifier range (lower + upper case) — distinct from the lowercase-only
    // `identifier` and uppercase-only `constructor`.
    module_name: ($) =>
      prec.right(
        seq(
          $.module_identifier,
          repeat(seq(token.immediate("."), $.module_identifier)),
        ),
      ),

    module_identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_'`]*/,

    // `import M.N`
    // `import M, M2`
    // `foreign export foo` — an FFI export declaration (Clyde's dyncall FFI
    // and the Clean FFI). The two keywords are bare literals: defined before
    // `identifier`, so they win the lex in declaration-start states, exactly
    // like `module`/`implementation` do.
    foreign_export: ($) => seq("foreign", "export", field("name", $.identifier)),

    // `from M import x, y, :: Type`
    // `from M import` — items may also form a layout block on deeper lines
    // (`from StdClass import` then `\tclass toString, class ==`).
    import_declaration: ($) =>
      prec.left(
        seq(
          choice(
            seq("import", field("module", $.module_name), repeat(seq(",", field("module", $.module_name)))),
            seq(
              "from",
              field("module", $.module_name),
              "import",
              choice(
                // inline list: `from M import x, y`
                seq($._import_item, repeat(seq(",", $._import_item))),
                // layout block: each line holds one or more comma-separated
                // items, with an optional trailing comma before the next line
                // (`\t:: TypeCode (..),`).
                seq(
                  $._layout_start,
                  layoutBlockMembers(
                    $,
                    seq(
                      $._import_item,
                      repeat(seq(",", $._import_item)),
                      optional(","),
                    ),
                  ),
                  optional($._layout_end),
                ),
              ),
            ),
          ),
          // `.dcl` modules: `import M;` / `from M import x;`
          optional(";"),
        ),
      ),

    // A single imported item:
    //   `x`, `:: Type`, `+` — plain value / type / operator imports
    //   `class Ord`, `class ==(..)` — class imports, `(..)` = all members
    //   `instance == Char` — instance imports
    // (as in real Clean: `from StdClass import <=, not, class Ord`).
    _import_item: ($) =>
      choice(
        seq(
          optional("::"),
          choice($.identifier, $.constructor, $._operator_symbol),
          // `:: TypeCode (..)` / `:: Date{..}` — the all-members suffix.
          // `(..)` lexes as one token; `{..}` is the record all-fields form
          // (`from StdLibMisc import :: Date{..}`).
          optional(choice($.parenthesized_operator,
                          seq("{", $.range_operator, "}"))),
        ),
        seq(
          "class",
          choice($.identifier, $.constructor, $._operator_symbol),
          // `class ==(..)` — the all-members suffix. `(..)` lexes as a single
          // parenthesized_operator token, so the suffix must accept it whole.
          optional($.parenthesized_operator),
        ),
        seq(
          "instance",
          choice($.identifier, $.constructor, $._operator_symbol),
          // `instance == Char` / `instance toString (TypeCode)` — the class
          // and the type it is instantiated for (possibly parenthesised)
          optional($._type_atom),
        ),
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Fixity / operator declarations
    //   (infixl 6) +  infixr 5 :  infix 0 ==
    // ─────────────────────────────────────────────────────────────────────

    // `(op) infixr 9` — operator first, the form used throughout the current
    // stdlib (often with a trailing `;`); or `infixl 6 + -` — fixity first
    // with one or more space-separated operators (report form).
    fixity_declaration: ($) =>
      choice(
        seq(
          field("operator", choice($.parenthesized_operator, $.parenthesized_name)),
          field("associativity", choice("infix", "infixl", "infixr")),
          field("precedence", optional($.integer)),
          optional(";"),
        ),
        seq(
          field("associativity", choice("infix", "infixl", "infixr")),
          field("precedence", optional($.integer)),
          field("operator", $._operator_symbol),
          repeat(field("operator", $._operator_symbol)),
          optional(";"),
        ),
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────

    // `name :: Type` — top-level, class-member, or local type signature.
    //
    // The name may be:
    //   - a plain identifier:        `map :: ...`
    //   - a parenthesised operator:  `(+) :: ...`
    // A fixity annotation may follow the name, matching Clean's concrete
    // syntax (`(<>) infix 4 :: ...`, `(!!) infixl 9:: ...`).
    // A class context follows the main type:  `f :: a -> a | Eq a`
    type_signature: ($) =>
      // prec.right resolves the trailing-`;` conflict (shift the `;` and stay
      // in the signature) WITHOUT a GLR fork — a fork here re-merged the
      // enclosing block's member states and broke `with`-block attachment in
      // later members (StdOverloadedList.icl).
      prec.right(
        seq(
        field("name", $.signature_name),
        optional(field("fixity", $.fixity_annotation)),
        "::",
        field("type", $._type),
        field("context", optional($.class_context)),
        optional($.uniqueness_constraints),
        // Inline body: `fwriter :: !Real !*File -> *File :== code { ... }` —
        // stdlib signatures frequently carry an inline ABC-code definition.
        optional(seq(":==", field("body", $._expression))),
        // Trailing `;` — real modules write `FModified :: !String ... -> ...;`
        // at the top level. Accepting it HERE (not in source_file) keeps a
        // `;` after other declarations unambiguous: the parser must continue
        // the member list (case alternative, let-before binding) instead of
        // ending the declaration and leaking the `;` to the top level.
        optional(";"),
        ),
      ),

    // `, [u <= v, u <= w]` — uniqueness constraints that follow a signature.
    // The left side may be a full type (`[w u <= v]` — a uniqueness variable
    // applied to a type, e.g. `!u:(m v:a)` constrained against `v`).
    uniqueness_constraints: ($) =>
      seq(
        ",",
        "[",
        repeat1(seq($._type, choice("<=", "<"), $.identifier)),
        repeat(seq(",", seq($._type, choice("<=", "<"), $.identifier))),
        "]",
      ),

    signature_name: ($) =>
      choice(
        $.identifier,
        // Exported signatures use capitalized names (`Take :: ...`), which
        // lex as constructors.
        $.constructor,
        // symbols-only `operator` (not `_operator_symbol`): the alphanumeric
        // operator tokens (`mod`, `rem`, `and`, `or`) must not be valid at
        // declaration-start states, or `module`/`modify` lex as `mod` + rest.
        $.operator,
        $.operator_dot,
        $.parenthesized_operator,
        $.parenthesized_name,
      ),

    // `infixl 6` — the fixity/precedence annotation (also used standalone).
    fixity_annotation: ($) =>
      seq(
        choice("infix", "infixl", "infixr"),
        optional($.integer),
      ),

    // `| Eq a, Ord a` — a class context that follows a type, introduced by `|`.
    // Right-associative so a following `,` continues the list instead of
    // ending the context early (left-associativity strangles multi-item
    // contexts like `| + , - , zero a`).
    class_context: ($) =>
      seq(
        $._pipe,
        $._context_item,
        // `,` separates context items; `&` separates parallel (zipped)
        // constraints (`| == a & UList a`). Both are equally valid after a
        // `|`, and a following `[u<=v]` constraints bracket is never part of
        // the context (the GLR conflict declared above keeps that branch).
        repeat(seq(choice(",", "&"), $._context_item)),
      ),

    // A context item is a head plus its type arguments, e.g. `| Eq a`,
    // `| == a`, or a bare head (`| + , - , one , zero a`). Greedy atom
    // consumption (right-associativity) matches real contexts; a path that
    // then fails (e.g. the next token is actually a new declaration) dies
    // and the other interpretation survives.
    _context_item: ($) =>
      prec.right(
        choice(
          // head with at least one type argument: `| Eq a`, `| == a`,
          // `| zero a` (class names may be lowercase identifiers)
          seq(
            choice($.constructor, $.identifier, $._operator_symbol, $.parenthesized_operator, $.parenthesized_name),
            repeat1($._type_atom),
          ),
          // a bare head (no type arguments): `| + , - , one , zero a`
          choice($._operator_symbol, $.constructor, $.identifier, $.parenthesized_operator, $.parenthesized_name),
        ),
      ),

    // The head of a class-context assertion is a class name (constructor or
    // lowercase identifier, e.g. `zero`) or an operator — bare (`| == a`,
    // `| + , - , zero a`) or parenthesised.
    _context_head: ($) =>
      choice($.constructor, $.identifier, $._operator_symbol, $.parenthesized_operator, $.parenthesized_name),

    // ---- Type definitions (RHS of `::`) ----
    //
    // In Clean, *type names* are uppercase (Maybe, Tree, List), as are *data
    // constructors* (Just, Cons). They are lexically identical and only
    // distinguishable by position: the type name follows `::`, the data
    // constructors follow `=`. We use `constructor` for both since the
    // regex is identical; the field name documents intent.

    // `::` maybe-kindness maybe-type-vars maybe-RHS
    //
    // Two rules disambiguate the head:
    //   - `type_definition` covers the abstract case (`:: T`) and the
    //     body-bearing case (`:: T = ...`, `:: T a = ...`).
    //   - The trick is `repeat1` parameters + mandatory body, given higher
    //     precedence, so GLR prefers "parameters belong to this type" over
    //     "parameters start a new function declaration".
    // `.dcl`/`.icl` synonyms and ADTs frequently end with `;`:
    // `:: * Files = Files;`, `IF_INT_64_OR_32 int64 int32 :== int32;`
    type_definition: ($) =>
      seq(
        choice(
        // `:: T a = RHS` / `:: T a :== RHS` — parametrized, must have a body
        prec.left(2,
          seq(
            "::",
            optional(choice("*", "!")),
            field("name", $.constructor),
            repeat1(field("parameter", $.type_variable)),
            field("body", $.type_definition_body),
          ),
        ),
        // `:: T = RHS` — no parameters, has a body
        prec.left(1,
          seq(
            "::",
            optional(choice("*", "!")),
            field("name", $.constructor),
            field("body", $.type_definition_body),
          ),
        ),
        // `:: T a` — abstract type with parameters (rare, but valid).
        // Precedence BELOW the repeat rule's (implicit 0): at `:: T a ...` the
        // parser must SHIFT a second parameter (inside the generated repeat
        // rule, which carries no precedence) instead of reducing this branch
        // early — otherwise `:: T a b = ...` silently misparses as an abstract
        // `:: T a` followed by a function declaration `b = ...`.
        prec.left(-1,
          seq(
            "::",
            field("name", $.constructor),
            repeat1(field("parameter", $.type_variable)),
          ),
        ),
        // `:: T` — abstract type
        prec.left(0,
          seq(
            "::",
            optional(choice("*", "!")),
            field("name", $.constructor),
          ),
        ),
        ),
        optional($._semi),
      ),

    type_definition_body: ($) =>
      choice(
        // `:: X :== <type>` / `:: OBJECT a =: OBJECT a` — SYNONYMS: the RHS is
        // a type expression, never data constructors. (`:: CleanupCont :==
        // Pathname Bool Bool *GeneralSt` — data_constructors would stop at
        // `Pathname Bool Bool` and leave `*GeneralSt` dangling.)
        seq(choice(":==", "=:"), field("rhs", $._type)),
        // `:: X = Cons a | Nil` / `:: X = { field :: Int }` — ADTs and
        // records
        seq("=", field("rhs", choice($.data_constructors, $.record_definition))),
      ),

    type_variable: ($) => $.identifier,

    // `= Cons a (List a) | Nil`
    data_constructors: ($) =>
      prec.left(
        seq($.data_constructor, repeat(seq($._pipe, $.data_constructor))),
      ),

    data_constructor: ($) =>
      prec.right(
        seq(
          field("name", $.constructor),
          repeat(field("argument", $._type_atom)),
        ),
      ),

    // `{ x :: Int, y :: !Real }`
    record_definition: ($) =>
      seq(
        "{",
        repeat1($.record_field),
        repeat(seq(",", $.record_field)),
        optional(","),
        "}",
      ),

    record_field: ($) =>
      seq(
        field("name", $.identifier),
        "::",
        field("type", $._type),
      ),

    // ---- Type expressions ----
    //
    // Right-associative `->`, left-associative juxtaposition (application).
    //
    //   Int                 → atom
    //   a -> b              → fun(a, ->, b)
    //   Maybe a             → application(Maybe, a)
    //   (a, b) -> c         → fun(tuple(a, b), ->, c)
    //   [Int]               → atom
    //   *World              → uniqueness atom

    _type: ($) =>
      choice(
        $.type_function,
        $.type_application,
        $._type_atom,
      ),

    type_function: ($) =>
      prec.right(PREC.CONSTRUCTOR, seq($._type, $.arrow, $._type)),

    type_application: ($) =>
      // Right-associative so the parser SHIFTS the next atom instead of
      // reducing the application early (which would let the type signature
      // end mid-list). Without this, `!(a -> .Bool) (a -> a) a -> a` stops
      // after two atoms and the tail `a -> a` errors.
      prec.right(
        seq(
          $._type_atom,
          repeat1($._type_atom),
        ),
      ),

    _type_atom: ($) =>
      choice(
        $.uniqueness_type,
        $.unique_var_type,
        $.strict_type,
        $.dotted_type,
        $.constructor,
        $.type_variable,
        $.list_type,
        $.tuple_type,
        $.array_type,
        $.type_paren,
        $.unit_type,
        $.question_type,
        $.builtin_question_type,
      ),

    // `?x`, `?^x`, `?#x` — Clean's builtin strictness types (`?` = strict,
    // `?^` = unboxed strict, `?#` = strict unboxed), also applied to
    // constructors (`?^Just x`). All four markers lex as ONE token so the
    // strict/unboxed prefix is never mistaken for an operator run. Higher
    // precedence than `builtin_question_type`: `? x` binds the marker to the
    // type rather than treating `?` as a bare type followed by another atom.
    question_type: ($) => prec.left(2, seq($.question_marker, $._type_atom)),

    // `?`, `?^`, `?#` as complete types on their own — special pragma members
    // declare the builtins: `special m= ?; m= ?^`.
    builtin_question_type: ($) => prec(1, $.question_marker),

    // `()` — the unit type
    unit_type: ($) => seq("(", ")"),

    // List types cover all four bracket flavours from the Clean report:
    //   [a]      lazy list
    //   [!a]     strict-element list        [a!]  spine-strict list
    //   [!a!]    strict + spine-strict      [|a]  overloaded list
    //   [#a]     unboxed array type         [#a!] unboxed, spine-strict
    // plus the bare type constructors `[|]`, `[!]`, `[!!]`, `[#]`, `[#!]`
    // used in `special` members and `instance length [!]`. The element is
    // optional (bare constructors) and the trailing `!` is the spine-strict
    // marker, so `[!!]` is the strict-strict constructor.
    list_type: ($) =>
      seq(
        "[",
        optional(choice($._pipe, "#")), // overloaded / unboxed marker
        optional(choice($._type, "!")), // element (bare `!` = strict constructor)
        optional("!"), // spine-strict marker
        "]",
      ),

    tuple_type: ($) => seq("(", $._type, ",", $._type, repeat(seq(",", $._type)), ")"),

    // `*World` — uniqueness attribute on a type atom. The star is a
    // dedicated high-precedence token: the generic `operator` catch-all (and
    // `operator_mul`) would otherwise win the lex in merged parse states
    // (e.g. after a type application like `Pathname Bool Bool *GeneralSt`,
    // where GLR keeps an expression path alive), leaving `*GeneralSt`
    // unparseable. Bare `*` is not used as a multi-char operator prefix in
    // real Clean code.
    uniqueness_type: ($) => prec.left(seq($.uniqueness_star, $._type_atom)),

    // `u:[a]`, `u:(St .s u:a)` — a uniqueness variable applied to a type atom.
    // (The `:` must be a dedicated token so it beats the `:` cons operator in
    // merged lexer states.)
    unique_var_type: ($) => prec.left(seq($.identifier, ":", $._type_atom)),

    // `!Int` — strictness attribute on a type atom
    strict_type: ($) => prec.left(seq("!", $._type_atom)),

    // `.a` / `.World` — the leading-dot form marks a non-unique type in Clean
    // (used in generic type signatures, e.g. `generic g a :: .a -> .b`).
    dotted_type: ($) => prec.left(seq(".", $._type_atom)),

    type_paren: ($) => seq("(", $._type, ")"),

    // `{#a}` unboxed array, `{a}` boxed array, and the fixed-size form
    // `{32#.a}` used in `_SystemStrictMaybes` instance heads — the `#`
    // follows the element count, not the opening brace.
    array_type: ($) =>
      seq(
        "{",
        optional(choice("!", "#")),
        optional(seq($.number, "#")),
        $._type,
        "}",
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Classes, instances, generics
    // ─────────────────────────────────────────────────────────────────────

    // `class Foo a | Bar a where ...`
    // `class (==) infixl 5 a :: a a -> Bool | Eq a`
    //
    // The class name may be a plain identifier or a parenthesised operator.
    // When the class is an operator, its fixity follows the name
    // (`class (==) infixl 5 ...`), matching Clean's concrete syntax.
    class_declaration: ($) =>
      seq(
        "class",
        field("name", $.class_name),
        optional($.fixity_annotation),
        // `.l e` — class parameters may carry the leading-dot (non-unique)
        // marker (`class List .l e`).
        repeat1(field("parameter", choice($.type_variable, $.dotted_type))),
        optional(seq("::", field("type", $._type), optional(";"))),
        field("context", optional($.class_context)),
        optional(
          choice(
            seq(
              "where",
              // Same INLINE level as function where_blocks: members are
              // declarations whose own guards/`=`-continuations sit at the
              // member column and must not be separated.
              $._inline_layout_start,
              layoutBlockMembers($, $.class_member),
            ),
            // `where { m1; m2; }` — explicit brace layout (stdlib `_System*`
            // modules).
            seq("where", bracedBlockMembers($, $.class_member)),
          ),
        ),
        // `.dcl` files close braced class bodies with `};` (the trailing `;`
        // mirrors the module header's).
        optional($._semi),
      ),

    class_name: ($) =>
      choice(
        $.constructor,
        $.identifier,
        $._operator_symbol,
        $.parenthesized_operator,
        $.parenthesized_name,
      ),

    // A class member is a type signature, a macro definition
    // (`(<>) x y :== ...`, `inc x :== ...`) or an operator definition.
    class_member: ($) =>
      choice($.type_signature, $.macro_definition, $.operator_definition),

    // `instance Foo (Bar a) | Baz a where ...`
    // `instance + Int where ...`
    // `instance (==) [a] where ...`
    instance_declaration: ($) =>
      seq(
        "instance",
        field("name", $.instance_class),
        repeat1(field("argument", $._type_atom)),
        field("context", optional($.class_context)),
        // `instance <<< Int :: !*File !Int -> *File :== code { ... }` — an
        // instance may carry a signature and an inline ABC-code body. The
        // signature may end with a context (`:: a -> a | Eq a`), mirroring
        // type_signature.
        optional(
          seq(
            "::",
            field("type", $._type),
            field("context", optional($.class_context)),
            optional($.uniqueness_constraints),
          ),
        ),
        optional(seq(":==", field("body", $._expression))),
        optional(
          choice(
            seq(
              "where",
              // Same INLINE level as function where_blocks: members are
              // declarations whose own guards/`=`-continuations sit at the
              // member column and must not be separated.
              $._inline_layout_start,
              layoutBlockMembers($, $.instance_member),
            ),
            // `where { m1; m2 }` — explicit brace layout (stdlib `_System*`
            // modules).
            seq("where", bracedBlockMembers($, $.instance_member)),
          ),
        ),
        optional($._semi),
      ),

    // An instance's class may be an operator written bare (`+`, `==`) or
    // parenthesised (`(==)`, `(o)`), a lowercase class name (`zero`,
    // `toBool`), or an ordinary constructor.
    instance_class: ($) =>
      choice(
        $.constructor,
        $.identifier,
        $._operator_symbol,
        $.parenthesized_operator,
        $.parenthesized_name,
      ),

    // An instance body member: a type signature, function/operator definition
    // or macro — e.g. `(+) :: !Int !Int -> Int` followed by `(+) a b = ...`.
    instance_member: ($) =>
      choice($.type_signature, $.function_declaration, $.operator_definition, $.macro_definition),

    // `generic g a :: ...`
    generic_declaration: ($) =>
      seq(
        "generic",
        field("name", $.identifier),
        repeat1(field("parameter", $.type_variable)),
        // `generic bimap a b | bimap b a :: .a ->.b` — the dual-generic
        // context: the same generic function with its arguments reversed.
        optional(seq($._pipe, field("context", $.identifier), repeat(field("context_arg", $.type_variable)))),
        "::",
        $._type,
      ),

    // `derive g [a]` / `derive g []` / `derive g (->)`
    derive_declaration: ($) =>
      seq(
        "derive",
        field("name", $.identifier),
        repeat1(choice($._type_atom, $.parenthesized_operator)),
      ),

    // `special a=Int` (with `a=Char` on deeper lines) — specialization
    // pragmas that follow a type signature or instance declaration in
    // definition modules, requesting specialised instances for overloaded
    // functions. The members are `typevar = type` pairs laid out as a block;
    // the first member may sit on the `special` line itself (`special a=Int`),
    // with continuation members on deeper lines (scanner step 2b).
    //
    // Both layout-start tokens are offered so the scanner can recognise the
    // mid-line (inline first member) case: only this rule has start AND
    // inline valid together, which lets the scanner defer the block level to
    // the continuation lines without confusing `let`/`case` (start-only) or
    // `where`/`with` (inline-only).
    special_block: ($) =>
      seq(
        "special",
        optional(choice($._layout_start, $._inline_layout_start)),
        layoutBlockMembers($, $.special_member),
      ),

    // A member binds one type variable (`a=Int`) or several, comma-separated
    // (`l=[#],e=Int`); `;` separates members on the same line.
    special_member: ($) =>
      seq(
        field("variable", $.type_variable),
        "=",
        field("type", $._type_atom),
        repeat(seq(",", field("variable", $.type_variable), "=", field("type", $._type_atom))),
      ),

    // `bimap{|PAIR|} bx by = ...` — a generic case definition: the generic
    // function's name followed by `{|kind|}` selecting the type constructor it
    // specializes. The kind is a type variable (`c`), a constructor (`PAIR`)
    // or a parenthesised operator (`(->)`). Patterns and body are exactly like
    // a function declaration (including guards and a trailing where block).
    generic_case_definition: ($) =>
      prec.left(
        seq(
          field("name", $.identifier),
          seq(
            "{",
            $._pipe,
            // The kind is a type constructor or variable: `c`, `PAIR`, `(->)`,
            // or `*` (the product/tuple constructor, lexed as operator_mul).
            field("kind", choice($.type_variable, $.constructor, $.parenthesized_operator, $.operator_mul)),
            $._pipe,
            "}",
          ),
          repeat(field("pattern", $._pattern)),
          choice(
            seq("=", field("body", $._expression), optional($._where_or_with)),
            seq(
              repeat1(seq($.guard_equation, optional($.with_block))),
              optional(seq("=", field("body", $._expression), optional($.with_block))),
              optional($.where_block),
            ),
          ),
        ),
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Macros & functions
    // ─────────────────────────────────────────────────────────────────────

    // `name args :== body` — a macro (also `(op) x y :== body`,
    // `` (`bind`) f g :== ... ``)
    macro_definition: ($) =>
      seq(
        // Exported macros use capitalized names (`LengthM xs :== length_ 0 xs`),
        // which lex as constructors.
        field("name", choice($.identifier, $.constructor, $.parenthesized_operator, $.parenthesized_name)),
        repeat($._pattern),
        ":==",
        field("body", $._expression),
        optional($._where_or_with),
        // `create_files :== Files;` — .icl synonyms carry a trailing `;`
        optional($._semi),
      ),

    // `name pat... = expr`
    // `name pat... | guard = expr ...` — guards may end with a bare `= expr`
    // fallback (Clean's "otherwise" alternative, e.g. `| x > 0 = 1 = 0`)
    function_declaration: ($) =>
      prec.left(
      seq(
        // Exported functions use capitalized names (`Init [|] = ...`), which
        // lex as constructors.
        field("name", choice($.identifier, $.constructor)),
        repeat(field("pattern", $._pattern)),
          choice(
            // `f x = e` and the strict form `f x =: e` (used by Clyde's
            // `name =: accUnsafe f` and stdlib guard alternatives like
            // `isJustU nothing =: ?|None`).
            seq(choice("=", "=:"), field("body", $._expression), optional($._where_or_with), optional($._semi)),
            seq(
              // Guard lists may MIX guards, let-before bindings and bodies at
              // one level (`| not ok` ... `# (a,b) = get` ... `| isJust a`):
              //
              //   | not ok
              //       = ps
              //   # (postlink,project) = PR_GetPostlink project
              //   | isJust postlink
              //       # (Just post_link) = postlink
              //       = ps
              //
              // The FIRST member must be a guard (a `#` binding starts the
              // binding branch below — keeping the branches disjoint). The
              // scanner emits a layout semicolon before a same-column guard
              // when the function sits inside a block (e.g. a where binding)
              // — the enclosing block's member separator is offered even
              // though the `|` continues THIS function's own guard list.
              // Accept an optional semicolon so that case survives.
              optional($._layout_semicolon),
              $.guard_equation,
              repeat(
                seq(
                  optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
                  choice(
                    seq($.guard_binding, optional($.with_block)),
                    seq($.guard_body, optional($.with_block)),
                    $.guard_equation,
                  ),
                ),
              ),
              optional($.where_block),
            ),
            // `f x` / `# y = g x` / `= body` — let-before bindings without
            // guards (`fopen s i w` then `# (b,f) = fopen_ s i;` then
            // `= (b,f,w);`). The first member is a `#` binding (never a bare
            // body, which would make every `f x = e` ambiguous); it must be
            // followed by at least one more binding or body (a lone binding
            // is not a complete definition). Members are separated by `;`,
            // layout semicolons, or mere line adjacency (`# b = fclose_ f`
            // on one line, `= (b,w)` on the next). The repeat1 makes the
            // separator after the FIRST binding a forced shift — a repeat
            // (zero allowed) would let prec.left reduce the declaration
            // there instead of consuming the `;`. Guards are allowed after
            // the bindings too (`# a = 1;` `| a > 0` `= 2`).
            seq(
              seq($.guard_binding, optional($.with_block)),
              repeat1(
                seq(
                  optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
                  choice(
                    seq($.guard_binding, optional($.with_block)),
                    seq($.guard_body, optional($.with_block)),
                    $.guard_equation,
                  ),
                ),
              ),
              optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
              optional($.where_block),
            ),
          ),
        ),
      ),

    // `(op) pat... = expr` — a function/operator defined as an operator, e.g.
    // an instance method `(+) x y = x`. Kept separate from function_declaration
    // to avoid the `identifier (` pattern/application ambiguity.
    operator_definition: ($) =>
      // Not prec.left — same reason as function_declaration: the trailing `;`
      // ambiguity must stay a live GLR conflict.
      seq(
        // symbols-only `operator` — same rationale as signature_name: `mod`
        // etc. must not leak into declaration-start states.
        field("name", choice($.operator, $.parenthesized_operator, $.parenthesized_name)),
        repeat(field("pattern", $._pattern)),
          choice(
            seq(choice("=", "=:"), field("body", $._expression), optional($._where_or_with), optional($._semi)),
            seq(
              // First member must be a guard; the continuation may mix
              // bindings and bodies (see function_declaration).
              optional($._layout_semicolon),
              $.guard_equation,
              repeat(
                seq(
                  optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
                  choice(
                    seq($.guard_binding, optional($.with_block)),
                    seq($.guard_body, optional($.with_block)),
                    $.guard_equation,
                  ),
                ),
              ),
              optional($.where_block),
            ),
            // let-before bindings without guards (see function_declaration)
            seq(
              seq($.guard_binding, optional($.with_block)),
              repeat1(
                seq(
                  optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
                  choice(
                    seq($.guard_binding, optional($.with_block)),
                    seq($.guard_body, optional($.with_block)),
                    $.guard_equation,
                  ),
                ),
              ),
              optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
              optional($.where_block),
            ),
          ),
        ),

    // `| cond = body` (inline) or the nested form `| cond` followed by a
    // deeper block of `# pat = expr` let-before bindings and `= expr` bodies
    // (the trailing bodies are the "otherwise" alternatives). A body or
    // binding may carry a trailing `with` block (`= ([x:ys],zs) with
    // (ys,zs) = span p xs`):
    //   | p x
    //       # (ys,zs) = span xs
    //       = ([|x:ys],zs)
    //       = ([|],list)
    guard_equation: ($) =>
      seq(
        $._pipe,
        field("condition", $._expression),
        choice(
          seq("=", field("body", $._expression), optional($.with_block)),
          seq(
            $._layout_start,
            layoutBlockMembers(
              $,
              choice(
                $.guard_equation,
                seq($.guard_binding, optional($.with_block)),
                seq($.guard_body, optional($.with_block)),
              ),
            ),
            optional($._layout_end),
          ),
        ),
      ),

    // `= expr` or `-> expr` — case alternatives and guard blocks use `->`
    // bodies (Clyde: `_ -> (defaultCO.neverTimeProfile,ps)`), while
    // function guards use `=`. The arrow MUST be the dedicated `arrow`
    // token (prec 10), not a literal `"->"` — the literal loses the lex to
    // the generic `operator` catch-all in merged states and the `->` body
    // would be swallowed as a binary operator.
    guard_body: ($) => seq(choice("=", $.arrow), field("body", $._expression)),

    guard_binding: ($) =>
      seq(choice("#", "#!"), field("pattern", $._pattern), "=", field("value", $._expression)),

    // shared shape for `where`/`with` local-binding blocks
    _where_or_with: ($) =>
      choice($.where_block, $.with_block),

    // `where`/`with` blocks hold one or more local bindings. Each member must
    // be followed by a layout semicolon (more members) or a layout end (block
    // closes) — never an optional semicolon, which lets `source_file` swallow
    // the separator so the remaining members silently escape to top level.
    // The block-start uses `_inline_layout_start` (not `_layout_start`): a
    // `where`/`with` may open its block on the SAME line as its binding (e.g.
    // `... = b with (ys,zs) = span p xs`), and the scanner must push a layout
    // level for that line's indentation so a later dedent can close the block.
    where_block: ($) =>
      seq(
        "where",
        $._inline_layout_start,
        layoutBlockMembers($, $.local_binding),
      ),

    with_block: ($) =>
      seq(
        "with",
        $._inline_layout_start,
        layoutBlockMembers($, $.local_binding),
      ),

    local_binding: ($) =>
      choice(
        prec(2, $.type_signature),
        prec(2, $.function_declaration),
        prec(2, $.operator_definition),
        prec(2, $.macro_definition),
        // pattern binding: `let (r,st1) = f st0`, `where [x:xs] = ...` — the
        // LHS is a pattern that cannot be a function name (a plain `x = e` is
        // already a `function_declaration`).
        prec(1, seq(
          field("pattern", choice($.tuple_pattern, $.list_pattern, $.record_pattern, $.paren_pattern, $.lazy_pattern, $.strict_pattern, $.wildcard)),
          "=",
          field("value", $._expression),
        )),
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Patterns
    // ─────────────────────────────────────────────────────────────────────

    _pattern: ($) =>
      choice(
        $.wildcard,
        $.constructor_pattern,
        $.identifier,
        $.strict_binding_pattern,
        $.lazy_pattern,
        $.strict_pattern,
        $.number,
        $.string,
        $.char,
        $.tuple_pattern,
        $.list_pattern,
        $.record_pattern,
        $.paren_pattern,
        $.unit_pattern,
        $.unboxed_pattern,
        $.record_update_pattern,
      ),

    // `ds & modpaths` — a record-update pattern used in let-before bindings
    // (`# ds & modpaths = [!next : ds.modpaths]`).
    record_update_pattern: ($) =>
      prec(1, seq(
        $.identifier,
        "&",
        repeat1(seq(optional(","), $.identifier)),
      )),

    wildcard: ($) => "_",

    lazy_pattern: ($) => prec(PREC.UNARY, seq("~", $._pattern)),

    // `x=:pat` — a strict pattern binding (evaluate the argument, then match
    // against `pat`), e.g. `drop n cons=:[a:x] = ...`. The `=:` is a distinct
    // two-character token from the definition `=`.
    strict_binding_pattern: ($) =>
      prec(PREC.UNARY, seq($.identifier, $.strict_equal, $._pattern)),

    strict_pattern: ($) => prec(PREC.UNARY, seq("!", $._pattern)),

    // `?|C args` / `?^C args` — an unboxed constructor application used as a
    // pattern (`mapMaybe f (?|Just x) = ...`, `(==) ?^None maybe = ...`).
    unboxed_pattern: ($) =>
      prec(PREC.UNARY, seq($.question_marker, $.constructor_pattern)),

    // `Cons a (List a)` — zero or more arguments so nullary constructors
    // (`True`, `Nothing`) can stand alone as patterns.
    constructor_pattern: ($) =>
      prec.left(
        seq(
          field("constructor", $.constructor),
          repeat(field("argument", $._pattern_atom)),
        ),
      ),

    // `(a, b, c)`
    tuple_pattern: ($) =>
      seq("(", $._pattern, ",", $._pattern, repeat(seq(",", $._pattern)), ")"),

    // `[a, b]` or `[h:t]` (cons pattern) or `[]` (empty list)
    // `[|x:xs]`, `[|]` — overloaded-list patterns (`|` after the bracket)
    // `[!]`, `[!!]`, `[#]`, `[#!]` — strict/unboxed list CONSTRUCTORS used as
    // patterns (e.g. `f (DComp force dircache (Pers inf) [!] ds) ps = ...`).
    list_pattern: ($) =>
      seq(
        "[",
        optional(choice("!", "!!", "#", "#!", $._pipe)),
        optional(
          seq(
            $._pattern,
            repeat(
              seq(
                optional(choice(",", ":")),
                $._pattern,
              ),
            ),
            optional(","),
          ),
        ),
        optional("!"), // spine-strict marker: `[a:b!]`
        "]",
      ),

    // `{ x = a, y = b }` — also the shorthand `{x, y}` (= `{x = x, y = y}`)
    record_pattern: ($) =>
      seq(
        "{",
        repeat1(
          seq(
            field("field", $.identifier),
            optional(seq("=", $._pattern)),
          ),
        ),
        repeat(seq(",", seq(field("field", $.identifier), optional(seq("=", $._pattern))))),
        "}",
      ),

    paren_pattern: ($) => seq("(", $._pattern, optional($.operator), ")"),

    // `()` — the unit pattern (paren_pattern needs at least one sub-pattern,
    // so the empty form must be its own rule). Lower precedence than the unit
    // expression: the two share a GLR state and tree-sitter picks one on
    // lookahead alone, so the expression interpretation wins ties.
    unit_pattern: ($) => prec(1, seq("(", ")")),

    _pattern_atom: ($) =>
      choice(
        $.wildcard,
        $.identifier,
        $.constructor,
        $.number,
        $.string,
        $.char,
        $.tuple_pattern,
        $.list_pattern,
        $.record_pattern,
        // nested parenthesised patterns as constructor arguments, e.g.
        // `DComp force dircache (Pers inf) [!] ds` (Clean is fully curried —
        // `(Pers inf)` is just an argument, not a tuple)
        $.paren_pattern,
        $.unit_pattern,
        $.unboxed_pattern,
        // `compinfo=:(Pers _)` — strict as-pattern as a constructor argument
        $.strict_binding_pattern,
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Expressions
    // ─────────────────────────────────────────────────────────────────────

    _expression: ($) =>
      choice(
        // Keyword-triggered expressions first so they aren't swallowed
        // by the left-recursive binary_expression chain.
        $.case_expression,
        $.if_expression,
        $.let_expression,
        $.let_before_expression,
        $.lambda_expression,
        $.list_comprehension,
        $.array_comprehension,
        // Then the Pratt ladder + compound forms
        $.binary_expression,
        $.unary_expression,
        $.application,
        $.field_access,
        $.index_access,
        $.list_expression,
        $.tuple_expression,
        $.array_expression,
        $.record_expression,
        $.record_update,
        $.range_expression,
        $.code_expression,
        $._expression_atom,
      ),

    // Pratt-style precedence ladder for binary operators.
    //
    // Clean operators have user-declared precedence, so a static tree cannot
    // perfectly mirror runtime precedence for *arbitrary* user operators. We
    // therefore do two things:
    //   1. Give the well-known built-in operators their own per-tier tokens
    //      (`_op_mul`, `_op_add`, ...) with lexical precedence, so that
    //      `2 + 3 * 4` correctly nests as `2 + (3 * 4)`.
    //   2. Keep a generic `operator` token (catch-all) at a default tier, so
    //      user-defined operators still parse into a well-formed
    //      `binary_expression` with left associativity.
    binary_expression: ($) =>
      choice(
        prec.left(PREC.OR, seq($._expression, field("operator", $.operator_or), $._expression)),
        prec.left(PREC.AND, seq($._expression, field("operator", $.operator_and), $._expression)),
        prec.left(PREC.COMPARE, seq($._expression, field("operator", $.operator_compare), $._expression)),
        // `m =: ?|Just _` — strict match/equality in expression position
        // (the same `=:` token that strict_binding_pattern uses in patterns)
        prec.left(PREC.COMPARE, seq($._expression, field("operator", $.strict_equal), $._expression)),
        prec.right(PREC.RANGE, seq($._expression, $.range_operator, $._expression)),
        prec.left(PREC.ADD, seq($._expression, field("operator", $.operator_add), $._expression)),
        prec.left(PREC.MULTIPLY, seq($._expression, field("operator", $.operator_mul), $._expression)),
        // `a * b` — the star token always wins the lex over operator_mul, so
        // multiplication must accept it as the operator too
        prec.left(PREC.MULTIPLY, seq($._expression, field("operator", $.uniqueness_star), $._expression)),
        prec.right(PREC.EXPONENT, seq($._expression, field("operator", $.operator_exp), $._expression)),
        prec.right(PREC.CONSTRUCTOR, seq($._expression, field("operator", $.operator_cons), $._expression)),
        // backtick-quoted infix operator: `x `bind` y`
        prec.left(PREC.ADD, seq($._expression, field("operator", $.backtick_operator), $._expression)),
        // generic fallback for any other operator symbol
        prec.left(PREC.ADD, seq($._expression, field("operator", $.operator), $._expression)),
        // dot operators (`x +++. y` — the stdlib's string append `+++.`)
        prec.left(PREC.ADD, seq($._expression, field("operator", $.operator_dot), $._expression)),
      ),

    // `~expr` — negation
    unary_expression: ($) =>
      prec(PREC.UNARY, seq(field("operator", $.operator), $._expression)),

    // Function application binds tighter than every operator. The function
    // position also accepts field/index accesses so `r.f x` (= `(r.f) x`)
    // and `a.[i] x` parse as applications of the access result.
    application: ($) =>
      prec.left(
        PREC.APPLICATION,
        seq(
          field("function", choice($._expression_atom, $.field_access, $.index_access, $.application)),
          field("argument", $._expression_atom),
        ),
      ),

    // `record.field` or `record!field` (strict field access)
    field_access: ($) =>
      prec.left(
        PREC.ACCESS,
        seq(
          field("record", choice($._expression_atom, $.field_access, $.application)),
          choice(".", "!"),
          field("field", $.identifier),
        ),
      ),

    // `array.[idx]` — array/element selection (strict form `array!.[idx]` too)
    index_access: ($) =>
      prec.left(
        PREC.ACCESS,
        seq(
          field("record", choice($._expression_atom, $.field_access, $.application)),
          optional("!"),
          ".",
          "[",
          $._expression,
          "]",
        ),
      ),

    lambda_expression: ($) =>
      prec.left(
        PREC.LAMBDA,
        seq($.lambda_start, repeat1(field("parameter", $._pattern)), choice($.arrow, "="), field("body", $._expression)),
      ),

    // `let bindings in expr`
    let_expression: ($) =>
      prec.left(
        seq(
          "let",
          optional($._layout_start),
          repeat1(seq($.local_binding, optional(choice(";", $._layout_semicolon)))),
          optional($._layout_end),
          "in",
          field("body", $._expression),
        ),
      ),

    // `# pat = expr` and `#! pat = expr` — strict local bindings (let-before)
    let_before_expression: ($) =>
      prec.left(
        seq(
          choice("#", "#!"),
          field("pattern", $._pattern),
          "=",
          field("value", $._expression),
          optional($._where_or_with),
        ),
      ),

    case_expression: ($) =>
      // NOT prec.left: a `;` after an alternative is ambiguous (continue the
      // alternative list vs. end the case) and the self-conflict below must
      // stay a live GLR fork — a prec would resolve it toward an early reduce
      // (mirroring the function_declaration `;` handling).
      seq(
        "case",
        field("subject", $._expression),
        "of",
          // The alternatives are a layout block: reference the layout tokens
          // so the scanner emits a block-start between `of` and the first
          // alternative, semicolons between alternatives (an alternative's
          // body expression would otherwise greedily swallow the next line as
          // an application argument), and a block-end on dedent. The
          // semicolon/end is REQUIRED after each alternative (mirroring
          // where_block) — an optional one would let the parser always take
          // the "stop" path and end the case early.
          choice(
            // multi-line layout alternatives (the common form)
            seq(
              optional($._layout_start),
              layoutBlockMembers($, $.case_alternative, false),
            ),
            // inline `case` — `case x of a -> 1 ; b -> 2` — sits on one line
            // (no layout level, the scanner emits no layout tokens), so the
            // alternatives are `;`-separated and the block ends at the
            // enclosing delimiter (`)`, `]`, `,`) or the line's end without a
            // required layout token. GLR (`[$.case_expression]`) keeps both
            // branches and the error-free continuation wins.
            prec(1, seq(
              $.case_alternative,
              repeat(seq(seq(";", optional($._layout_semicolon)), $.case_alternative)),
              optional(seq(";", optional($._layout_semicolon))),
            )),
          ),
        ),

    case_alternative: ($) =>
      choice(
        // with guard: pat | cond -> body
        prec(2, seq(
          field("pattern", $._pattern),
          $._pipe,
          field("condition", $._expression),
          $.arrow,
          field("body", $._expression),
        )),
        // without guard: pat -> body  or  pat = body
        prec(1, seq(
          field("pattern", $._pattern),
          choice($.arrow, "="),
          field("body", $._expression),
        )),
        // pattern followed by let-before `#`-bindings and `->`/`=` bodies
        // (Clyde: `_` then `# (prefs,ps) = getPrefs ps` then
        // `-> (defaultCO.neverTimeProfile,ps)`), mirroring the function
        // body's binding branch. Members may also be `| cond` guards whose
        // nested block holds more bindings and arrow bodies (Clyde:
        // `(FinishedCompiler ...)` then `# ... with <locals>` then
        // `| exit_code==0` `# ...` `-> body`). The `#` token starts directly
        // after the pattern — a `_layout_start` here is unreachable because
        // the greedy pattern atoms keep the parser in "pattern continuation"
        // states where no layout token is requested.
        prec(1, seq(
          field("pattern", $._pattern),
          seq($.guard_binding, optional($.with_block)),
          repeat1(
            seq(
              optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
              choice(
                seq($.guard_binding, optional($.with_block)),
                $.guard_body,
                $.guard_equation,
              ),
            ),
          ),
          optional(choice($._layout_semicolon, seq(";", optional($._layout_semicolon)))),
        )),
      ),

    // `if c then a else b` (keyword form) or `if c a b` (function form — in
    // Clean `if` is an ordinary three-argument function). The function form
    // binds tighter than application (prec 13 > APPLICATION 12) so the
    // consequence stops before the alternative: `if c a b` must not parse the
    // consequence as the application `a b`.
    if_expression: ($) =>
      choice(
        prec.left(
          seq(
            "if",
            field("condition", $._expression),
            "then",
            field("consequence", $._expression),
            "else",
            field("alternative", $._expression),
          ),
        ),
        prec.left(
          13,
          seq(
            "if",
            field("condition", $._expression_atom),
            field("consequence", $._expression_atom),
            field("alternative", $._expression_atom),
          ),
        ),
      ),

    // ---- Lists, tuples, arrays ----

    // `[1, 2, 3]` or `[h: t]` (cons)
    // `[|x:xs]`, `[|]` — overloaded-list expressions (`|` after the bracket)
    list_expression: ($) =>
      seq(
        "[",
        // the bare list CONSTRUCTORS used as values — `[!]` (strict empty),
        // `[!!]` (strict-strict), `[#]` (unboxed array), `[#!]`, `[|]`
        // (overloaded) — e.g. `continue False [!] project`
        optional(choice("!", "!!", "#", "#!", $._pipe)),
        optional(
          seq(
            $._expression,
            repeat(seq(optional(choice(",", ":")), $._expression)),
          ),
        ),
        optional("!"), // spine-strict marker: `[a:b!]`
        "]",
      ),

    // `[1..10]`, `[1, 3..n]` — dotdot range inside list brackets
    range_expression: ($) =>
      seq(
        "[",
        $._expression,
        ",",
        $._expression,
        "..",
        optional($._expression),
        "]",
      ),

    // `(a, b, c)`
    tuple_expression: ($) =>
      seq("(", $._expression, ",", $._expression, repeat(seq(",", $._expression)), ")"),

    // `{1, 2, 3}` (strict), `{!...}` (lazy), `{#...}` (unboxed)
    array_expression: ($) =>
      seq(
        "{",
        optional(choice("!", "#")),
        optional(
          seq(
            $._expression,
            repeat(seq(",", $._expression)),
            optional(seq(":", $._expression)),
          ),
        ),
        "}",
      ),

    // `{i \\ i <- [1..10]}` — array comprehension
    array_comprehension: ($) =>
      seq(
        "{",
        optional(choice("!", "#")),
        field("body", $._expression),
        $.comprehension_sep,
        repeat1(seq($.comprehension_qualifier, optional(choice(",", "&", $._pipe)))),
        "}",
      ),

    // `[x \\ x <- xs]`
    // `[x \\ x <- xs & y <- ys]` — `&` separates parallel (zipped) generators
    // `[| (x,y,z) \\ ((x,y),z) <- xs]` — overloaded-list comprehension
    list_comprehension: ($) =>
      seq(
        "[",
        optional($._pipe),
        field("body", $._expression),
        $.comprehension_sep,
        repeat1(seq($.comprehension_qualifier, optional(choice(",", "&", $._pipe)))),
        "]",
      ),

    comprehension_qualifier: ($) =>
      choice($.generator, $.guard, $.let_qualifier),

    generator: ($) =>
      seq(
        field("pattern", $._pattern),
        $.generator_sep,
        field("expression", $._expression),
      ),

    // a bare expression used as a comprehension guard
    guard: ($) => field("condition", $._expression),

    let_qualifier: ($) =>
      seq(
        "let",
        field("name", $.identifier),
        repeat(field("parameter", $._pattern)),
        "=",
        field("value", $._expression),
      ),

    // ---- Records ----

    // `{ name = "x", age = 25 }`
    record_expression: ($) =>
      seq(
        "{",
        repeat1(
          seq(
            field("name", $.identifier),
            "=",
            field("value", $._expression),
            optional(","),
          ),
        ),
        "}",
      ),

    // `{ rec & name = "new" }`  (record field update)
    // `{ arr  & [i] = v }`      (array element update)
    record_update: ($) =>
      seq(
        "{",
        field("record", $._expression),
        "&",
        repeat1(
          seq(
            optional(","),
            field("field", $.update_field),
            "=",
            field("value", $._expression),
          ),
        ),
        "}",
      ),

    // The LHS of one update binding: either a record field name or an array
    // index. For array element updates Clean allows a range too: `& [i..j] = v`.
    update_field: ($) =>
      choice(
        $.identifier,
        seq("[", $._expression, optional(seq("..", optional($._expression))), "]"),
      ),

    // ---- ABC inline code ----
    // `= code { ... }`
    code_expression: ($) =>
      seq(
        "code",
        optional(choice("inline", "apply")),
        "{",
        repeat($.abc_instruction),
        "}",
      ),

    abc_instruction: ($) => token(/[^{}]+/),

    // ─────────────────────────────────────────────────────────────────────
    // Atoms (leaves of the expression tree)
    // ───────────────────────────────────────────────────────────────── atoms are parsed via dedicated
    // rules below. A qualified identifier is `Module.name`.

    // An argument (or function) of an application. In Clean a compound
    // expression can be applied directly: `map f [1,2]`, `f (1,2)`, `g {x=1}`.
    _expression_atom: ($) =>
      choice(
        $.qualified_identifier,
        $.parenthesized_operator,
        $.constructor,
        $.identifier,
        $.boolean,
        $.number,
        $.string,
        $.char,
        $.paren_expression,
        $.tuple_expression,
        $.list_expression,
        $.range_expression,
        $.list_comprehension,
        $.array_comprehension,
        $.array_expression,
        $.record_expression,
        $.record_update,
        $.lambda_expression,
        $.code_expression,
        $.kind_expression,
        $.unit_expression,
        // `?|C args` / `?^C args` — an unboxed constructor application in an
        // expression (`maybeToList ?|None`, `?|Just (f x)`).
        $.unboxed_expression,
      ),

    unboxed_expression: ($) =>
      prec(PREC.UNARY, seq($.question_marker, $._expression_atom)),

    // `(x)` normally holds an expression; `(++||)` — an operator that cannot
    // lex as the dedicated `parenthesized_operator` token (e.g. one containing
    // `|`) — is a parenthesised operator used as a function value. Operators
    // that *can* lex as `parenthesized_operator` (`(+)`, `(==)`) never reach
    // here: the longer token wins in the lexer.
    paren_expression: ($) =>
      seq("(", $._expression, ")"),

    // `()` — the unit value (paren_expression needs at least one sub-expression)
    unit_expression: ($) => prec(2, seq("(", ")")),

    // `Module.function` / `Module.Type`
    qualified_identifier: ($) =>
      prec.left(
        PREC.ACCESS,
        seq(
          field("module", $.constructor),
          ".",
          field("name", $.identifier),
        ),
      ),

    // `{|*|}` / `{|PAIR|}` / `{|c|}` — a generic kind used as an expression
    // (e.g. `bx = bimap{|*|}` refers to the generic function specialised at
    // the product constructor).
    kind_expression: ($) =>
      seq(
        "{",
        $._pipe,
        field("kind", choice($.type_variable, $.constructor, $.parenthesized_operator, $.operator_mul)),
        $._pipe,
        "}",
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Lexical tokens
    // ─────────────────────────────────────────────────────────────────────

    // A constructor is an identifier beginning with an uppercase letter.
    // Declared before `identifier` so the more-specific rule wins. Trailing
    // backticks are allowed in Clean identifiers (`xs``, like Haskell primes).
    constructor: ($) => /[A-Z][a-zA-Z0-9_'`]*/,

    identifier: ($) => /[a-z_][a-zA-Z0-9_'`]*/,

    // Operator symbols.
    //   - `.` and `!`: handled by field_access / index_access / record-update
    //     rules to avoid ambiguity with record/qualified names.
    //   - `=`, `|`, `@`: reserved separators (= in defs, | in ADTs/guards, @
    //     in annotations), never user operators.
    //   - `&`: reserved as the record/array-update separator (`{r & f = x}`).
    //     The boolean operators `&&` and `||` have their own dedicated tokens
    //     with higher lexical precedence, so they win over the catch-all.
    //   - The well-known operators get their own per-tier tokens (see below);
    //     `operator` is the catch-all for user-defined operators.
    // Comprehension separator — must be a dedicated high-precedence token
    // to beat `operator_mul` (`\`) + `operator_mul` (`\`) tokenization.
    comprehension_sep: ($) => token(prec(10, "\\\\")),

    // Lambda introducer: a dedicated token whose lexical precedence beats
    // the catch-all `operator` (prec 1), so `\x -> x` starts the lambda rule
    // instead of lexing `\` as a unary operator.
    lambda_start: ($) => token(prec(2, "\\")),

    // `(op)` — a parenthesised operator used as a name (`(+) :: ...`,
    // `(op) x y :== ...`, class/instance heads) or as an operator section
    // (`f = (==)`). Also `` (`bind`) `` for backtick-quoted names. Lexed as a
    // single token so the per-tier operator tokens (`==`, `+`, ...) cannot
    // win inside the parens in a merged parse state.
    parenthesized_operator: ($) =>
      token(
        choice(
          // `.` is a valid Clean operator symbol (`(+++.)`); it is safe here
          // because inside the parens it cannot collide with field access
          // (`r.f`) or qualified names (`M.f`), which use a bare `.`.
          // `:` is also valid (`(:=)`, `(::)`? — the stdlib uses `(:=)`).
          seq("(", /[~%^*+\-\\<>\/?!#$&=@.:|]+/, ")"),
          seq("(", "`", /[a-zA-Z_][a-zA-Z0-9_']*/, "`", ")"),
        ),
      ),

    // `` `name` `` — a backtick-quoted identifier used as an infix operator
    // (`` x `bind` y ``). Clean also allows trailing backticks in plain
    // identifiers (`xs``), which the identifier regexes already cover.
    backtick_operator: ($) => token(seq("`", /[a-zA-Z_][a-zA-Z0-9_']*/, "`")),

    // `(o)`, `(bitand)` — a parenthesised alphanumeric name used as an
    // operator name (`(o) infixr 9;`, `(bitand) infixl 6 :: ...`). Kept as a
    // separate rule (not part of the `parenthesized_operator` token) so that
    // `(x)` in expression or pattern position stays a `paren_expression` or
    // `paren_pattern`.
    parenthesized_name: ($) => seq("(", $.identifier, ")"),

    // A bare operator in a *name* position: context head (`| == a`),
    // instance head (`instance == [a]`), fixity declaration (`infixl 6 +`)
    // or import (`from StdBool import &&`). Dedicated token with high lexical
    // precedence so the per-tier operator tokens (`operator_compare`, ...)
    // cannot win in a merged parse state. `=` is included for `==`/`<=`/`>=`;
    // a lone `=` is not a valid operator name and simply fails in these
    // positions. Only valid in name positions, so normal infix parsing is
    // unaffected.
    // Any operator symbol in a NAME position (class/instance names, context
    // heads, fixity, imports, signatures). Accepts every operator token: the
    // tiered ones (`==`, `+`, `<>`, ... lex as operator_compare/operator_add/
    // ...) and the generic `operator` fallback (`++`, `~`, ...). There is no
    // special high-precedence catch-all token here: one would steal the first
    // symbol of a longer tiered operator (e.g. `<=` would lex as `<`).
    _operator_symbol: ($) =>
      choice(
        $.operator_compare,
        $.operator_add,
        $.operator_mul,
        $.operator_exp,
        $.operator_cons,
        $.operator_and,
        $.operator_or,
        // bare `*` names (`instance * Int`, `infixl 6 *`)
        $.uniqueness_star,
        $.operator,
        $.operator_dot,
      ),

    // Comprehension generator separator — a dedicated high-precedence token so
    // `x <- xs` lexes as one token instead of `operator_compare` (`<`) followed
    // by a unary `-`. A guard like `x < 3` (with whitespace) still lexes `<`
    // alone because the token requires the adjacent `-`.
    generator_sep: ($) => token(prec(10, "<-")),

    // Arrow — must be a dedicated high-precedence token to beat
    // `operator_add` (`-`) + `operator_compare` (`>`) tokenization.
    arrow: ($) => token(prec(10, "->")),

    // Generic fallback operator. IMPORTANT: every operator token (the tiers
    // below AND this catch-all) must share the SAME lexical precedence.
    // tree-sitter's lexer DFA prunes a continuation when its precedence is
    // LOWER than a token that completes earlier (`prefer_transition`): if the
    // catch-all had a lower precedence than `operator_add`/`operator_mul`, the
    // lexer would stop at `+`/`*` and a longer user operator such as `+++` or
    // `**` could never lex as one token (it would split into `+` + `++`). With
    // equal precedence the DFA keeps the continuation, longest-match picks the
    // full run, and declaration order (this rule comes LAST) resolves ties so
    // the specific tokens still win at their exact strings (`+` → operator_add,
    // `==` → operator_compare). The `arrow`/`generator_sep` tokens keep higher
    // precedences (10) so `->`/`<-` still beat `-`/`<`.
    operator_exp: ($) => token(prec(1, "^")),
    operator_mul: ($) => token(prec(1, choice("*", "/", "%", "\\", "mod", "rem"))),
    operator_add: ($) => token(prec(1, choice("+", "-", "<<<", ">>>"))),
    // `:` cons operator. Token precedence 0 (equal to the literal `::`): at
    // `::` the longer literal wins by longest-match, so `::` never splits
    // into two cons operators in merged lexer states.
    operator_cons: ($) => token(prec(0, ":")),
    operator_compare: ($) => token(prec(1, choice("==", "<>", "<", ">", "<=", ">="))),
    // Statement separator. Precedence 1 beats the default 0 of the rules it
    // separates, so a `;` after a member (case alternative, let-before
    // binding, ...) SHIFTS to continue the member list instead of reducing
    // the enclosing rule early (which would strand the remaining members at
    // the top level). The fixity `;` (line 325) stays a bare literal — it
    // has no such ambiguity.
    _semi: ($) => token(prec(1, ";")),
    operator_and: ($) => token(prec(1, choice("&&", "and"))),
    operator_or: ($) => token(prec(2, choice("||", "or"))),
    // `?`, `?^`, `?#`, `?|` — Clean's strictness/unboxed marker prefixes
    // (`?x` strict type, `?^x`/`?#x` unboxed, `?|C`/`?^C` unboxed constructor
    // applications in patterns/expressions). A dedicated token with lexical
    // precedence 2 beats the catch-all `operator` (prec 1) at equal length,
    // and it covers `?#`, which the operator alphabet cannot lex at all
    // (`#` is not an operator symbol).
    question_marker: ($) => token(prec(2, choice("?", "?^", "?#", "?|"))),

    // `*` — the uniqueness attribute star. High lexical precedence so it beats
    // `*` — the uniqueness attribute star. High lexical precedence so it beats
    // `operator_mul` and the generic `operator` catch-all in every state; bare
    // `*` never starts a multi-char operator in real Clean code (all `**`/
    // `*>` runs live in comments), so stealing the single char is safe.
    uniqueness_star: ($) => token(prec(2, "*")),

    // `=:` — strict match/equality: an infix operator in expressions
    // (`m =: ?|Just _`) and the strict pattern-binding marker (`x=:pat`).
    // Dedicated token (prec 2) so it is never split or out-lexed in either
    // position.
    strict_equal: ($) => token(prec(2, "=:")),

    // Catch-all for any other operator run (`+++`, `***`, `<-+-`, ...).
    // The catch-all user operator. `|` is included so operators like `++|`
    // and `++||` (overloaded-list append, StdOverloadedList) lex as one
    // token. A lone `|` in a guard/context/`[|` position still lexes as the
    // literal `|` (literals have implicit precedence 2, beating this token's
    // explicit 1 at equal length), so those uses are unaffected.
    // The literal `|` used in guards (`f x | p = b`), contexts (`| Eq a`),
    // overloaded-list markers (`[|x:xs]`) and generic kind brackets
    // (`{|PAIR|}`). Explicit lexical precedence 2 so it beats the catch-all
    // `operator` (prec 1) at equal length — otherwise `[|]` would lex `|` as
    // a unary operator. `||` (operator_or) is longer, so it still wins.
    _pipe: ($) => token(prec(2, "|")),

    operator: ($) => token(prec(1, /[~%^*+\-\\<>\/?|$]+/)),

    // `x +++. y` — operators containing a `.` (e.g. the stdlib's string
    // append `+++.`). Requires at least one leading operator character so a
    // bare `.` (field access `r.f`, qualified name `M.f`, range `..`) can
    // never match it. Same lexical precedence (1) as the generic `operator`
    // fallback: at a dot-operator the longer match (`+++.` over `+++`) wins
    // by longest-match.
    operator_dot: ($) => token(prec(1, /[~%^*+\-\\<>\/?|$]+\.[~%^*+\-\\<>\/?|$]*/)),

    range_operator: ($) => token(prec(2, "..")),

    boolean: ($) => choice("True", "False"),

    integer: ($) => /[0-9]+/,
    float: ($) => /[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+/,

    number: ($) =>
      choice(
        seq(optional(/[~]/), choice($.float, $.integer)),
        /0[xX][0-9a-fA-F]+/, // hex
      ),

    string: ($) => /"([^"\\]|\\.)*"/,

    // Char literals: `'a'`, `'\n'`, `'\''`, and octal escapes like `'\177'`
    // (backslash + 1-3 octal digits).
    char: ($) => /'([^'\\]|\\([0-9]{1,3}|[^0-9]))'/,

    // `//` is always a line comment in Clean (the language reserves it — it
    // can never be an operator), so it must out-prioritise every operator
    // token (highest is operator_exp at 9). `/.*/` must not cross newlines.
    line_comment: ($) => token(prec(100, seq("//", /[^\n]*/))),
    // block_comment is EXTERNAL so nested /* ... /* ... */ ... */ balances.
  },
});
