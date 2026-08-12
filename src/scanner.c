#include "tree_sitter/parser.h"
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ==========================================================================
 * External scanner for the Clean grammar.
 *
 * Responsibilities:
 *   1. Layout (offside rule): emit LAYOUT_START / LAYOUT_SEMICOLON / LAYOUT_END
 *      based on indentation. Clean is layout-sensitive: the start of a block
 *      is signalled by a keyword (where, with, let...in, case...of) followed
 *      by an indented region of sibling declarations.
 *   2. Nested block comments: Clean comments nest, unlike C. They can only be
 *      balanced correctly in an external scanner, so BLOCK_COMMENT is
 *      externalised here.
 *
 * Token order in TokenType MUST match the externals array in grammar.js:
 *     _layout_semicolon, _layout_start, _inline_layout_start, _layout_end,
 *     block_comment
 *
 * Design notes
 * ------------
 * Layout decisions are made ONLY at the start of a line (after a newline has
 * been crossed). The scanner advances past leading whitespace on the new line
 * to measure its indentation, then compares against the indent stack:
 *   col > current  -> LAYOUT_START     (a new, deeper block begins)
 *   col == current -> LAYOUT_SEMICOLON (a sibling at the same level)
 *   col < current  -> LAYOUT_END       (one block closes)
 * A dedent that falls below several levels emits ONE LAYOUT_END per level:
 * the scanner pops a single level per token, and the parser — which needs a
 * closing LAYOUT_END for each open block — requests the next one at the same
 * position until the stack is drained. This keeps nested where/with blocks
 * from racing for a single token (which let following declarations escape
 * into the wrong block).
 * The scanner never opens a block mid-line, so columns inside an expression
 * (e.g. around = or operands) are never mistaken for layout.
 *
 * The one exception is `where`/`with` blocks, which may open on the SAME line
 * as their first binding (`... = b with (ys,zs) = span p xs`). Those request
 * LAYOUT_INLINE_START: the scanner records the indentation of the line it is
 * currently on (s->line_indent, refreshed whenever a newline is crossed) and
 * pushes it as a layout level, so the block can later be closed by a normal
 * LAYOUT_END when the following line dedents.
 * ========================================================================== */

enum TokenType {
  LAYOUT_SEMICOLON,
  LAYOUT_START,
  LAYOUT_INLINE_START,
  LAYOUT_END,
  BLOCK_COMMENT,
};

#define MAX_INDENT_STACK 100

typedef struct {
  uint16_t indent_stack[MAX_INDENT_STACK]; /* column where each block began */
  uint8_t level_kind[MAX_INDENT_STACK];    /* how each level was opened      */
  uint32_t indent_size;                    /* number of open blocks        */
  uint16_t dedent_target;                  /* column of the current dedent */
  bool dedenting;                          /* mid multi-level dedent chain */
  bool pending_block;                      /* block opened mid-line, level deferred */
  bool pending_inline;                     /* the deferred block is a where/with
                                              (INLINE kind), not a special block */
  uint32_t dedent_pos;                     /* byte offset where the dedent chain
                                              landed; step 4b only fires there */
} Scanner;

/* What kind of construct opened a layout level. A guard bar `|` at the level
 * of a `where`/`with` member continues the CURRENT function's own guard list
 * (no separator wanted); a `|` at the level of a guard/case/let block opens a
 * NEW member of that block (separator wanted). The scanner records how each
 * level was pushed so the separator decision can tell the two apart. */
#define LEVEL_KIND_START 0  /* `_layout_start` (guard/case/let blocks) */
#define LEVEL_KIND_INLINE 1 /* `_inline_layout_start` (where/with)    */

/* Level pushed for a `where`/`with` block that opens on the SAME line as its
 * binding (e.g. `... = b with (ys,zs) = span p xs`). Such a block holds only
 * the binding on the keyword's line, so ANY subsequent line (no matter its
 * indentation) closes it — hence a sentinel greater than any real column. */
