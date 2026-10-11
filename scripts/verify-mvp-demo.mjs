import { loadDemoConfig, verifyStandardDemo } from "./mvp-demo-lib.mjs";

const result = await verifyStandardDemo(loadDemoConfig());
console.log(JSON.stringify(result, null, 2));
