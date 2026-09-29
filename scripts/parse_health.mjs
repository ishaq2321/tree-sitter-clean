#!/usr/bin/env node
// parse_health.mjs — parse health for a tree-sitter-clean wasm, over any corpus.
//
// WHY THIS EXISTS. `scripts/corpus_regression.py` is the authoritative REGRESSION
// gate: cache-free, per-file, compared against a committed baseline. It answers
// "did this change make anything worse?". It does not answer the question the
// Clean lane actually needs, which is "how much of the language does this grammar
// read AT ALL?", because that is a property of the corpus as a whole rather than a
// per-file delta, and the two disagree usefully: a grammar can add no regressions
// and still fail to read a third of real Clean.
//
// Measured against the 2,179-file union corpus (the Clean ecosystem: StdEnv,
// CleanIDE, iTasks/ObjectIO, Curved, the sabtron set), v1.2.7 reads 1,524 files
// (69.9%) with no ERROR node. The other 655 carry 25,683 ERROR nodes. Every
// percentage the Clean analyzer publishes is a percentage OF WHAT PARSED, so this
// number is the ceiling on all of them, and it deserves an instrument that computes
// it rather than a note that remembers it.
//
// It also groups the failures by SHAPE, so a grammar change can be aimed: the
// dominant shape is worth more than the long tail, and the tail is worth knowing
// about at all.
//
// Usage:
//   node scripts/parse_health.mjs [--wasm PATH] [--manifest FILE] [--corpus DIR]
//                                [--json OUT] [--examples N] [--quiet]
//
// --wasm defaults to a fresh `tree-sitter build --wasm`, so the measurement is of
// the grammar in the working tree unless a build is named explicitly.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parserFor, firstProblem, problemStats } from "./clean_runtime.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)

const WIDE_MANIFEST = "/home/ishaq2321/mcp/backbencher-brain/script/m14/clean-wide-manifest.txt"

// ------------------------------------------------------------------- file list
const manifest = arg("manifest", WIDE_MANIFEST)
const corpus = arg("corpus", "/home/ishaq2321/bb_tests/repositories")
let files
if (existsSync(manifest)) {
  files = readFileSync(manifest, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
} else {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(icl|dcl)$/.test(e.name)) out.push(p)
    }
  }
  walk(corpus)
  files = out.sort()
}
files.sort()

const { parser, wasm: wasmPath } = await parserFor(arg("wasm", null))

