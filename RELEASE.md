# Release Procedure

How to publish a new version of `tree-sitter-clean` to **npm**, **PyPI**,
and **crates.io**. This procedure was verified end-to-end for v1.2.0
(Aug 2026); it is automated in [`.github/workflows/publish.yml`]
(.github/workflows/publish.yml) and this file records the lessons so a
future release is one command.

## One-time setup (already done for v1.2.0)

Three repository secrets, each tied to an account that *owns* the package
on the respective registry:

| Secret | Registry | Notes |
| ------ | -------- | ----- |
| `NPM_TOKEN` | npm | publish-scope access token from the account that owns `tree-sitter-clean` (npm returns **E404** — not 401 — when the token's account lacks access; double-check the account when this happens) |
| `PYPI_TOKEN` | PyPI | API token with upload scope, created at pypi.org/manage/account/token |
| `CARGO_TOKEN` | crates.io | cargo API token; the cargo account **must have a verified email** (crates.io/settings/profile) or publish fails with `400: A verified email address is required` |

Set them with `gh secret set NAME -R ishaq2321/tree-sitter-clean`.

## Release steps

1. **Bump the version in all five manifests** — they must stay in sync:
   - `package.json`
   - `pyproject.toml`
   - `setup.py`
   - `Cargo.toml`
   - `tree-sitter.json`

   (Check for stragglers: `grep -rn '<old-version>' --include='*.toml' --include='*.json' --include='*.py' .`)

2. **Regenerate + verify the grammar** (required if `grammar.js` changed):

   ```bash
   rm -f src/parser.c
   npx tree-sitter generate
   npx tree-sitter test
   ```

3. **Check for action-table corruption** — the generated parser overflows
   silently past 65536 actions (16-bit limit). The build MUST be clean:

   ```bash
   cc -shared -o /tmp/check.so src/parser.c src/scanner.c -fPIC -O2 2>&1 | grep -c overflow
   # must print 0
   ```

4. **Corpus regression battery** — parse every corpus with the candidate
   grammar and compare against the same run on the previous release's
   grammar. No file may get MORE errors than before. The three corpora:

   - `test/corpus/` — `npx tree-sitter test` (all green)
   - Eastwood (`gitlab.com/clean-and-itasks/eastwood`, every `.icl`)
   - `clean-stdlib` (`gitlab.science.ru.nl/clean-compiler-and-rts/stdenv`,
     at least all 25 root `Std*.icl` files — these must be 0 errors)
   - `Clyde` + `cloogle.org` (all `.icl`/`.dcl`)

   Count ERROR nodes per file with the cache-free regression gate
   (`scripts/corpus_regression.py`) — NOT with ad-hoc `tree-sitter parse`
   runs, which can silently compare a grammar against itself (see Gotchas):

   ```bash
   npm run regress -- --corpus /path/to/all-corpus-repos --list-new
   ```

   The gate parses every `.icl`/`.dcl` under `--corpus`, counts problem
   nodes per file (ERROR nodes + MISSING tokens — the phantom symbols error
   recovery inserts, e.g. a `#`-group's END-steal leaving an `instance`
   member-list closer as a MISSING `;` with zero ERROR nodes), and fails if
   any file has more problems than the checked-in `scripts/corpus-baseline.tsv`
   (generated from v1.2.5: 312 files, 1013 problem nodes = 872 ERROR + 141
   MISSING). It prints a total per corpus and per-file deltas. After a
   release is verified, refresh the baseline with `--save-baseline`.
   Error-recovery cascades mean a single new construct can change a file's
   count by hundreds, so watch the per-corpus totals, not just individual
   files.

5. **Commit and push master**, then **create and push the tag** (this
   triggers the publish workflow):

   ```bash
   git push origin master
   git tag v<version>
   git push origin v<version>
   ```

   Or, after the tag exists, re-run manually:
   `gh workflow run publish.yml -R ishaq2321/tree-sitter-clean`

5. **Watch the run**:

   ```bash
   gh run list -R ishaq2321/tree-sitter-clean --workflow=publish.yml
   ```

   Each job skips with a clear message if its token is missing, so a
   "successful" run can still publish nothing — read the logs to confirm
   uploads actually happened.

## Gotchas learned the hard way (v1.2.0)

- **`tree-sitter parse` caches by language name, not source** — two
  different grammars both named `clean` share one `~/.cache/tree-sitter`
  entry, so a before/after corpus comparison without `-r` can compare a
  grammar against itself (an underscore-constructor change was once
  mis-measured as "0 regressions" while it added thousands of ERROR nodes).
  Always use the cache-free gate (`scripts/corpus_regression.py`), or pass
  `-r` to force a rebuild; never trust a "no regressions" result from bare
  `tree-sitter parse` runs across two checkouts.
- **`secrets` is not allowed in job-level `if:`** — GitHub rejects the
  whole workflow ("This run likely failed because of a workflow file
  issue"). The v1.2.0 workflow guards tokens *inside* the publish step
  with a shell check instead. Validate changes with
  [actionlint](https://github.com/rhysd/actionlint):
  `/tmp/actionlint .github/workflows/publish.yml`.
- **PyPI rejects the `linux_x86_64` platform tag** — wheels must be
  `manylinux`-tagged. `setup.py`'s `BdistWheel.get_tag` maps the Ubuntu
  24.04 runner (glibc 2.39) to `manylinux_2_39_x86_64`. If the CI runner
  changes, update that floor to match its glibc.
- **npm returns 404 for non-owned packages** — if `npm publish` fails
  with E404, the token's account does not have publish access; regenerate
  the token from the owning account (or add the account as a maintainer).
- **Published versions are immutable** — npm, crates.io, and PyPI all
  reject re-uploads. If a job fails partway, fix and publish the *next*
  version; never reuse a version number.
- **crates.io needs a verified email on the account**, separate from
  cargo login.
