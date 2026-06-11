(module_declaration (identifier) @module)
(import_declaration (identifier) @module)
(type_signature (identifier) @type)
(type_definition (identifier) @type)
(function_declaration (identifier) @function)
(class_declaration (identifier) @keyword)
(instance_declaration (identifier) @keyword)
(string) @string
(number) @number
(line_comment) @comment
(block_comment) @comment
((identifier) @constructor
 (#match? @constructor "^[A-Z]"))
((identifier) @variable
 (#not-match? @variable "^[A-Z]"))
