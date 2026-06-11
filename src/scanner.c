#include <tree_sitter/parser.h>
#include <assert.h>
#include <string.h>

enum TokenType {
    LAYOUT_SEMICOLON,
    LAYOUT_START,
    LAYOUT_END,
};

#define MAX_INDENT_STACK 100

typedef struct {
    uint16_t indent_length_stack[MAX_INDENT_STACK];
    uint32_t indent_length_stack_size;
} Scanner;

void *tree_sitter_clean_external_scanner_create() {
    Scanner *scanner = (Scanner *)calloc(1, sizeof(Scanner));
    scanner->indent_length_stack[0] = 0;
    scanner->indent_length_stack_size = 1;
    return scanner;
}

void tree_sitter_clean_external_scanner_destroy(void *payload) {
    free(payload);
}

unsigned tree_sitter_clean_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    size_t size = scanner->indent_length_stack_size * sizeof(uint16_t);
    if (size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
        size = TREE_SITTER_SERIALIZATION_BUFFER_SIZE;
    }
    memcpy(buffer, scanner->indent_length_stack, size);
    return size;
}

void tree_sitter_clean_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    if (length == 0) {
        scanner->indent_length_stack_size = 1;
        scanner->indent_length_stack[0] = 0;
        return;
    }
    size_t size = length / sizeof(uint16_t);
    memcpy(scanner->indent_length_stack, buffer, length);
    scanner->indent_length_stack_size = size;
}

bool tree_sitter_clean_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    if (valid_symbols[LAYOUT_END] && lexer->eof(lexer)) {
        if (scanner->indent_length_stack_size > 1) {
            scanner->indent_length_stack_size--;
            lexer->result_symbol = LAYOUT_END;
            return true;
        }
    }

    bool has_newline = false;
    uint32_t indent_length = 0;

    while (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\n' || lexer->lookahead == '\r') {
        if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
            has_newline = true;
            indent_length = 0;
        } else {
            indent_length++;
        }
        lexer->advance(lexer, true);
    }

    if (lexer->eof(lexer)) {
        if (valid_symbols[LAYOUT_END] && scanner->indent_length_stack_size > 1) {
            scanner->indent_length_stack_size--;
            lexer->result_symbol = LAYOUT_END;
            return true;
        }
        if (valid_symbols[LAYOUT_SEMICOLON]) {
            lexer->result_symbol = LAYOUT_SEMICOLON;
            return true;
        }
        return false;
    }

    if (has_newline) {
        uint16_t current_indent = scanner->indent_length_stack[scanner->indent_length_stack_size - 1];

        if (indent_length == current_indent && valid_symbols[LAYOUT_SEMICOLON]) {
            // Don't break before keywords that continue the current declaration:
            // 'w' → where / with blocks
            // '|' → guard equations (handled in grammar, but be safe)
            if (lexer->lookahead == 'w') {
                return false;
            }
            lexer->result_symbol = LAYOUT_SEMICOLON;
            return true;
        }

        if (indent_length < current_indent && valid_symbols[LAYOUT_END]) {
            scanner->indent_length_stack_size--;
            lexer->result_symbol = LAYOUT_END;
            return true;
        }
    }

    if (valid_symbols[LAYOUT_START]) {
        uint16_t current_indent = scanner->indent_length_stack[scanner->indent_length_stack_size - 1];
        if (indent_length > current_indent) {
            if (scanner->indent_length_stack_size < MAX_INDENT_STACK) {
                scanner->indent_length_stack[scanner->indent_length_stack_size++] = indent_length;
            }
            lexer->result_symbol = LAYOUT_START;
            return true;
        }
    }

    return false;
}
