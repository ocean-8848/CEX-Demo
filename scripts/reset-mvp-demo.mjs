import { loadDemoConfig, resetDemoState, setDemoMakersPaused } from "./mvp-demo-lib.mjs";

const config = loadDemoConfig();
// Stop the simulator makers first so no new trades race with the truncation;
// `pnpm demo:bootstrap` resumes them once the seed data is back.
await setDemoMakersPaused(config, true);
const result = await resetDemoState(config);
console.log(JSON.stringify(result, null, 2));
