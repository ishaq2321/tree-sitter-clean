#include "tree_sitter/parser.h"
#include <stdbool.h>
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
 *     _layout_semicolon, _layout_start, _layout_end, block_comment
 *
 * Design notes
 * ------------
 * Layout decisions are made ONLY at the start of a line (after a newline has
 * been crossed). The scanner advances past leading whitespace on the new line
 * to measure its indentation, then compares against the indent stack:
 *   col > current  -> LAYOUT_START     (a new, deeper block begins)
 *   col == current -> LAYOUT_SEMICOLON (a sibling at the same level)
 *   col < current  -> LAYOUT_END       (one or more blocks close)
 * The scanner never opens a block mid-line, so columns inside an expression
 * (e.g. around = or operands) are never mistaken for layout.
 * ========================================================================== */

enum TokenType {
  LAYOUT_SEMICOLON,
  LAYOUT_START,
  LAYOUT_END,
  BLOCK_COMMENT,
};

#define MAX_INDENT_STACK 100

typedef struct {
  uint16_t indent_stack[MAX_INDENT_STACK]; /* column where each block began */
  uint32_t indent_size;                    /* number of open blocks        */
} Scanner;

static void scanner_init(Scanner *s) {
  s->indent_stack[0] = 0;
  s->indent_size = 1;
}

void *tree_sitter_clean_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  scanner_init(s);
  return s;
}

void tree_sitter_clean_external_scanner_destroy(void *payload) {
  free(payload);
}

unsigned tree_sitter_clean_external_scanner_serialize(void *payload,
                                                     char *buffer) {
  Scanner *s = (Scanner *)payload;
  size_t size = s->indent_size * sizeof(uint16_t);
  if (size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    size = TREE_SITTER_SERIALIZATION_BUFFER_SIZE;
  }
  memcpy(buffer, s->indent_stack, size);
  return (unsigned)size;
}

void tree_sitter_clean_external_scanner_deserialize(void *payload,
                                                    const char *buffer,
                                                    unsigned length) {
  Scanner *s = (Scanner *)payload;
  if (length == 0) {
    scanner_init(s);
    return;
  }
  size_t n = length / sizeof(uint16_t);
  if (n > MAX_INDENT_STACK) {
    n = MAX_INDENT_STACK;
  }
  memcpy(s->indent_stack, buffer, n * sizeof(uint16_t));
  s->indent_size = (uint32_t)n;
}

/* ---------- helpers ---------------------------------------------------- */

static bool is_space(int32_t c) { return c == ' ' || c == '\t'; }
static bool is_newline(int32_t c) { return c == '\n' || c == '\r'; }

/* Forward declaration: needed because the whitespace-skipping loop calls
 * scan_block_comment before its definition appears in the file. */
static bool scan_block_comment(TSLexer *lexer);

/* Returns true if the next input looks like a "where"/"with" continuation
 * keyword. These keywords attach a nested block to the *current* declaration;
 * when they follow at the same indentation, the scanner must NOT emit a layout
 * separator, otherwise the enclosing declaration terminates before it can
 * consume the clause.
 *
 * We peek WITHOUT consuming: tree-sitter only offers single-char lookahead, so
 * we check for a leading 'w'. A top-level identifier that merely starts with
 * 'w' (e.g. "wrap = ...") would suppress one separator, but the parser simply
 * re-attempts parsing at that line and recovers; correctness is preserved. */
static bool at_continuation_keyword(TSLexer *lexer) {
  return lexer->lookahead == 'w';
}


/* Consumes a (possibly nested) block comment starting at the current '/'.
 * Returns true if a comment was consumed. Leaves the lexer positioned just
 * past the closing star-slash, or at EOF if unterminated. */
static bool scan_block_comment(TSLexer *lexer) {
  if (lexer->lookahead != '/') {
    return false;
  }
  lexer->advance(lexer, false); /* consume '/' */
  if (lexer->lookahead != '*') {
    return false; /* not a block comment after all */
  }
  lexer->advance(lexer, false); /* consume '*' */

  unsigned depth = 1;
  while (depth > 0) {
    if (lexer->eof(lexer)) {
      return true; /* unterminated; emit what we have */
    }
    int32_t c = lexer->lookahead;
    if (c == '/') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '*') {
        depth++;
        lexer->advance(lexer, false);
      }
      continue;
    }
    if (c == '*') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '/') {
        depth--;
        lexer->advance(lexer, false);
      }
      continue;
    }
    lexer->advance(lexer, false);
  }
  return true;
}

/* ---------- main scan entry -------------------------------------------- */

bool tree_sitter_clean_external_scanner_scan(void *payload, TSLexer *lexer,
                                             const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  /* 1) Nested block comments are checked first so a comment never disturbs
   *    the layout bookkeeping. They may appear anywhere, not just at line
   *    starts. */
  if (valid_symbols[BLOCK_COMMENT]) {
    if (lexer->lookahead == '/') {
      if (scan_block_comment(lexer)) {
        lexer->result_symbol = BLOCK_COMMENT;
        return true;
      }
    }
  }

  const bool want_semi = valid_symbols[LAYOUT_SEMICOLON];
  const bool want_start = valid_symbols[LAYOUT_START];
  const bool want_end = valid_symbols[LAYOUT_END];

  if (!(want_semi || want_start || want_end)) {
    return false;
  }

  /* 2) Advance past whitespace and comments, tracking whether we crossed at
   *    least one newline. Layout decisions are taken only at line starts. */
  bool crossed_newline = false;
  for (;;) {
    int32_t c = lexer->lookahead;
    if (is_space(c)) {
      lexer->advance(lexer, true);
      continue;
    }
    if (is_newline(c)) {
      crossed_newline = true;
      lexer->advance(lexer, true);
      continue;
    }
    if (c == '/' && scan_block_comment(lexer)) {
      /* A block comment does not start a new line on its own; keep measuring
       * indentation against the final line. */
      continue;
    }
    break;
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

  /* 4) If we did not cross a newline, do not make a layout decision. The
   *    parser is only in a layout-expecting state here transiently, and
   *    emitting a token mid-line would corrupt columns. */
  if (!crossed_newline) {
    return false;
  }

  uint32_t col = lexer->get_column(lexer);
  uint16_t current = s->indent_stack[s->indent_size - 1];

  /* More indented -> open a new block. */
  if (want_start && col > current) {
    if (s->indent_size < MAX_INDENT_STACK) {
      s->indent_stack[s->indent_size++] = (uint16_t)col;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_START;
    return true;
  }

  /* Same indentation -> sibling separator. But do NOT separate if the next
   * token is a "where"/"with" continuation keyword: those attach a nested
   * block to the current declaration, so separating here would terminate it
   * prematurely. */
  if (want_semi && col == current && !at_continuation_keyword(lexer)) {
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_SEMICOLON;
    return true;
  }

  /* Less indented -> close one or more blocks. */
  if (want_end && col < current) {
    while (s->indent_size > 1 && s->indent_stack[s->indent_size - 1] > col) {
      s->indent_size--;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_END;
    return true;
  }

  return false;
}