#define INLINE_BLOCK_LEVEL 0xFFFF

/* Level pushed when the scanner is asked for an inline block-start by a state
 * that wants EVERY layout token at once (the error-recovery state). Those
 * requests are not genuine block opens, but the tree-sitter runtime only
 * accepts a zero-width external token during recovery if the scanner's
 * serialized state CHANGED — so a level must be pushed for the token to be
 * skipped at all. Marking it phantom lets the dedent logic pop all phantom
 * levels in a single token (no block ever consumed one, so none needs its own
 * closing END), leaving one LAYOUT_END per REAL level. */
#define PHANTOM_BLOCK_LEVEL (INLINE_BLOCK_LEVEL - 1)

static void scanner_init(Scanner *s) {
  s->indent_stack[0] = 0;
  s->level_kind[0] = LEVEL_KIND_START;
  s->indent_size = 1;
  s->dedent_target = 0;
  s->dedenting = false;
  s->pending_block = false;
  s->pending_inline = false;
  s->dedent_pos = 0;
}

void *tree_sitter_clean_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  scanner_init(s);
  return s;
}

void tree_sitter_clean_external_scanner_destroy(void *payload) {
  free(payload);
}

/* The serialized payload is the indent stack, then the level kinds (one byte
 * per level), then the dedent-chain state: 1 byte for `dedenting`, the 2-byte
 * `dedent_target`, 1 byte for `pending_block`, and the 4-byte `dedent_pos`.
 * (The stack is at most MAX_INDENT_STACK * 3 = 300 bytes, well under the
 * buffer size.) */
unsigned tree_sitter_clean_external_scanner_serialize(void *payload,
                                                     char *buffer) {
  Scanner *s = (Scanner *)payload;
  size_t stack_bytes = s->indent_size * sizeof(uint16_t);
  size_t kind_bytes = s->indent_size * sizeof(uint8_t);
  if (stack_bytes + kind_bytes + 8 > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    size_t room = TREE_SITTER_SERIALIZATION_BUFFER_SIZE - 8;
    stack_bytes = (room * sizeof(uint16_t)) / (sizeof(uint16_t) + sizeof(uint8_t));
    kind_bytes = (stack_bytes * sizeof(uint8_t)) / sizeof(uint16_t);
  }
  memcpy(buffer, s->indent_stack, stack_bytes);
  memcpy(buffer + stack_bytes, s->level_kind, kind_bytes);
  char *tail = buffer + stack_bytes + kind_bytes;
  tail[0] = s->dedenting ? 1 : 0;
  memcpy(tail + 1, &s->dedent_target, sizeof(uint16_t));
  tail[3] = s->pending_block ? 1 : 0;
  tail[4] = s->pending_inline ? 1 : 0;
  memcpy(tail + 5, &s->dedent_pos, sizeof(uint32_t));
  return (unsigned)(stack_bytes + kind_bytes + 9);
}

void tree_sitter_clean_external_scanner_deserialize(void *payload,
                                                    const char *buffer,
                                                    unsigned length) {
  Scanner *s = (Scanner *)payload;
  if (length < 9) {
    scanner_init(s);
    return;
  }
  /* Recompute the split between stack bytes and kind bytes (both grow with
   * the level count; the serialized layout is stack bytes first). */
  size_t total = length - 9;
  size_t n = total / (sizeof(uint16_t) + sizeof(uint8_t));
  if (n > MAX_INDENT_STACK) {
    n = MAX_INDENT_STACK;
  }
  size_t stack_bytes = n * sizeof(uint16_t);
  memcpy(s->indent_stack, buffer, stack_bytes);
  memcpy(s->level_kind, buffer + stack_bytes, n * sizeof(uint8_t));
  s->indent_size = (uint32_t)n;
  s->dedenting = buffer[length - 9] != 0;
  memcpy(&s->dedent_target, buffer + length - 8, sizeof(uint16_t));
  s->pending_block = buffer[length - 6] != 0;
  s->pending_inline = buffer[length - 5] != 0;
  memcpy(&s->dedent_pos, buffer + length - 4, sizeof(uint32_t));
}