// ------------------------------------------------------------------- measuring
// A "shape" is what the attributed problem LINE looks like, read from the source
// text rather than from the node, because the node for a construct the grammar
// cannot read is a bag of whatever tokens it did read — which tells the reader
// nothing about what to fix.
function shapeOf(line) {
  const t = line.trim()
  if (!t) return "(blank)"
  if (/^implementation\s+module\b/.test(t)) return "implementation module header"
  if (/^import\s+code\s+from\b/.test(t)) return "`import code from` FFI form"
  if (/<<@/.test(t)) return "`<<@` compiler directive"
  if (/^\(/.test(t) && /=/.test(t) && !/\)\s*::/.test(t)) return "tuple-destructuring binding"
  if (/^\(\s*\w+\s*,\s*\w+\s*\)\s*=/.test(t)) return "tuple-destructuring binding"
  if (/^\w[\w',]*\s*::/.test(t) && t.includes(",")) return "several names before one `::`"
  if (/\{\s*-?\d+\s*#\s*[^}]*\}\s*$/.test(t) || /:\s*-?\d+\s*#/.test(t)) return "`*`-parameter synonym"
  if (/\{\s*#/i.test(t) && /:/.test(t) && /^\s*\{/.test(t)) return "`*`-parameter synonym"
  if (/^class\s/.test(t) && /\|/.test(t)) return "mixed-arity class context"
  if (/::/.test(t) && /\(.*->.*\)/.test(t) && /\|/.test(t)) return "function type in context position"
  if (/\.\-/.test(t)) return "the `.-` operator"
  if (/^\s*(infixl|infixr|infix)\b/.test(t)) return "fixity declaration"
  if (/^\w+\s+\w+/.test(t) && !/::/.test(t) && !/=/.test(t)) return "definition with no `::` in a `.dcl`"
  if (/^\s*\)/.test(t)) return "closing paren at column 0"
  if (/^\s*\*/.test(t) || /^\s*\/\//.test(t)) return "comment swallowed by a block"
  return "other"
}

const shapeCount = new Map()
const shapeFiles = new Map()
const examples = new Map()
const EXAMPLES_WANTED = Number(arg("examples", 3))
let cleanFiles = 0
let errorFiles = 0
let problemNodes = 0
let errorBytes = 0
let wrapped = 0
let singleWrapped = 0
const perFile = []

for (const f of files) {
  let src
  try {
    src = readFileSync(f, "utf8")
  } catch {
    continue
  }
  const tree = parser.parse(src)
  const lines = src.split("\n")
  // Attribution uses the TIGHTEST problem node, not the first one.
  //
  // When a single construct is unreadable, tree-sitter's recovery can wrap the
  // WHOLE file in one ERROR node — measured on the union corpus, 114 of the 653
  // failing files are like this, and `graph_copy_with_names.icl` is typical: one
  // bad `import code from` on line 6 produces an ERROR whose start position is
  // line 1. Attributing by first node therefore reports "module header" for
  // 442 files whose module headers parse perfectly, and the census points the
  // grammar work at a shape that is not broken. The smallest node is the actual
  // unreadable construct, so that is what gets named.
  let tightest = null
  let n = 0
  let bytes = 0
  const walk = (node) => {
    if (node.type === "ERROR" || node.isMissing) {
      n++
      const span = node.endIndex - node.startIndex
      bytes += span
      if (!tightest || span < tightest.endIndex - tightest.startIndex) tightest = node
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i))
  }
  walk(tree.rootNode)
  const first = tightest
  if (n === 0) {
    cleanFiles++
    perFile.push({ file: f, problems: 0, bytes: 0, shape: null })
    continue
  }
  errorFiles++
  problemNodes += n
  errorBytes += bytes
  const span = (first.endIndex - first.startIndex) / Math.max(1, src.length)
  if (span >= 0.5) wrapped++
  const fileSpan = (() => { let big = 0; const w2 = (node) => { if (node.type === "ERROR" || node.isMissing) big = Math.max(big, node.endIndex - node.startIndex); for (let i = 0; i < node.childCount; i++) w2(node.child(i)) }; w2(tree.rootNode); return big / Math.max(1, src.length) })()
  if (fileSpan >= 0.5) singleWrapped++
  const line = lines[first.startPosition.row] ?? ""
  const shape = shapeOf(line)
  shapeCount.set(shape, (shapeCount.get(shape) ?? 0) + 1)
  if (!shapeFiles.has(shape)) shapeFiles.set(shape, new Set())
  shapeFiles.get(shape).add(path.relative(corpus, f))
  if (!examples.has(shape)) examples.set(shape, [])
  if (examples.get(shape).length < EXAMPLES_WANTED) {
    examples.get(shape).push(`${path.relative(corpus, f)}:${first.startPosition.row + 1}  ${JSON.stringify(line.trim().slice(0, 72))}`)
  }
  perFile.push({ file: f, problems: n, bytes, shape, line: first.startPosition.row + 1, text: line.trim().slice(0, 90), tightestSpanBytes: first.endIndex - first.startIndex, wholeFileWrapped: fileSpan >= 0.5 })
}

const pct = (a, b) => (b === 0 ? "  0.0%" : `${((100 * a) / b).toFixed(1).padStart(5)}%`)
const report = {
  wasm: wasmPath,
  corpus: existsSync(manifest) ? `manifest ${manifest}` : `dir ${corpus}`,
  files: files.length,
  parseCleanFiles: cleanFiles,
  errorFiles,
  problemNodes,
  errorBytes,
  wrapped,
  singleWrappedFiles: singleWrapped,
  parseCleanPct: Number(((100 * cleanFiles) / files.length).toFixed(2)),
  byShape: [...shapeCount.entries()]
    .map(([shape, n]) => ({ shape, files: n, sharePct: Number(((100 * n) / errorFiles).toFixed(2)), exampleFiles: [...shapeFiles.get(shape)].slice(0, 5), examples: examples.get(shape) }))
    .sort((a, b) => b.files - a.files),
}

if (!has("quiet")) {
  const out = []
  out.push(`clean parse health — ${report.files} files`)
  out.push(`  parse clean            ${cleanFiles}  (${pct(cleanFiles, report.files)})`)
  out.push(`  with >=1 problem node  ${errorFiles}  (${pct(errorFiles, report.files)}), ${problemNodes} ERROR/MISSING nodes, ${errorBytes} error bytes`)
  out.push(`  of which wrapped      ${singleWrapped}  (one problem node covers >=50% of the file; attribution below uses the tightest node, not the first)`)
  out.push("")
  out.push("first-problem shapes (a construct the grammar cannot read has a bag of tokens for a node, so the shape is read from the SOURCE line):")
  for (const s of report.byShape) {
    out.push(`  ${String(s.files).padStart(5)} files  ${pct(s.files, errorFiles)}  ${s.shape}`)
    for (const e of s.examples) out.push(`            ${e}`)
  }
  console.log(out.join("\n"))
}
const json = arg("json", null)
if (json) writeFileSync(json, JSON.stringify({ ...report, perFile }, null, 2) + "\n")
