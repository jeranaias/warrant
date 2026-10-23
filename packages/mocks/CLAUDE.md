# packages/mocks

**Purpose:** local fake Airwallex + Metal servers so work does not block on sandbox access, plus
fault injection (timeouts, duplicates, 5xx) for testing control. See `README.md`.

**May import:** `@warrant/contracts`, an HTTP server library, node built-ins.

**Must never:**

- Be imported by production code paths in `control` or `agents`. Only rails' `mock` mode and
  tests talk to it, over HTTP.
- Invent API shapes. Match the real sandbox; check with the Airwallex docs MCP.
- Contain real keys or real card numbers (use documented test PANs only if needed).
