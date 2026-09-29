// clean_runtime.mjs — load the working tree's wasm through web-tree-sitter.
//
// `web-tree-sitter` is the runtime that loads a `.wasm` grammar and it is NOT a
// dependency of this grammar repo, which builds the native/C++ side and the CLI.
// It is resolved from the analyzer repo (override with BB_M14_ROOT) because the
// point is to measure with the SAME runtime the product parses with — a
// parse-health number from a different parser is a number about a different
// language.
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ANALYZER_REPO = process.env.BB_M14_ROOT ?? "/home/ishaq2321/mcp/backbencher-brain"

function req() {
  const here = createRequire(import.meta.url)
  try {
    here.resolve("web-tree-sitter/package.json")
    return here
  } catch {
    return createRequire(path.join(ANALYZER_REPO, "package.json"))
  }
}
const R = req()

/** Build the wasm from the working tree unless one is named. */
export function wasmPath(explicit) {
  if (explicit) return explicit
  const out = path.join("/tmp", `ts-clean-${process.pid}.wasm`)
  execFileSync("tree-sitter", ["build", "--wasm", "--output", out], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] })
  return out
}

export async function parserFor(explicitWasm) {
  const wasm = wasmPath(explicitWasm)
  if (!existsSync(wasm)) throw new Error(`no wasm at ${wasm}`)
  const wts = R("web-tree-sitter")
  await wts.Parser.init({
    locateFile: (name) => {
      try {
        return R.resolve(`web-tree-sitter/${name}`)
      } catch {
        return createRequire(path.join(ANALYZER_REPO, "package.json")).resolve(`web-tree-sitter/${name}`)
      }
    },
  })
  const lang = await wts.Language.load(new Uint8Array(readFileSync(wasm)))
  const parser = new wts.Parser()
  parser.setLanguage(lang)
  return { parser, wasm }
}

/** The first ERROR/MISSING node in a tree, or null. */
export function firstProblem(root) {
  let first = null
  const walk = (n) => {
    if (!first && (n.type === "ERROR" || n.isMissing)) first = n
    for (let i = 0; i < n.childCount; i++) walk(n.child(i))
  }
  walk(root)
  return first
}

/** Count ERROR + MISSING nodes and the source bytes they cover. */
export function problemStats(root) {
  let n = 0
  let bytes = 0
  const walk = (node) => {
    if (node.type === "ERROR" || node.isMissing) {
      n++
      bytes += node.endIndex - node.startIndex
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i))
  }
  walk(root)
  return { n, bytes }
}
