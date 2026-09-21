#!/usr/bin/env python3
"""Cache-free corpus regression gate for tree-sitter-clean.

Why "cache-free"?  `npx tree-sitter parse` caches the compiled parser under a
key derived only from the language NAME ("clean"), not from the source.  Two
different grammars that share the name therefore share one cache entry, so a
naive "parse the corpus with v1.2.5, then with HEAD" run can silently compare
a grammar against itself.  (That is exactly how an earlier underscore-
constructor change was mis-measured as "0 regressions" while it actually
added thousands of ERROR nodes.)  This script instead compiles the parser to
a shared object and loads that exact binary through ctypes, so the two sides
can never bleed together.

Requires the `tree_sitter` Python package (pip install 'tree_sitter>=0.24')
and a C compiler.  POSIX only (uses `cc -shared`).

Usage:
  python3 scripts/corpus_regression.py --corpus DIR [options]

Options:
  --corpus DIR        Root of the .icl/.dcl corpus to parse (required).
  --parser PATH       Use an existing parser .so instead of compiling the
                      current grammar in this checkout.
  --baseline FILE     Baseline manifest (default: scripts/corpus-baseline.tsv).
  --save-baseline     Rewrite FILE with the current counts instead of
                      comparing.  Run only when the current grammar is the new
                      verified release, so the next gate compares against it.
  --list-new          Also print corpus files that have no baseline entry
                      (they are reported but do not fail the gate).

The per-file metrics are:

  problem nodes = ERROR nodes + MISSING tokens (the phantom symbols error
                  recovery inserts). MISSING-only regressions are real
                  tree-shape damage that an ERROR-only count silently ignores
                  (a `#`-group's END-steal can leave an instance member-list
                  closer as a MISSING `;` with zero ERROR nodes).

  error bytes   = the number of source BYTES inside ERROR/MISSING nodes (the
                  union of their ranges).  This is the metric that problem
                  counts cannot replace: when error recovery gives up it wraps
                  a whole region — or the whole file — in ONE ERROR node, so a
                  change that collapses 193 problems into 10 can still be a
                  massive downgrade (measured: a guard-chain change took
                  PmParse.icl 193 -> 10 nodes while its error bytes grew).  A
                  node count of 1 is not "almost clean"; it can be the worst
                  possible parse.

  wrapped       = 1 when one TOP-LEVEL ERROR covers >=50% of the file, i.e.
                  the recovery gave up on the file rather than on a region.
                  Reported separately so a newly-wrapped file fails the gate
                  even if its byte count happens to be flat, and so a file
                  whose "only" problem node is the whole file can never read
                  as clean.

The gate fails if any file gains problem nodes, gains error bytes, or becomes
wrapped.

Exit codes:
  0  no file got worse relative to the baseline
  1  at least one file got worse (a regression)
  2  usage / environment error
"""

import argparse
import os
import subprocess
import sys
import tempfile
import warnings

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BASELINE = os.path.join(REPO_ROOT, "scripts", "corpus-baseline.tsv")
CORPUS_SUFFIXES = (".icl", ".dcl")


