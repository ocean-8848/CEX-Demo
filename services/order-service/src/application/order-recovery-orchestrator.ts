import { OrderRecoveryWorker, type OrderRecoveryWorkerOptions } from "./order-recovery-worker.js";

export type OrchestratorOptions = OrderRecoveryWorkerOptions;

export class OrderRecoveryOrchestrator extends OrderRecoveryWorker {}
