import { bootstrapStandardDemo, loadDemoConfig, setDemoMakersPaused } from "./mvp-demo-lib.mjs";

const config = loadDemoConfig();
const result = await bootstrapStandardDemo(config);
await setDemoMakersPaused(config, false);
console.log(JSON.stringify(result, null, 2));