/* ---------- helpers ---------------------------------------------------- */

static bool is_space(int32_t c) { return c == ' ' || c == '\t'; }
static bool is_newline(int32_t c) { return c == '\n' || c == '\r'; }

/* Tabs expand to this many columns when measuring indentation. Clean's own
 * stdlib mixes tabs and spaces at the same visual level (e.g. `\t\t` and
 * `\t    ` in StdInt.icl), which only coincide at width 4. */
#define TAB_WIDTH 4

/* Scans the body of a (possibly nested) block comment. The lexer is positioned
 * at the '*' that follows the opening '/'. Consumes up to and including the
 * matching star-slash (or to EOF if unterminated). `*col` tracks the column
 * (tabs expanded) across the comment so a comment spanning lines still leaves
 * the correct indentation for the content after it. */
static void scan_block_comment_body(TSLexer *lexer, uint32_t *col) {
  lexer->advance(lexer, false); /* consume '*' */
  (*col)++; /* the '*' */

  unsigned depth = 1;
  while (depth > 0) {
    if (lexer->eof(lexer)) {
      return; /* unterminated; emit what we have */
    }
    int32_t c = lexer->lookahead;
    if (c == '/') {
      lexer->advance(lexer, false);
      (*col)++;
      if (lexer->lookahead == '*') {
        depth++;
        lexer->advance(lexer, false);
        (*col)++;
      }
      continue;
    }
    if (c == '*') {
      lexer->advance(lexer, false);
      (*col)++;
      if (lexer->lookahead == '/') {
        depth--;
        lexer->advance(lexer, false);
        (*col)++;
      }
      continue;
    }
    if (is_newline(c)) {
      lexer->advance(lexer, false);
      *col = 0;
      continue;
    }
    if (c == '\t') {
      lexer->advance(lexer, false);
      *col += TAB_WIDTH - (*col % TAB_WIDTH);
      continue;
    }
    lexer->advance(lexer, false);
    (*col)++;
  }
}

/* The lexer is positioned at '/'. If the next character is '*', consumes the
 * whole (nested) block comment and returns true. If it is anything else
 * (e.g. a "//" line comment), the '/' is left UNconsumed and false is
 * returned, so the caller can bail out and let the internal lexer handle it
 * (tree-sitter rewinds the position when an external scan returns false).
 * `*col` is advanced past the comment (tabs expanded).
 *
 * NOTE: it is not possible to peek two characters in a tree-sitter scanner
 * without consuming, so this consumes the '/' and relies on the rewind. */
static bool try_scan_block_comment(TSLexer *lexer, uint32_t *col) {
  if (lexer->lookahead != '/') {
    return false;
  }
  lexer->advance(lexer, false); /* consume '/' */
  (*col)++;
  if (lexer->lookahead != '*') {
    return false; /* "//" line comment or a lone '/' — not a block comment */
  }
  scan_block_comment_body(lexer, col);
  return true;
}

/* The lexer is positioned at the start of a word beginning with 'w'.
 * Consumes the word and reports whether it is exactly `where` or `with` —
 * the two continuation keywords whose presence at a same-column line start
 * suppresses the layout separator. A plain identifier like `while`/`when`
 * must NOT suppress it (it would glue the identifier to the previous
 * declaration as an application argument). Consuming is safe in both
 * outcomes: returning false from the scan rewinds the position (so the
 * keyword case is re-lexed by the internal lexer), and the non-keyword
 * case re-lexes the word too because the caller marks the token end
 * BEFORE the word (a zero-width separator). */
