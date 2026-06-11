; Keywords
"module" @keyword
"import" @keyword
"from" @keyword
"where" @keyword
"with" @keyword
"class" @keyword
"instance" @keyword
"let" @keyword
"in" @keyword
"case" @keyword
"of" @keyword
"implementation" @keyword
"definition" @keyword
"system" @keyword

; Module and import names
(module_declaration (identifier) @module)
(import_declaration (identifier) @module)

; Types and constructors
(type_signature (identifier) @type)
(type_definition (identifier) @type)
(class_declaration (identifier) @type)
(instance_declaration (identifier) @type)
((identifier) @constructor
 (#match? @constructor "^[A-Z]"))

; Functions and variables
(function_declaration (identifier) @function)
((identifier) @variable
 (#not-match? @variable "^[A-Z]"))

; Literals
(string) @string
(number) @number

; Comments
(line_comment) @comment
(block_comment) @comment

; Operators
(operator) @operator

; Patterns
(wildcard) @keyword

; Punctuation
"=" @operator
"->" @operator
"," @punctuation.delimiter
"." @punctuation.delimiter
"|" @operator
"::" @operator
