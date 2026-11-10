import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { getAgentByName } from "agents";
import { MODEL, type Digest } from "./shared";
import type { Env } from "./index";

type Params = {
  agentName: string;
  transcript: string;
  openBlockers: { id: number; text: string }[];
};

type Extracted = Omit<Digest, "digestMd">;

const SCHEMA = {
  type: "object",
  properties: {
    done: { type: "array", items: { type: "string" } },
    next: { type: "array", items: { type: "string" } },
    new_blockers: { type: "array", items: { type: "string" } },
    resolved_blocker_ids: { type: "array", items: { type: "number" } },
  },
  required: ["done", "next", "new_blockers", "resolved_blocker_ids"],
};

const retry = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

export class DigestWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { agentName, transcript, openBlockers } = event.payload;

    // Step 1: turn the conversation into structured data
    const extracted = await step.do("extract structure", retry, async () => {
      const blockerList = openBlockers.length
        ? openBlockers.map((b) => `[${b.id}] ${b.text}`).join("\n")
        : "(none)";

      const res: any = await this.env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "Extract a standup from the transcript. 'done' and 'next' are short phrases. " +
              "'new_blockers' are blockers the person mentioned that are not already listed. " +
              "'resolved_blocker_ids' are ids from the open blocker list that the person said are now resolved. " +
              "Only include what the person actually said.\n\nOpen blockers:\n" +
              blockerList,
          },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
      });

      const r = res.response;
      return (typeof r === "string" ? JSON.parse(r) : r) as Extracted;
    });

    // Step 2: write a short human-readable digest
    const digestMd = await step.do("write digest", retry, async () => {
      const res: any = await this.env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "Write a standup digest in under 80 words using exactly three short sections titled " +
              "'Done', 'Next' and 'Blocked'. Plain text, dash bullets, no preamble.",
          },
          { role: "user", content: JSON.stringify(extracted) },
        ],
        max_tokens: 250,
      });
      return String(res.response ?? "").trim();
    });

    // Step 3: hand the result back to the user's agent, which stores it
    await step.do("save to agent", retry, async () => {
      const stub = await getAgentByName(this.env.StandupAgent, agentName);
      await stub.saveDigest({ ...extracted, digestMd });
    });
  }
}
