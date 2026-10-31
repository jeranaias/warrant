import { purposeFromEnv } from "@warrant/control";
import { createEngine } from "./server.js";

/** Starts the engine on ENGINE_PORT (default 4000). Mock rails only. */
const port = Number(process.env["ENGINE_PORT"] ?? 4000);
// Lane A's purpose check: the model when ANTHROPIC_API_KEY is set, else the deterministic one.
const { app } = createEngine({ purpose: purposeFromEnv() });
app.listen(port, "127.0.0.1", () => {
  console.log(`engine on http://127.0.0.1:${port} (GET /tasks?role=sourcing, POST /proposals)`);
});
