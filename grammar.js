module.exports = grammar({
  name: "clean",

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  conflicts: ($) => [
    [$.application],
    [$.field_access],
    [$.list_comprehension, $._expression],
    [$._expression],
    [$._expression, $._pattern],
    [$.class_declaration],
    [$.instance_declaration],
    [$.type_signature],
    [$.data_constructor, $._type_expression],
    [$._type_expression],
    [$.where_block],
    [$.with_block],
    [$._expression, $.let_expression],
    [$._expression, $.let_before_expression],
    [$.case_expression],
    [$.let_before_expression],
    [$._expression, $.case_alternative],
  ],

  externals: ($) => [$._layout_semicolon, $._layout_start, $._layout_end],

  rules: {
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
        $.type_signature,
        $.type_definition,
        $.function_declaration,
        $.class_declaration,
        $.instance_declaration,
      ),

    module_declaration: ($) => seq(optional(choice("implementation", "definition", "system")), "module", $.identifier),

    import_declaration: ($) =>
      prec.left(
        choice(
          seq("import", $.identifier, repeat(seq(optional(","), $.identifier))),
          seq("from", $.identifier, "import", $.identifier, repeat(seq(optional(","), $.identifier))),
        ),
      ),

    type_signature: ($) => seq(field("name", $.identifier), "::", repeat1($._type_expression)),

    type_definition: ($) =>
      prec.left(
        seq(
          "::",
          optional(choice("*", "!")),
          field("name", $.identifier),
          repeat($.identifier),
          optional(seq(choice("=", ":=="), $._type_rhs)),
        ),
      ),

    _type_rhs: ($) => prec.left(choice($.data_constructors, $.record_definition, $._type_expression)),

    data_constructors: ($) => prec.left(seq($.data_constructor, repeat(seq("|", $.data_constructor)))),

    data_constructor: ($) => prec.left(seq($.identifier, repeat($._type_expression))),

    record_definition: ($) => seq("{", repeat(seq($.record_field, optional(","))), "}"),

    record_field: ($) => seq($.identifier, "::", $._type_expression),

    class_declaration: ($) =>
      seq(
        "class",
        field("name", $.identifier),
        repeat1($.identifier),
        optional(seq("where", repeat($.type_signature))),
      ),

    instance_declaration: ($) =>
      seq(
        "instance",
        field("name", $.identifier),
        repeat1($._type_expression),
        optional(seq("where", repeat($.function_declaration))),
      ),

    function_declaration: ($) =>
      seq(
        field("name", $.identifier),
        repeat($._pattern),
        choice(seq("=", $._expression), repeat1($.guard_equation)),
        optional(choice($.where_block, $.with_block)),
      ),

    guard_equation: ($) => seq("|", $._expression, "=", $._expression),

    where_block: ($) => seq("where", repeat1(choice($.type_signature, $.function_declaration))),

    with_block: ($) => seq("with", repeat1(choice($.type_signature, $.function_declaration))),

    _pattern: ($) =>
      choice(
        $.wildcard,
        $.identifier,
        $.number,
        $.string,
        seq("(", repeat1(choice($._pattern, ",", $.operator)), ")"),
        seq("[", repeat(seq($._pattern, optional(","))), "]"),
      ),

    // `_` wildcard — matches anything, binds nothing
    wildcard: ($) => "_",

    _type_expression: ($) =>
      prec.left(
        choice(
          $.identifier,
          "->",
          "*",
          "!",
          seq("(", repeat1(choice($._type_expression, ",", "->", "*")), ")"),
          seq("[", $._type_expression, "]"),
        ),
      ),

    _expression: ($) =>
      prec.left(
        choice(
          $.field_access,
          $.list_comprehension,
          $.record_expression,
          $.record_update,
          $.identifier,
          $.number,
          $.string,
          $.let_expression,
          $.let_before_expression,
          $.case_expression,
          seq("(", repeat(choice($._expression, $.operator, ",")), ")"),
          seq("[", repeat(seq($._expression, optional(","))), "]"),
          seq($._expression, $.operator, $._expression),
          $.application,
        ),
      ),

    application: ($) => prec.left(10, seq($._expression, $._expression)),

    // Record field access: `record.field` or `record!field` (strict)
    field_access: ($) => prec.left(13, seq($._expression, choice(".", "!"), $.identifier)),

    // Record construction: `{ name = "Ishaq", age = 25 }`
    record_expression: ($) =>
      seq(
        "{",
        repeat(seq(
          field("name", $.identifier),
          "=",
          field("value", $._expression),
          optional(","),
        )),
        "}",
      ),

    // Record update: `{ person & age = 26 }`
    record_update: ($) =>
      seq(
        "{",
        field("record", $._expression),
        "&",
        repeat(seq(
          optional(","),
          field("name", $.identifier),
          "=",
          field("value", $._expression),
        )),
        "}",
      ),

    // List comprehension: `[x * 2 \\ x <- [1..10] | isEven x]`
    list_comprehension: ($) =>
      seq(
        "[",
        field("body", $._expression),
        "\\\\",
        repeat1(seq($.comprehension_qualifier, optional(","))),
        "]",
      ),

    comprehension_qualifier: ($) =>
      choice(
        $.generator,
        $.guard,
        $.let_qualifier,
      ),

    generator: ($) =>
      seq(
        field("pattern", $._pattern),
        "<-",
        field("expression", $._expression),
      ),

    guard: ($) => field("condition", $._expression),

    let_qualifier: ($) =>
      seq(
        "let",
        field("name", $.identifier),
        "=",
        field("value", $._expression),
      ),

    let_expression: ($) => seq("let", repeat1(choice($.function_declaration, $.type_signature)), "in", $._expression),

    let_before_expression: ($) =>
      seq(choice("#", "#!"), $._pattern, "=", $._expression, optional($.let_before_expression)),

    case_expression: ($) => seq("case", $._expression, "of", repeat1($.case_alternative)),

    case_alternative: ($) => seq($._pattern, choice("->", "="), $._expression),

    identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,
    operator: ($) => /[!@$%^&*+\-=\\|<>\/?~.]+/,
    number: ($) => /\d+(\.\d+)?/,
    string: ($) => /"([^"\\]|\\.)*"/,

    line_comment: ($) => token(seq("//", /.*/)),
    block_comment: ($) => token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),
  },
})
