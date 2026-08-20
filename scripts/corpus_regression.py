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

The per-file metric is problem nodes = ERROR nodes + MISSING tokens (the
phantom symbols error recovery inserts). MISSING-only regressions are real
tree-shape damage that an ERROR-only count silently ignores (a `#`-group's
END-steal can leave an instance member-list closer as a MISSING `;` with
zero ERROR nodes), so the gate fails on either kind.

Exit codes:
  0  no file gained problem nodes relative to the baseline
  1  at least one file gained problem nodes (a regression)
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


def iter_corpus(corpus_root):
    for dirpath, _dirnames, filenames in os.walk(corpus_root):
        for name in filenames:
            if name.endswith(CORPUS_SUFFIXES):
                yield os.path.join(dirpath, name)


def read_baseline(path):
    baseline = {}
    total = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            rel, _, count = line.partition("\t")
            try:
                n = int(count)
            except ValueError:
                sys.stderr.write("bad baseline line: %r\n" % line)
                sys.exit(2)
            baseline[rel] = n
            total += n
    return baseline, total


def write_baseline(path, counts):
    total = sum(counts.values())
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# tree-sitter-clean corpus regression baseline\n")
        fh.write("# ERROR + MISSING nodes per file, generated with --save-baseline.\n")
        fh.write("# Regenerate after a verified release so the next gate "
                 "compares against it.\n")
        fh.write("# total: %d\n" % total)
        for rel in sorted(counts):
            fh.write("%s\t%d\n" % (rel, counts[rel]))


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
        counts[rel] = count_problems(parser.parse(data).root_node)

    current_total = sum(counts.values())

    if args.save_baseline:
        write_baseline(args.baseline, counts)
        print("wrote %d entries (%d ERROR nodes) to %s"
              % (len(counts), current_total, args.baseline))
        return 0

    baseline, baseline_total = read_baseline(args.baseline)

    regressions = []
    improvements = []
    new_files = []

    for rel, n in counts.items():
        prev = baseline.get(rel)
        if prev is None:
            new_files.append((rel, n))
        elif n > prev:
            regressions.append((rel, prev, n))
        elif n < prev:
            improvements.append((rel, prev, n))

    print("corpus:   %s" % corpus_root)
    print("files:    %d parsed" % len(counts))
    print("baseline: %d problem nodes (ERROR+MISSING) (%s)"
          % (baseline_total, os.path.basename(args.baseline)))
    print("current:  %d problem nodes (ERROR+MISSING)" % current_total)
    print("delta:    %+d" % (current_total - baseline_total))

    if new_files:
        print("\n%d file(s) have no baseline entry:" % len(new_files))
        if args.list_new:
            for rel, n in new_files:
                print("  %d\t%s" % (n, rel))

    if improvements:
        print("\n%d file(s) improved:" % len(improvements))
        for rel, prev, n in improvements:
            print("  %d -> %d\t%s" % (prev, n, rel))

    if regressions:
        print("\n%d file(s) REGRESSED (more ERROR nodes than baseline):"
              % len(regressions))
        for rel, prev, n in regressions:
            print("  %d -> %d\t%s" % (prev, n, rel))
        return 1

    print("\nPASS: no file gained ERROR nodes.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
