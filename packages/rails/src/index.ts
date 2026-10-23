export type * from "./types.js";

// TODO(rails-metal): export createMetalAdapter(mode) from ./metal (x402 via @metalntwx/metal-pay).
// TODO(rails-airwallex): export createAirwallexAdapters(mode) from ./airwallex
//   (transfer, fx, card + CardControls). Sandbox simulation endpoints live behind mode === "sandbox".
// TODO(rails): unit conversion helpers at the boundary only:
//   cents <-> USDZ 18-decimal base units (bigint), cents <-> Airwallex major units (string decimal).
