#!/usr/bin/env node
// repro.mjs — parse files (or inline snippets) with the working tree's wasm and
// print the tree. The iteration loop for a grammar fix: write a minimal failing
// case, read the tree, change grammar.js, re-run. `tree-sitter parse` needs the
// grammar's cwd and the native build; this uses the same web-tree-sitter runtime
// the product uses, so what it shows is what ships.
//
// Usage: node scripts/repro.mjs FILE...        # tree + first ERROR line
//        node scripts/repro.mjs --tree FILE     # full s-expression, no truncation
import { readFileSync } from "node:fs"
import { parserFor, firstProblem } from "./clean_runtime.mjs"

const args = process.argv.slice(2)
const full = args.includes("--tree")
const files = args.filter((a) => !a.startsWith("--"))
const { parser } = await parserFor(process.env.CLEAN_WASM)

for (const f of files) {
  const src = readFileSync(f, "utf8")
  const tree = parser.parse(src)
  const lines = src.split("\n")
  if (full) { console.log(tree.rootNode.toString()); continue }
  let first = null
  const walk = (n) => { if (!first && (n.type === "ERROR" || n.isMissing)) first = n; for (let i = 0; i < n.childCount; i++) walk(n.child(i)) }
  walk(tree.rootNode)
  if (!first) { console.log(`${f}: OK — no problem node`); continue }
  const ln = first.startPosition.row + 1
  console.log(`${f}: ${first.isMissing ? "MISSING" : "ERROR"} at line ${ln}  ${JSON.stringify(lines[first.startPosition.row].trim().slice(0, 70))}`)
  console.log("  " + tree.rootNode.toString().split("\n").slice(0, 8).join("\n  "))
}
