import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ReportDetails = {
  title: string;
  variant?: "info" | "success" | "warning" | "error";
  timestamp: number;
};

export const REPORT_TYPE = "codex-report";

export function sendReport(
  pi: ExtensionAPI,
  title: string,
  markdown: string,
  variant: ReportDetails["variant"] = "info",
  options?: { triggerTurn?: boolean; deliverAs?: "followUp" | "nextTurn" },
): void {
  pi.sendMessage(
    {
      customType: REPORT_TYPE,
      content: markdown,
      display: true,
      details: {
        title,
        variant,
        timestamp: Date.now(),
      } satisfies ReportDetails,
    },
    options,
  );
}
