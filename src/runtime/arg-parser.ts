export function splitShellLikeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function splitLeadingOptionTokens(
  tokens: string[],
  optionsWithValues: Iterable<string> = [],
): { optionTokens: string[]; remainderTokens: string[] } {
  const optionTokens: string[] = [];
  const optionsWithValueSet = new Set(optionsWithValues);
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      return {
        optionTokens,
        remainderTokens: tokens.slice(index + 1),
      };
    }
    if (!token.startsWith("--")) {
      return {
        optionTokens,
        remainderTokens: tokens.slice(index),
      };
    }

    optionTokens.push(token);
    index += 1;

    const next = tokens[index];
    if (optionsWithValueSet.has(token) && next && next !== "--" && !next.startsWith("--")) {
      optionTokens.push(next);
      index += 1;
    }
  }

  return {
    optionTokens,
    remainderTokens: [],
  };
}
