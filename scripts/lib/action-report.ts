import { Buffer } from "node:buffer";

export type Report = {
  outcome: "success" | "attention" | "blocked";
  reason: string;
  summary: string;
  subject?: { type: string; id: string; revision: string; url: string };
};
export function actionEvent(
  kind: "progress" | "result",
  value: Report | { state: "waiting"; summary: string },
): void {
  const event =
    kind === "result"
      ? { kind, report: { version: 1, ...value } }
      : { kind, progress: { version: 1, ...value } };
  const runId = process.env.T3CODE_ACTION_RUN_ID;
  const token = process.env.T3CODE_ACTION_EVENT_TOKEN;
  if (runId && token) {
    const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
    process.stdout.write(`\u001b]777;T3ActionEvent;${runId};${token};${payload}\u0007`);
  } else console.log(JSON.stringify(event));
}