def compile_parser(dst):
    src_dir = os.path.join(REPO_ROOT, "src")
    cmd = [
        "cc", "-shared", "-fPIC", "-I", src_dir, "-std=c11", "-O2",
        "-o", dst,
        os.path.join(src_dir, "parser.c"),
        os.path.join(src_dir, "scanner.c"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write("compiling the parser failed:\n")
        sys.stderr.write(proc.stderr)
        sys.exit(2)
    return dst


def load_parser(so_path):
    try:
        import ctypes
        from tree_sitter import Language, Parser
    except ImportError as exc:
        sys.stderr.write(
            "missing Python dependency: %s\n"
            "install it with:  pip install 'tree_sitter>=0.24'\n" % exc
        )
        sys.exit(2)

    lib = ctypes.CDLL(so_path)
    lib.tree_sitter_clean.restype = ctypes.c_void_p
    with warnings.catch_warnings():
        # py-tree-sitter 0.26 wraps a TSLanguage pointer; the int form is
        # deprecated but is still the way to load a hand-built .so.
        warnings.simplefilter("ignore", DeprecationWarning)
        lang = Language(lib.tree_sitter_clean())
    return Parser(lang)


def count_problems(root):
    """Count syntax problems under `root`: ERROR nodes plus MISSING tokens.

    ERROR counts alone miss tree-shape regressions that error recovery
    absorbs silently: a `#`-group's END-steal can leave an `instance`
    member-list closer as a MISSING `;` without a single ERROR node (Clyde's
    tabview.icl parses "clean" by the ERROR metric while carrying two
    MISSING tokens). MISSING tokens are the phantom symbols the parser
    inserts during recovery, so they are a real quality signal. A node is
    counted at most once (a MISSING ERROR node is one problem).
    """
    total = 0
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "ERROR" or node.is_error or node.is_missing:
            total += 1
        stack.extend(node.children)
    return total


def error_coverage(root, nbytes):
    """Bytes inside ERROR/MISSING nodes, and whether the file is wrapped.

    Returns `(covered, wrapped)`.  See the module docstring for why problem
    counts alone are not enough: error recovery can swallow a huge region in
    a single ERROR node, which improves every node count while destroying the
    tree.  Byte coverage makes that regression visible (and `wrapped` makes
    the extreme case — one ERROR around the whole file — explicit, since a
    file whose only problem node IS the whole file must never read as clean).
    """
    spans = []
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "ERROR" or node.is_error or node.is_missing:
            spans.append((node.start_byte, node.end_byte))
        stack.extend(node.children)
    spans.sort()
    covered = 0
    reach = -1
    for start, end in spans:
        if start > reach:
            covered += end - start
            reach = end
        elif end > reach:
            covered += end - reach
            reach = end
    # A top-level ERROR spanning half the file means the recovery gave up on
    # the FILE, not on a construct: PmParse.icl's "10 problem nodes" is one
    # ERROR over 1300 of its 1459 lines.  Counting only a sole-child wrapper
    # would miss that (the same node sits beside recovered siblings), and a
    # root that IS the ERROR (the worst case: no `source_file` at all) has to
    # be caught too — a measured bad revision produced exactly that for 3
    # corpus files while every node count improved.
    half = 0.5 * nbytes
    wrapped = 0
    if root.type == "ERROR" and root.end_byte - root.start_byte >= half:
        return covered, 1
    for child in root.children:
        if child.type == "ERROR" and child.end_byte - child.start_byte >= half:
            wrapped = 1
            break
    return covered, wrapped


def iter_corpus(corpus_root):
    for dirpath, _dirnames, filenames in os.walk(corpus_root):
        for name in filenames:
            if name.endswith(CORPUS_SUFFIXES):
                yield os.path.join(dirpath, name)


def read_baseline(path):
    """Read the baseline: `path<TAB>nodes[<TAB>bytes<TAB>wrapped]` per file.

    A two-column (legacy) baseline still loads; the byte/wrap checks are then
    skipped for every file, which the caller reports as a note rather than
    silently passing.
    """
    baseline = {}
    totals = [0, 0, 0]
    for line in open(path, "r", encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        rel = fields[0]
        try:
            nodes = int(fields[1])
            nbytes = int(fields[2]) if len(fields) > 2 else -1
            wrapped = int(fields[3]) if len(fields) > 3 else -1
        except (IndexError, ValueError):
            sys.stderr.write("bad baseline line: %r\n" % line)
            sys.exit(2)
        baseline[rel] = (nodes, nbytes, wrapped)
        totals[0] += nodes
        if nbytes >= 0:
            totals[1] += nbytes
            totals[2] += wrapped
    return baseline, totals


def write_baseline(path, counts):
    total_nodes = sum(nodes for nodes, _b, _w in counts.values())
    total_bytes = sum(nbytes for _n, nbytes, _w in counts.values())
    total_wrapped = sum(wrapped for _n, _b, wrapped in counts.values())
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# tree-sitter-clean corpus regression baseline\n")
        fh.write("# path<TAB>problem nodes<TAB>error bytes<TAB>wrapped\n")
        fh.write("# Problem nodes = ERROR + MISSING; error bytes = source bytes "
                 "inside them (union of ranges);\n")
        fh.write("# wrapped = a top-level ERROR node covers >=50% of the file.\n")
        fh.write("# Regenerate after a verified release so the next gate "
                 "compares against it.\n")
        fh.write("# totals: %d problem nodes, %d error bytes, %d wrapped\n"
                 % (total_nodes, total_bytes, total_wrapped))
        for rel in sorted(counts):
            nodes, nbytes, wrapped = counts[rel]
            fh.write("%s\t%d\t%d\t%d\n" % (rel, nodes, nbytes, wrapped))


def main(argv):
    ap = argparse.ArgumentParser(
        description="Cache-free corpus regression gate for tree-sitter-clean."
    )
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--parser")
    ap.add_argument("--baseline", default=DEFAULT_BASELINE)
    ap.add_argument("--save-baseline", action="store_true")
    ap.add_argument("--list-new", action="store_true")
    args = ap.parse_args(argv)

    corpus_root = os.path.abspath(args.corpus)
    if not os.path.isdir(corpus_root):
        sys.stderr.write("corpus directory not found: %s\n" % corpus_root)
        sys.exit(2)

    if args.parser:
        so_path = args.parser
    else:
        so_path = os.path.join(
            tempfile.gettempdir(), "tree-sitter-clean-regression.so"
        )
        compile_parser(so_path)

    parser = load_parser(so_path)

    counts = {}
    for path in iter_corpus(corpus_root):
        rel = os.path.relpath(path, corpus_root)
        with open(path, "rb") as fh:
            data = fh.read()
        root = parser.parse(data).root_node
        covered, wrapped = error_coverage(root, len(data))
        counts[rel] = (count_problems(root), covered, wrapped)

    total_nodes = sum(nodes for nodes, _b, _w in counts.values())
    total_bytes = sum(nbytes for _n, nbytes, _w in counts.values())
    total_wrapped = sum(wrapped for _n, _b, wrapped in counts.values())

    if args.save_baseline:
        write_baseline(args.baseline, counts)
        print("wrote %d entries (%d problem nodes, %d error bytes, %d wrapped) "
              "to %s" % (len(counts), total_nodes, total_bytes,
                         total_wrapped, args.baseline))
        return 0

    baseline, (base_nodes, base_bytes, base_wrapped) = read_baseline(
        args.baseline)
    legacy = base_bytes == 0 and base_nodes > 0

    regressions = []
    improvements = []
    new_files = []

    for rel, (nodes, nbytes, wrapped) in counts.items():
        prev = baseline.get(rel)
        if prev is None:
            new_files.append((rel, nodes, nbytes))
            continue
        pnodes, pbytes, pwrapped = prev
        why = []
        if nodes > pnodes:
            why.append("nodes %d -> %d" % (pnodes, nodes))
        if pbytes >= 0 and nbytes > pbytes:
            why.append("bytes %d -> %d" % (pbytes, nbytes))
        if pwrapped >= 0 and wrapped > pwrapped:
            why.append("newly wrapped")
        if why:
            regressions.append((rel, "; ".join(why)))
        elif nodes < pnodes or (pbytes >= 0 and nbytes < pbytes):
            what = "%d -> %d nodes" % (pnodes, nodes)
            if pbytes >= 0:
                what += ", %d -> %d bytes" % (pbytes, nbytes)
            improvements.append((rel, what))

    print("corpus:   %s" % corpus_root)
    print("files:    %d parsed" % len(counts))
    print("baseline: %d problem nodes, %d error bytes, %d wrapped (%s)"
          % (base_nodes, base_bytes, base_wrapped,
             os.path.basename(args.baseline)))
    print("current:  %d problem nodes, %d error bytes, %d wrapped"
          % (total_nodes, total_bytes, total_wrapped))
    print("delta:    %+d problem nodes, %+d error bytes, %+d wrapped"
          % (total_nodes - base_nodes, total_bytes - base_bytes,
             total_wrapped - base_wrapped))
    if legacy:
        print("note:     baseline has no byte columns — only node counts "
              "are checked; re-save it with --save-baseline.")

    if new_files:
        print("\n%d file(s) have no baseline entry:" % len(new_files))
        if args.list_new:
            for rel, nodes, nbytes in new_files:
                print("  %d nodes, %d bytes\t%s" % (nodes, nbytes, rel))

    if improvements:
        print("\n%d file(s) improved:" % len(improvements))
        for rel, what in improvements:
            print("  %s\t%s" % (what, rel))

    if regressions:
        print("\n%d file(s) REGRESSED:" % len(regressions))
        for rel, why in regressions:
            print("  %s\t%s" % (why, rel))
        return 1

    print("\nPASS: no file gained problem nodes, error bytes or wrapping.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
