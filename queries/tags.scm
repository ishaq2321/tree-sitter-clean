(module_declaration name: (module_name (module_identifier) @name)) @definition.module
(type_definition name: (constructor) @name) @definition.type
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (class_name (constructor) @name)) @definition.interface
(instance_declaration name: (instance_class (constructor) @name)) @definition.class
(application function: (identifier) @name) @reference.call
