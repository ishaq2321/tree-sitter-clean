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
    // comprehension generator body is an expression; in `case`/`with`/let the
    // same tokens could start a pattern. Disambiguate expression vs. pattern.
    [$._pattern, $._expression_atom],
    // function vs. macro LHS both start with `name pat...`
    [$.function_declaration, $.macro_definition],
    // class head: trailing type variables vs. context parsing
    [$.class_declaration],
    // derive argument list ambiguity
    [$.derive_declaration],
    // instance head: `instance Foo (Bar a)` — parenthesised type vs. tuple
    [$.instance_declaration],
    // where_block repeat1 ambiguity
    [$.where_block],
    [$.with_block],
    [$.case_expression],
    [$.macro_definition, $.function_declaration, $.let_qualifier],
    [$.function_declaration, $.let_qualifier],
    [$.type_signature],
    [$.list_pattern, $.list_expression],
  ],

  rules: {
    // ─────────────────────────────────────────────────────────────────────
    // Top level
    // ─────────────────────────────────────────────────────────────────────

    source_file: ($) =>
      seq(
        optional($._layout_start),
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
        $.class_declaration,
        $.instance_declaration,
        $.generic_declaration,
        $.derive_declaration,
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

    module_identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_']*/,

    // `import M.N`
    // `import M, M2`
    // `from M import x, y, :: Type`
    import_declaration: ($) =>
      prec.left(
        seq(
          choice(
            seq("import", field("module", $.module_name), repeat(seq(",", field("module", $.module_name)))),
            seq(
              "from",
              field("module", $.module_name),
              "import",
              repeat1($._import_item),
            ),
          ),
        ),
      ),

    _import_item: ($) =>
      seq(
        optional("::"),
        choice($.identifier, $.constructor, $.operator),
        repeat(seq(",", optional("::"), choice($.identifier, $.constructor, $.operator))),
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Fixity / operator declarations
    //   (infixl 6) +  infixr 5 :  infix 0 ==
    // ─────────────────────────────────────────────────────────────────────

    fixity_declaration: ($) =>
      seq(
        field("associativity", choice("infix", "infixl", "infixr")),
        field("precedence", optional($.integer)),
        field("operator", $.operator),
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────

    // `name :: Type` — top-level, class-member, or local type signature.
    //
    // The name may be:
    //   - a plain identifier:        `map :: ...`
    //   - a parenthesised operator:  `(+) :: ...`
    // Optionally prefixed by a parenthesised fixity annotation:
    //   `(infixl 6) (+) :: ...`
    // A class context follows the main type:  `f :: a -> a | Eq a`
    type_signature: ($) =>
      seq(
        optional(seq("(", $.fixity_annotation, ")")),
        field("name", $.signature_name),
        "::",
        field("type", $._type),
        field("context", optional($.class_context)),
      ),

    signature_name: ($) =>
      choice(
        $.identifier,
        seq("(", $.operator, ")"),
      ),

    // `infixl 6` — the fixity/precedence annotation (also used standalone).
    fixity_annotation: ($) =>
      seq(
        choice("infix", "infixl", "infixr"),
        optional($.integer),
      ),

    // `| Eq a, Ord a` — a class context that follows a type, introduced by `|`.
    class_context: ($) =>
      prec.left(
        seq(
          "|",
          $._context_item,
          repeat(seq(",", $._context_item)),
        ),
      ),

    _context_item: ($) =>
      prec.left(
        seq($._context_head, repeat1($._type_atom)),
      ),

    // The head of a class-context assertion is a class name (constructor) or,
    // for operator classes, a parenthesised operator.
    _context_head: ($) =>
      choice($.constructor, seq("(", $.operator, ")")),

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
    type_definition: ($) =>
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
        // `:: T a` — abstract type with parameters (rare, but valid)
        prec.left(1,
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

    type_definition_body: ($) =>
      seq(
        choice("=", ":=="),
        field("rhs", $._type_rhs),
      ),

    type_variable: ($) => $.identifier,

    _type_rhs: ($) =>
      choice(
        $.data_constructors,
        $.record_definition,
        $._type, // synonym / abstract with `:==`
      ),

    // `= Cons a (List a) | Nil`
    data_constructors: ($) =>
      prec.left(
        seq($.data_constructor, repeat(seq("|", $.data_constructor))),
      ),

    data_constructor: ($) =>
      prec.left(
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
      prec.right(PREC.CONSTRUCTOR, seq($._type, "->", $._type)),

    type_application: ($) =>
      prec.left(
        seq(
          $._type_atom,
          repeat1($._type_atom),
        ),
      ),

    _type_atom: ($) =>
      choice(
        $.uniqueness_type,
        $.strict_type,
        $.dotted_type,
        $.constructor,
        $.type_variable,
        $.list_type,
        $.tuple_type,
        $.array_type,
        $.type_paren,
      ),

    list_type: ($) => seq("[", $._type, "]"),

    tuple_type: ($) => seq("(", $._type, ",", $._type, repeat(seq(",", $._type)), ")"),

    // `*World` — uniqueness attribute on a type atom
    uniqueness_type: ($) => prec.left(seq("*", $._type_atom)),

    // `!Int` — strictness attribute on a type atom
    strict_type: ($) => prec.left(seq("!", $._type_atom)),

    // `.a` / `.World` — the leading-dot form marks a non-unique type in Clean
    // (used in generic type signatures, e.g. `generic g a :: .a -> .b`).
    dotted_type: ($) => prec.left(seq(".", $._type_atom)),

    type_paren: ($) => seq("(", $._type, ")"),

    array_type: ($) => seq("{", optional(choice("!", "#")), $._type, "}"),

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
        repeat1(field("parameter", $.type_variable)),
        optional(seq("::", field("type", $._type))),
        field("context", optional($.class_context)),
        optional(
          seq(
            "where",
            optional($._layout_start),
            repeat1(seq($.class_member, optional($._layout_semicolon))),
            optional($._layout_end),
          ),
        ),
      ),

    class_name: ($) =>
      choice(
        $.constructor,
        $.identifier,
        seq("(", $.operator, ")"),
      ),

    // A class member is just a type signature, possibly with a fixity prefix.
    class_member: ($) => $.type_signature,

    // `instance Foo (Bar a) | Baz a where ...`
    // `instance + Int where ...`
    // `instance (==) [a] where ...`
    instance_declaration: ($) =>
      seq(
        "instance",
        field("name", $.instance_class),
        repeat1(field("argument", $._type_atom)),
        field("context", optional($.class_context)),
        optional(
          seq(
            "where",
            optional($._layout_start),
            repeat1(seq(choice($.function_declaration, $.operator_definition), optional($._layout_semicolon))),
            optional($._layout_end),
          ),
        ),
      ),

    // An instance's class may be an operator written bare (`+`) or
    // parenthesised (`(==)`), or an ordinary constructor.
    instance_class: ($) =>
      choice(
        $.constructor,
        $.operator,
        seq("(", $.operator, ")"),
      ),

    // `generic g a :: ...`
    generic_declaration: ($) =>
      seq(
        "generic",
        field("name", $.identifier),
        repeat1(field("parameter", $.type_variable)),
        "::",
        $._type,
      ),

    // `derive g [a]` / `derive g []`
    derive_declaration: ($) =>
      seq("derive", field("name", $.identifier), repeat1($._type_atom)),

    // ─────────────────────────────────────────────────────────────────────
    // Macros & functions
    // ─────────────────────────────────────────────────────────────────────

    // `name args :== body` — a macro
    macro_definition: ($) =>
      seq(
        field("name", $.identifier),
        repeat($._pattern),
        ":==",
        field("body", $._expression),
      ),

    // `name pat... = expr`
    // `name pat... | guard = expr ...`
    function_declaration: ($) =>
      prec.left(
        seq(
          field("name", $.identifier),
          repeat(field("pattern", $._pattern)),
          choice(
            seq("=", field("body", $._expression)),
            repeat1($.guard_equation),
          ),
          optional($._where_or_with),
        ),
      ),

    // `(op) pat... = expr` — a function/operator defined as an operator, e.g.
    // an instance method `(+) x y = x`. Kept separate from function_declaration
    // to avoid the `identifier (` pattern/application ambiguity.
    operator_definition: ($) =>
      prec.left(
        seq(
          field("name", seq("(", $.operator, ")")),
          repeat(field("pattern", $._pattern)),
          choice(
            seq("=", field("body", $._expression)),
            repeat1($.guard_equation),
          ),
          optional($._where_or_with),
        ),
      ),

    guard_equation: ($) =>
      seq("|", field("condition", $._expression), "=", field("body", $._expression)),

    // shared shape for `where`/`with` local-binding blocks
    _where_or_with: ($) =>
      choice($.where_block, $.with_block),

    where_block: ($) =>
      seq(
        "where",
        optional($._layout_start),
        repeat1(seq($.local_binding, optional($._layout_semicolon))),
        optional($._layout_end),
      ),

    with_block: ($) =>
      seq(
        "with",
        optional($._layout_start),
        repeat1(seq($.local_binding, optional($._layout_semicolon))),
        optional($._layout_end),
      ),

    local_binding: ($) =>
      choice($.type_signature, $.function_declaration, $.operator_definition, $.macro_definition),

    // ─────────────────────────────────────────────────────────────────────
    // Patterns
    // ─────────────────────────────────────────────────────────────────────

    _pattern: ($) =>
      choice(
        $.wildcard,
        $.constructor_pattern,
        $.identifier,
        $.lazy_pattern,
        $.strict_pattern,
        $.number,
        $.string,
        $.char,
        $.tuple_pattern,
        $.list_pattern,
        $.record_pattern,
        $.paren_pattern,
      ),

    wildcard: ($) => "_",

    lazy_pattern: ($) => prec(PREC.UNARY, seq("~", $._pattern)),

    strict_pattern: ($) => prec(PREC.UNARY, seq("!", $._pattern)),

    // `Cons a (List a)`
    constructor_pattern: ($) =>
      prec.left(
        seq(
          field("constructor", $.constructor),
          repeat1(field("argument", $._pattern_atom)),
        ),
      ),

    // `(a, b, c)`
    tuple_pattern: ($) =>
      seq("(", $._pattern, ",", $._pattern, repeat(seq(",", $._pattern)), ")"),

    // `[a, b]` or `[h:t]` (cons pattern) or `[]` (empty list)
    list_pattern: ($) =>
      seq(
        "[",
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
        "]",
      ),

    // `{ x = a, y = b }`
    record_pattern: ($) =>
      seq(
        "{",
        repeat1(seq(field("field", $.identifier), "=", $._pattern)),
        repeat(seq(",", seq(field("field", $.identifier), "=", $._pattern))),
        "}",
      ),

    paren_pattern: ($) => seq("(", $._pattern, optional($.operator), ")"),

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
      ),

    // ─────────────────────────────────────────────────────────────────────
    // Expressions
    // ─────────────────────────────────────────────────────────────────────

    _expression: ($) =>
      choice(
        $.binary_expression,
        $.unary_expression,
        $.application,
        $.field_access,
        $.index_access,
        $.lambda_expression,
        $.let_expression,
        $.let_before_expression,
        $.case_expression,
        $.if_expression,
        $.list_expression,
        $.list_comprehension,
        $.tuple_expression,
        $.array_expression,
        $.array_comprehension,
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
        prec.right(PREC.RANGE, seq($._expression, $.range_operator, $._expression)),
        prec.left(PREC.ADD, seq($._expression, field("operator", $.operator_add), $._expression)),
        prec.left(PREC.MULTIPLY, seq($._expression, field("operator", $.operator_mul), $._expression)),
        prec.right(PREC.EXPONENT, seq($._expression, field("operator", $.operator_exp), $._expression)),
        prec.right(PREC.CONSTRUCTOR, seq($._expression, field("operator", $.operator_cons), $._expression)),
        // generic fallback for any other operator symbol
        prec.left(PREC.ADD, seq($._expression, field("operator", $.operator), $._expression)),
      ),

    // `~expr` — negation
    unary_expression: ($) =>
      prec(PREC.UNARY, seq(field("operator", $.operator), $._expression)),

    // Function application binds tighter than every operator.
    application: ($) =>
      prec.left(
        PREC.APPLICATION,
        seq(
          field("function", choice($._expression_atom, $.application)),
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
        seq("\\", repeat1(field("parameter", $._pattern)), choice("->", "="), field("body", $._expression)),
      ),

    // `let bindings in expr`
    let_expression: ($) =>
      prec.left(
        seq(
          "let",
          optional($._layout_start),
          repeat1(seq($.local_binding, optional($._layout_semicolon))),
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
      seq(
        "case",
        field("subject", $._expression),
        "of",
        optional($._layout_start),
        repeat1(seq($.case_alternative, optional($._layout_semicolon))),
        optional($._layout_end),
      ),

    case_alternative: ($) =>
      seq(
        field("pattern", $._pattern),
        optional(seq("|", field("guard", $._expression))),
        choice("->", "="),
        field("body", $._expression),
      ),

    // `if c then a else b`
    if_expression: ($) =>
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

    // ---- Lists, tuples, arrays ----

    // `[1, 2, 3]` or `[h: t]` (cons)
    list_expression: ($) =>
      seq(
        "[",
        optional(
          seq(
            $._expression,
            repeat(seq(",", $._expression)),
            optional(seq(":", $._expression)), // tail
          ),
        ),
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
        "\\\\",
        repeat1(seq($.comprehension_qualifier, optional(","))),
        "}",
      ),

    // `[x \\ x <- xs]`
    list_comprehension: ($) =>
      seq(
        "[",
        field("body", $._expression),
        "\\\\",
        repeat1(seq($.comprehension_qualifier, optional(","))),
        "]",
      ),

    comprehension_qualifier: ($) =>
      choice($.generator, $.guard, $.let_qualifier),

    generator: ($) =>
      seq(
        field("pattern", $._pattern),
        "<-",
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

    _expression_atom: ($) =>
      choice(
        $.qualified_identifier,
        $.constructor,
        $.identifier,
        $.boolean,
        $.number,
        $.string,
        $.char,
        $.paren_expression,
      ),

    paren_expression: ($) =>
      seq("(", $._expression, ")"),

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

    // ─────────────────────────────────────────────────────────────────────
    // Lexical tokens
    // ─────────────────────────────────────────────────────────────────────

    // A constructor is an identifier beginning with an uppercase letter.
    // Declared before `identifier` so the more-specific rule wins.
    constructor: ($) => /[A-Z][a-zA-Z0-9_']*/,

    identifier: ($) => /[a-z_][a-zA-Z0-9_']*/,

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
    operator: ($) => token(prec(1, /[~%^*+\-\\<>\/?]+/)),

    range_operator: ($) => token(prec(2, "..")),

    // Per-tier built-in operators. Higher `prec` value => tighter binding.
    // `token(prec(N, ...))` gives lexical precedence so the lexer prefers the
    // specific multi-char operator (e.g. `&&`) over the catch-all `operator`.
    operator_exp: ($) => token(prec(9, "^")),
    operator_mul: ($) => token(prec(8, choice("*", "/", "%", "\\", "mod", "rem"))),
    operator_add: ($) => token(prec(7, choice("+", "-", "<<<", ">>>"))),
    operator_cons: ($) => token(prec(6, ":")),
    operator_compare: ($) => token(prec(5, choice("==", "<>", "<", ">", "<=", ">="))),
    operator_and: ($) => token(prec(4, choice("&&", "and"))),
    operator_or: ($) => token(prec(3, choice("||", "or"))),

    boolean: ($) => choice("True", "False"),

    integer: ($) => /[0-9]+/,
    float: ($) => /[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+/,

    number: ($) =>
      choice(
        seq(optional(/[~]/), choice($.float, $.integer)),
        /0[xX][0-9a-fA-F]+/, // hex
      ),

    string: ($) => /"([^"\\]|\\.)*"/,

    char: ($) => /'([^'\\]|\\.)'/,

    line_comment: ($) => token(seq("//", /.*/)),
    // block_comment is EXTERNAL so nested /* ... /* ... */ ... */ balances.
  },
});
