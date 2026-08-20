import 'server-only';
import { z } from 'zod';
import type { ToolDefinition } from './types';

/**
 * A minimal, dependency-free recursive-descent parser for arithmetic
 * expressions: + - * / ( ) and decimal numbers, with unary minus.
 * Deliberately NOT using eval()/Function() — those would let a model's
 * tool-call arguments run arbitrary JS, which is an unacceptable risk
 * for a 'safe' risk-level tool.
 */
function evaluateExpression(expr: string): number {
  let pos = 0;

  function peek(): string {
    return expr[pos] ?? '';
  }

  function consumeWhitespace() {
    while (peek() === ' ' || peek() === '\t') pos++;
  }

  function parseNumber(): number {
    consumeWhitespace();
    const start = pos;
    if (peek() === '-' || peek() === '+') pos++;
    let sawDigit = false;
    while (/[0-9]/.test(peek())) {
      pos++;
      sawDigit = true;
    }
    if (peek() === '.') {
      pos++;
      while (/[0-9]/.test(peek())) {
        pos++;
        sawDigit = true;
      }
    }
    if (!sawDigit) {
      throw new Error(`Expected a number at position ${start}`);
    }
    return Number(expr.slice(start, pos));
  }

  function parseFactor(): number {
    consumeWhitespace();
    if (peek() === '(') {
      pos++;
      const value = parseExpr();
      consumeWhitespace();
      if (peek() !== ')') throw new Error('Missing closing parenthesis');
      pos++;
      return value;
    }
    if (peek() === '-') {
      pos++;
      return -parseFactor();
    }
    return parseNumber();
  }

  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      consumeWhitespace();
      if (peek() === '*') {
        pos++;
        value *= parseFactor();
      } else if (peek() === '/') {
        pos++;
        const divisor = parseFactor();
        if (divisor === 0) throw new Error('Division by zero');
        value /= divisor;
      } else {
        break;
      }
    }
    return value;
  }

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      consumeWhitespace();
      if (peek() === '+') {
        pos++;
        value += parseTerm();
      } else if (peek() === '-') {
        pos++;
        value -= parseTerm();
      } else {
        break;
      }
    }
    return value;
  }

  const result = parseExpr();
  consumeWhitespace();
  if (pos !== expr.length) {
    throw new Error(`Unexpected character at position ${pos}: "${expr[pos]}"`);
  }
  if (!Number.isFinite(result)) {
    throw new Error('Result is not a finite number');
  }
  return result;
}

const calculatorInputSchema = z.object({
  expression: z
    .string()
    .min(1)
    .max(200)
    .describe('An arithmetic expression using +, -, *, /, parentheses, and numbers only.'),
});

type CalculatorInput = z.infer<typeof calculatorInputSchema>;

export const calculatorTool: ToolDefinition<CalculatorInput, { result: number }> = {
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression (addition, subtraction, multiplication, division, parentheses). Use this for any numeric calculation instead of computing it yourself.',
  inputSchema: calculatorInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'An arithmetic expression, e.g. "(2 + 3) * 4"',
      },
    },
    required: ['expression'],
  },
  outputDescription: 'An object { result: number } with the computed value.',
  riskLevel: 'safe',
  requiredPermission: 'member',
  async execute(input) {
    try {
      const result = evaluateExpression(input.expression);
      return { success: true, output: { result } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to evaluate expression',
      };
    }
  },
};
