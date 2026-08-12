# tree-sitter-clean

[![CI][ci]](https://github.com/ishaq2321/tree-sitter-clean/actions/workflows/ci.yml)
[![discord][discord]](https://discord.gg/w7nTvsVJhm)
[![matrix][matrix]](https://matrix.to/#/#tree-sitter-chat:matrix.org)
[![npm][npm]](https://www.npmjs.com/package/tree-sitter-clean)
[![pypi][pypi]](https://pypi.org/project/tree-sitter-clean)
[![crates.io][crates]](https://crates.io/crates/tree-sitter-clean)

Clean grammar for [tree-sitter][].

[tree-sitter]: https://github.com/tree-sitter/tree-sitter

## Description

[Clean](https://clean-lang.org/) is a general-purpose, purely functional programming language with uniqueness typing. This grammar supports:

- Module system (`module`, `import`, `from...import`)
- Type system (`::`, algebraic data types, records, type classes)
- Functions (named, guards, `where`/`with` clauses)
- Patterns (variables, constructors, wildcards, lists, tuples)
- Expressions (application, infix operators, let, case, lambda)
- Comprehensions (list comprehensions with generators, guards, let qualifiers)
- Records (construction, update, field access)

### Coverage

The grammar is validated against the real-world Clean corpus
(clean-stdlib, Clyde, cloogle.org — 120 `.icl` + 119 `.dcl` files):

- **1833 ERROR nodes** across the `.icl` corpus vs 5129 before the grammar
  overhaul (2.8× better), with the core stdlib (StdEnv, StdList,
  StdString, StdMaybe) at **0 errors**
- **13 ERROR nodes** across the `.dcl` corpus (down from 282)
- 55/55 corpus tests, parse throughput ~1.3× the pre-overhaul parser

### Known Gaps

Clean constructs the grammar does not (fully) parse yet are documented in
[GRAMMAR-GAPS.md](GRAMMAR-GAPS.md), along with the approaches that were
tried and rejected on the full corpus. Remaining gaps are confined to
regions the reference parser also fails heavily; closing them is blocked
by a tree-sitter generator action-table ceiling (see the doc).

### Node Types

The grammar produces **189 named node types** for precise AST analysis, including:
- `application` — function/constructor call detection
- `field_access` — record field access
- `list_comprehension` — with `generator`, `guard`, `let_qualifier`
- `record_expression` / `record_update` — record manipulation
- `wildcard` — `_` pattern
- `type_definition` / `type_signature` / `class_context` — the type system

## Usage

### Rust
```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_clean::LANGUAGE.into())?;
```

Add `tree-sitter-clean` to your `Cargo.toml` to use it as a dependency:

```toml
[dependencies]
tree-sitter-clean = "1.2"
```

### JavaScript
```js
const Parser = require("tree-sitter");
const Clean = require("tree-sitter-clean");
const parser = new Parser();
parser.setLanguage(Clean);
```

### Python
```python
import tree_sitter_clean
```

## References

- [Clean Language Report](https://clean-lang.org/)
- [Clean Book](https://clean.cs.ru.nl/Clean)

[ci]: https://img.shields.io/github/actions/workflow/status/ishaq2321/tree-sitter-clean/ci.yml?logo=github&label=CI
[discord]: https://img.shields.io/discord/1063097320771698699?logo=discord&label=discord
[matrix]: https://img.shields.io/matrix/tree-sitter-chat%3Amatrix.org?logo=matrix&label=matrix
[npm]: https://img.shields.io/npm/v/tree-sitter-clean?logo=npm
[pypi]: https://img.shields.io/pypi/v/tree-sitter-clean?logo=pypi&logoColor=ffd242
[crates]: https://img.shields.io/crates/v/tree-sitter-clean?logo=rust