static bool is_where_or_with_keyword(TSLexer *lexer) {
  char word[8];
  unsigned len = 0;
  while (len < 7 &&
         (lexer->lookahead == '_' ||
          (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
          (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
          (lexer->lookahead >= '0' && lexer->lookahead <= '9'))) {
    word[len++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  word[len] = '\0';
  return (len == 5 && memcmp(word, "where", 5) == 0) ||
         (len == 4 && memcmp(word, "with", 4) == 0);
}

/* ---------- main scan entry -------------------------------------------- */

static bool scan_impl(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  /* 1) Nested block comments are checked first so a comment never disturbs
   *    the layout bookkeeping. They may appear anywhere, not just at line
   *    starts. A "//" line comment is NOT consumed here — we return false
   *    and let the internal lexer handle it. */
  const bool want_semi = valid_symbols[LAYOUT_SEMICOLON];
  const bool want_start = valid_symbols[LAYOUT_START];
  const bool want_inline = valid_symbols[LAYOUT_INLINE_START];
  const bool want_end = valid_symbols[LAYOUT_END];  if (valid_symbols[BLOCK_COMMENT]) {
    uint32_t ignore_col = 0;
    if (try_scan_block_comment(lexer, &ignore_col)) {
      lexer->result_symbol = BLOCK_COMMENT;
      return true;
    }
    if (lexer->lookahead == '/') {
      return false; /* "//" or lone '/' — not our token */
    }
  }

  if (!(want_semi || want_start || want_inline || want_end || valid_symbols[BLOCK_COMMENT])) {
    return false;
  }

  /* 2) Advance past whitespace and comments, tracking whether we crossed at
   *    least one newline and the indentation column (tabs expanded to
   *    TAB_WIDTH). Layout decisions are taken only at line starts. */
  bool crossed_newline = false;
  uint32_t col = 0;
  for (;;) {
    int32_t c = lexer->lookahead;
    if (is_space(c)) {
      lexer->advance(lexer, true);
      if (c == '\t') {
        col += TAB_WIDTH - (col % TAB_WIDTH);
      } else {
        col++;
      }
      continue;
    }
    if (is_newline(c)) {
      crossed_newline = true;
      col = 0;
      lexer->advance(lexer, true);
      continue;
    }
    if (c == '/') {
      if (try_scan_block_comment(lexer, &col)) {
        /* Emit the comment as the token (the internal lexer cannot lex block
         * comments — they are scanner-exclusive for nesting). The layout
         * decision is deferred to the next scan, which re-measures the
         * column from the comment's end. Consuming the comment silently
         * (and then emitting a layout token) would drop it from the tree. */
        lexer->mark_end(lexer);
        lexer->result_symbol = BLOCK_COMMENT;
        return true;
      }
      /* "//" line comment or a lone '/' at a layout-decision point: bail out
       * (the position is rewound) so the internal lexer handles the comment
       * and the layout decision is retried after it. */
      return false;
    }
    break;
  }

  uint16_t current = s->indent_stack[s->indent_size - 1];
  /* 2b) A block opened MID-LINE — its first member sits on the same line as
   * the opening keyword (`special a=Int` with continuation members on deeper
   * lines, an inline `case x of 0 -> a`, or `class C a where f :: ...`).
   * The block's layout level is unknown until the next line, so the start
   * request (step 5) recorded `pending_block` and emitted a zero-width
   * LAYOUT_START (a failed scan would DISCARD the flag — tree-sitter only
   * serializes scanner state after a successful token). Establish the level
   * here: if the next line is DEEPER than the enclosing level, the block
   * continues with members at this column — push the column and emit a
   * sibling separator (the first member is already parsed). Otherwise the
   * block held only the inline member: clear the flag and fall through, so
   * the normal logic emits the separator/end for the enclosing context. */
  if (s->pending_block) {
    s->pending_block = false;
    /* Read and clear both flags up front: a pushed level (the early return
     * below) must not leave `pending_inline` set, or a later `special`
     * deferral would wrongly inherit INLINE kind. */
    bool inline_kind = s->pending_inline;
    s->pending_inline = false;
    if (crossed_newline && want_semi && col > current) {
      if (s->indent_size < MAX_INDENT_STACK) {
        s->indent_stack[s->indent_size] = (uint16_t)col;
        /* A deferred `where`/`with` block hosts declarations whose own
         * guards/let-before bindings continue at the block's column — that
         * is the INLINE behaviour. A deferred `special` block has no such
         * members, so START is fine there. */
        s->level_kind[s->indent_size] =
            inline_kind ? LEVEL_KIND_INLINE : LEVEL_KIND_START;
        s->indent_size++;
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = LAYOUT_SEMICOLON;
      return true;
    }
    /* The deferred block did NOT continue on the next line (its only member
     * was the inline one, e.g. `... = b with (ys,zs) = span p xs` followed
     * by a dedent). No level was pushed, so step 4 has nothing to pop — and
     * worse, a same-column line (typically the ROOT column, 0) would hit
     * step 7 and emit a sibling SEMICOLON, letting the next top-level
     * declaration silently join the block as a member. Close the block
     * here: emit the missing LAYOUT_END. The re-request at this position
     * arrives at the SAME byte offset (the token is zero-width), so no
     * newline is crossed and step 7's same-column logic cannot fire for it.
     * Record the dedent chain (target = this line's column) so step 4b
     * emits the sibling separator at exactly this position — the chain
     * drains to a same-column target and fires there instead of at later,
     * mid-line positions. */
    if (crossed_newline && want_end && col <= current) {
      s->dedent_target = col;
      s->dedenting = true;
      s->dedent_pos = lexer->get_column(lexer);
      lexer->mark_end(lexer);
      lexer->result_symbol = LAYOUT_END;
      return true;
    }
  }

  /* 3) At EOF, close any open blocks, then emit a trailing separator. */
  if (lexer->eof(lexer)) {
    if (want_end && s->indent_size > 1) {
      s->indent_size--;
      lexer->result_symbol = LAYOUT_END;
      return true;
    }
    if (want_semi && s->indent_size >= 1) {
      lexer->result_symbol = LAYOUT_SEMICOLON;
      return true;
    }
    return false;
  }

  /* 4) Less indented -> close ONE block per token. A dedent can cross
   *    several layout levels, and each open block needs its own LAYOUT_END,
   *    so the scanner records the target column and pops a single level; the
   *    parser then re-requests at the same position and the scanner keeps
   *    popping one level per request until the stack drains to the target.
   *    The first token of the chain is measured at a line start; the
   *    re-requests come mid-position (no newline to measure, `col` is 0), so
   *    the remembered target — not the freshly measured column — decides when
   *    to stop. Genuinely mid-line requests (e.g. `want_end` inside a body
   *    expression) are never treated as dedents.
   *
   *    Phantom levels (pushed for error-recovery requests) are popped in one
   *    go: they were never consumed as block starts, so no block needs an END
   *    for them — collapsing them keeps the chain short even when error
   *    recovery piled up many. */
  if (want_end && ((crossed_newline && col < current) ||
                   (s->dedenting && current > s->dedent_target))) {
    if (crossed_newline) {
      s->dedent_target = col;
      s->dedenting = true;
    }
    while (s->indent_size > 1 &&
           s->indent_stack[s->indent_size - 1] == PHANTOM_BLOCK_LEVEL) {
      s->indent_size--;
    }
    if (s->indent_size > 1) {
      s->indent_size--;
    }
    /* Remember where the chain landed (the first token of the dedented
     * line). tree-sitter restores the scanner state after every failed
     * scan, so `dedenting` alone would let step 4b re-fire at LATER,
     * mid-line positions (e.g. the argument of a binding's value
     * expression) and spuriously emit a sibling separator there. Only the
     * position where the chain drained may receive that separator. */
    s->dedent_pos = lexer->get_column(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_END;
    return true;
  }

  /* 4b) The dedent chain has drained to its target column. If a block is
   *     still open at exactly that level, the next token is a SIBLING of the
   *     last member (emit a semicolon); if we are back at the root, the chain
   *     is complete and the following token starts a fresh declaration. A
   *     `where`/`with` continuation keyword is never separated here: it
   *     attaches a nested block to the current declaration. A `|` guard is
   *     separated only at guard-block levels (it starts a NEW member); at a
   *     where/with member level it continues the current function's guards. */
  if (s->dedenting) {
    /* Only the position where the chain drained may receive the sibling
     * separator; later positions (mid-line, inside a body expression, or on
     * subsequent lines) are past the chain and must fall through to the
     * normal block-start/separator logic — a guard's nested block needs
     * `_layout_start` at exactly this point. The `dedenting` flag is
     * resurrected by state rollback on failed scans, so this check is what
     * keeps 4b from firing everywhere. */
    if (lexer->get_column(lexer) != s->dedent_pos) {
      s->dedenting = false;
      goto past_dedent;
    }
    s->dedenting = false;
    bool skip_sep = false;
    if (lexer->lookahead == 'w') {
      /* Check the word before suppressing the separator: `where`/`with`
       * continue the declaration, but `while`/`when`/`w` start a new one
       * and MUST be separated (see is_where_or_with_keyword). */
      lexer->mark_end(lexer);
      if (is_where_or_with_keyword(lexer)) {
        return false; /* rewind; internal lexer produces the keyword */
      }
      if (want_semi && current == s->dedent_target && s->indent_size > 1) {
        lexer->result_symbol = LAYOUT_SEMICOLON; /* zero-width at word start */
        return true;
      }
      return false;
    }
    skip_sep =
        ((lexer->lookahead == '=' || lexer->lookahead == '#') &&
         (s->indent_size == 1 ||
          s->level_kind[s->indent_size - 1] == LEVEL_KIND_INLINE)) ||
        (lexer->lookahead == '|' &&
         s->level_kind[s->indent_size - 1] == LEVEL_KIND_INLINE);
    if (want_semi && current == s->dedent_target && s->indent_size > 1 &&
        !skip_sep) {
      lexer->mark_end(lexer);
      lexer->result_symbol = LAYOUT_SEMICOLON;
      return true;
    }
  }

past_dedent:
  /* 5) If we did not cross a newline, the only layout decisions left are
   *    block starts on the current line. A `where`/`with` opening mid-line
   *    (`... with (ys,zs) = span p xs`) holds only the binding on the
   *    keyword's line, so push the sentinel level: the very next line (at
   *    any indentation) closes it. A `_layout_start` requested mid-line
   *    (a block whose first member is inline, e.g. `special a=Int`) instead
   *    defers: see step 2b — the level is established at the next line's
   *    column if it is deeper, so continuation members join the block. */
  if (!crossed_newline) {
    /* Explicit brace layout: `where { ... }` (class/instance members). The
     * members are separated by literal `;` and closed by `}`, so NO layout
     * token is wanted — the parser consumes `{` directly. Emitting a
     * zero-width INLINE_START here would let the layout alternative grab
     * the token and then fail on `{`, with no GLR fork left to take the
     * brace path. */
    if (lexer->lookahead == '{' && (want_start || want_inline)) {
      return false;
    }
    /* A mid-line block start with BOTH `_layout_start` and
     * `_inline_layout_start` valid is a `special` block whose first member
     * is inline (`special a=Int`): the continuation members sit on deeper
     * lines whose column is not yet known. Emit a zero-width token (so the
     * pending flag survives serialization — a failed scan would discard
     * it) and defer the block level to the next line (step 2b). This exact
     * combination is unique to `special`: `let`/`case` offer only
     * `_layout_start`, `where`/`with` only `_inline_layout_start`, and the
     * error-recovery state sets all four flags. */
    if (want_start && want_inline && !want_semi && !want_end) {
      s->pending_block = true;
      lexer->mark_end(lexer);
      lexer->result_symbol = LAYOUT_INLINE_START;
      return true;
    }
    if (want_inline) {
      /* A genuine `where`/`with` block-open (`... = b with (ys,zs) =
       * span p xs`, or `where _from_by_to :: ...` with continuation members
       * on deeper lines) wants ONLY _inline_layout_start after the keyword.
       * The first member sits on the keyword's own line; whether later lines
       * CONTINUE the block (deeper column) or close it is decided at the
       * next line (step 2b), so defer like `special` blocks instead of
       * pushing a sentinel. The error-recovery state instead wants every
       * token at once (want_semi/start/inline/end all true) and may sit at
       * one position for many requests; those get a PHANTOM level — the push
       * keeps the serialized state changing so the runtime accepts and skips
       * the empty token (mirroring the pre-drain scanner), while the dedent
       * later collapses all phantoms in one token instead of draining one
       * LAYOUT_END per bogus level. */
      if (want_semi || want_start || want_end) {
        if (s->indent_size < MAX_INDENT_STACK) {
          s->indent_stack[s->indent_size] = PHANTOM_BLOCK_LEVEL;
          s->level_kind[s->indent_size] = LEVEL_KIND_START;
          s->indent_size++;
        }
      } else {
        s->pending_block = true;
        s->pending_inline = true;
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = LAYOUT_INLINE_START;
      return true;
    }
    return false;
  }

  /* 6) More indented -> open a new block. */
  if (col > current && (want_start || want_inline)) {
    if (s->indent_size < MAX_INDENT_STACK) {
      s->indent_stack[s->indent_size] = (uint16_t)col;
      /* A where/with member level hosts the declarations (and their own
       * guards) at the block's column; a `_layout_start` level hosts the
       * members of a guard/case/let block, where a `|` starts a NEW member. */
      s->level_kind[s->indent_size] =
          (want_inline && !want_start) ? LEVEL_KIND_INLINE : LEVEL_KIND_START;
      s->indent_size++;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol =
        want_inline && !want_start ? LAYOUT_INLINE_START : LAYOUT_START;
    return true;
  }

  /* 7) Same indentation -> sibling separator. But do NOT separate if the next
   * token continues the CURRENT declaration at this level: a "where"/"with"
   * keyword (attaches a nested block), or a guard bar `|` at a where/with
   * member level (continues the function's own guard list). A `|` at a
   * guard/case/let block level DOES get the separator — there it starts a new
   * member (a nested guard), which must not be swallowed by the previous
   * member's value expression. */
  if (want_semi && col == current) {
    if (lexer->lookahead == 'w') {
      /* See the 4b branch: only the real `where`/`with` keywords skip the
       * separator; `while`/`when`/`w` at a line start begin a new
       * declaration and need the semicolon. */
      lexer->mark_end(lexer);
      if (is_where_or_with_keyword(lexer)) {
        return false; /* rewind; internal lexer produces the keyword */
      }
      lexer->result_symbol = LAYOUT_SEMICOLON; /* zero-width at word start */
      return true;
    }
    /* A `=` or `#` at a same-column line start continues the CURRENT
     * declaration when no block member is possible — at the root (`f x` on
     * one line, `= code { ... }` on the next, or `# (a,b) = ...` let-before
     * bindings) or at a where/with member level. At a guard/case/let block
     * level (LEVEL_KIND_START) they begin a NEW member and MUST get the
     * separator. No declaration can begin with `=` or `#`.
     */
    bool skip_sep =
        ((lexer->lookahead == '=' || lexer->lookahead == '#') &&
         (s->indent_size == 1 ||
          s->level_kind[s->indent_size - 1] == LEVEL_KIND_INLINE)) ||
        (lexer->lookahead == '|' &&
         s->level_kind[s->indent_size - 1] == LEVEL_KIND_INLINE);
    if (!skip_sep) {
      lexer->mark_end(lexer);
      lexer->result_symbol = LAYOUT_SEMICOLON;
      return true;
    }
  }

  return false;
}

bool tree_sitter_clean_external_scanner_scan(void *payload, TSLexer *lexer,
                                             const bool *valid_symbols) {
  return scan_impl(payload, lexer, valid_symbols);
}
