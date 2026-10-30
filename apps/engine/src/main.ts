import { createEngine } from "./server.js";

/** Starts the engine on ENGINE_PORT (default 4000). Mock rails only. */
const port = Number(process.env["ENGINE_PORT"] ?? 4000);
const { app } = createEngine();
app.listen(port, "127.0.0.1", () => {
  console.log(`engine on http://127.0.0.1:${port} (GET /tasks?role=sourcing, POST /proposals)`);
});
