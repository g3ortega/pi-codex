import { splitLeadingOptionTokens, splitShellLikeArgs } from "./arg-parser.js";
import { parseCodexThinkingLevel, type CodexThinkingLevel } from "./thinking.js";

export type TaskExecutionProfile = "write" | "readonly";

export type TaskCommandOptions = {
  background: boolean;
  profile: TaskExecutionProfile;
  modelSpec?: string;
  thinkingLevel?: CodexThinkingLevel;
  request: string;
};

export function parseTaskCommandOptions(rawArgs: string): TaskCommandOptions {
  const tokens = splitShellLikeArgs(rawArgs);
  const { optionTokens, remainderTokens } = splitLeadingOptionTokens(tokens, ["--model", "--thinking"]);
  const request: string[] = [...remainderTokens];
  let background = false;
  let profile: TaskExecutionProfile = "write";
  let modelSpec: string | undefined;
  let thinkingLevel: CodexThinkingLevel | undefined;

  for (let index = 0; index < optionTokens.length; index += 1) {
    const token = optionTokens[index];
    if (token === "--background") {
      background = true;
      continue;
    }
    if (token === "--readonly") {
      if (profile === "write" && optionTokens.includes("--write")) {
        throw new Error("Use either `--readonly` or `--write`, not both.");
      }
      profile = "readonly";
      continue;
    }
    if (token === "--write") {
      if (profile === "readonly") {
        throw new Error("Use either `--readonly` or `--write`, not both.");
      }
      profile = "write";
      continue;
    }
    if (token === "--model") {
      const next = optionTokens[index + 1];
      if (!next) {
        throw new Error("`--model` requires provider/modelId.");
      }
      modelSpec = next;
      index += 1;
      continue;
    }
    if (token === "--thinking") {
      thinkingLevel = parseCodexThinkingLevel(optionTokens[index + 1]);
      index += 1;
      continue;
    }

    request.push(...optionTokens.slice(index));
    break;
  }

  return {
    background,
    profile,
    modelSpec,
    thinkingLevel,
    request: request.join(" ").trim(),
  };
}
