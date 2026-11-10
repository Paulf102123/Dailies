import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage,
} from "agents";
import { DigestWorkflow } from "./workflow";
import { MODEL, type Digest } from "./shared";

export { DigestWorkflow };

export interface Env {
  AI: Ai;
  StandupAgent: DurableObjectNamespace<StandupAgent>;
  DIGEST_WORKFLOW: Workflow;
}

type Msg = { role: "user" | "assistant"; content: string };
type State = { session: Msg[]; status: "idle" | "active" | "processing" };

const DAY = 86_400_000;

export class StandupAgent extends Agent<Env, State> {
  initialState: State = { session: [], status: "idle" };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS standups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      digest_md TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS blockers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER
    )`;
  }

  async onConnect(connection: Connection) {
    this.sync(connection);
  }

  async onMessage(_connection: Connection, raw: WSMessage) {
    if (typeof raw !== "string") return;
    let msg: { type?: string; text?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "user" && msg.text?.trim()) return this.handleUser(msg.text.trim());
    if (msg.type === "finish") return this.finish();
    if (msg.type === "enable_daily") return this.enableDaily();
  }

  // ---- conversation ---------------------------------------------------

  private async handleUser(text: string) {
    if (this.state.status === "processing") return;
    const session: Msg[] = [...this.state.session, { role: "user", content: text }];
    this.setState({ status: "active", session });
    this.sync();

    const reply = await this.reply(session);
    this.setState({
      status: "active",
      session: [...session, { role: "assistant", content: reply }],
    });
    this.sync();
  }

  private async reply(session: Msg[]): Promise<string> {
    const now = Date.now();
    const blockers = this.openBlockers()
      .map((b) => `- [${b.id}] ${b.text} (open ${Math.floor((now - b.opened_at) / DAY)} days)`)
      .join("\n");
    const last = this.sql<{ digest_md: string }>`
      SELECT digest_md FROM standups ORDER BY id DESC LIMIT 1`[0]?.digest_md;

    const system =
      "You are a concise daily standup partner. Ask one short question at a time covering: " +
      "what they finished, what is next, and anything blocking them. Keep replies under 40 words. " +
      "If an open blocker is listed below, ask about it once, early; push gently if it has been open 3+ days. " +
      "When you have all three topics, tell them they can press Finish standup. Never invent progress.\n\n" +
      `Open blockers:\n${blockers || "(none)"}\n\n` +
      `Last standup:\n${last ?? "(none yet)"}`;

    const res: any = await this.env.AI.run(MODEL, {
      messages: [{ role: "system", content: system }, ...session],
      max_tokens: 200,
    });
    return String(res.response ?? "Sorry, I lost that. Can you say it again?").trim();
  }

  // ---- end of standup: hand off to a Workflow ---------------------------

  private async finish() {
    if (this.state.session.length === 0 || this.state.status === "processing") return;

    const transcript = this.state.session
      .map((m) => `${m.role === "user" ? "Person" : "Agent"}: ${m.content}`)
      .join("\n");

    this.setState({ ...this.state, status: "processing" });
    this.sync();

    await this.env.DIGEST_WORKFLOW.create({
      params: {
        agentName: this.name,
        transcript,
        openBlockers: this.openBlockers().map(({ id, text }) => ({ id, text })),
      },
    });
  }

  // Called by the Workflow (via Durable Object RPC) when the digest is ready
  async saveDigest(d: Digest) {
    const now = Date.now();
    this.sql`INSERT INTO standups (created_at, digest_md) VALUES (${now}, ${d.digestMd})`;
    for (const text of d.new_blockers ?? []) {
      this.sql`INSERT INTO blockers (text, opened_at) VALUES (${text}, ${now})`;
    }
    for (const id of d.resolved_blocker_ids ?? []) {
      this.sql`UPDATE blockers SET resolved_at = ${now} WHERE id = ${id} AND resolved_at IS NULL`;
    }
    this.setState({ session: [], status: "idle" });
    this.sync();
  }

  // ---- scheduling -------------------------------------------------------

  private async enableDaily() {
    const existing = this.getSchedules().filter((s) => s.callback === "dailyCheckIn");
    if (existing.length === 0) {
      // Cron runs in UTC. Adjust to your morning.
      await this.schedule("0 14 * * 1-5", "dailyCheckIn");
    }
  }

  async dailyCheckIn() {
    if (this.state.session.length > 0) return;
    this.setState({
      status: "active",
      session: [
        {
          role: "assistant",
          content: "Time for standup. What did you finish since last time?",
        },
      ],
    });
    this.sync();
  }

  // ---- helpers ----------------------------------------------------------

  private openBlockers() {
    return this.sql<{ id: number; text: string; opened_at: number }>`
      SELECT id, text, opened_at FROM blockers WHERE resolved_at IS NULL ORDER BY id`;
  }

  private sync(to?: Connection) {
    const payload = JSON.stringify({
      type: "sync",
      status: this.state.status,
      session: this.state.session,
      blockers: this.openBlockers(),
      history: this.sql<{ created_at: number; digest_md: string }>`
        SELECT created_at, digest_md FROM standups ORDER BY id DESC LIMIT 7`,
    });
    if (to) to.send(payload);
    else this.broadcast(payload);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
