# Dailies

A voice-ready daily standup agent on Cloudflare: Workers AI (Llama 3.3) + Agents SDK (Durable Object with SQLite) + Workflows + a chat/voice front end.

## Run it
```bash
npm install
npx wrangler login
npm run dev        # http://localhost:8787
npm run deploy
```
Workers AI and Workflows run against your Cloudflare account even in `wrangler dev`.

## Layout
- `src/index.ts`    StandupAgent (chat loop, SQLite memory, weekday schedule) and Worker entry
- `src/workflow.ts` DigestWorkflow (extract, write digest, save back to agent)
- `public/index.html` chat UI with browser speech input
