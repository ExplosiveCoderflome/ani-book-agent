import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeDatabasePath } from "../mastra/storage-url";

export interface ProductionReceipt {
  idempotencyKey: string;
  novelId: string;
  workflowRunId: string;
  createdAt: string;
}

export class ProductionReceiptStore {
  private readonly database: DatabaseSync;

  constructor(filePath = resolveRuntimeDatabasePath("production-receipts.sqlite3", "PRODUCTION_RECEIPT_DB_PATH")) {
    this.database = new DatabaseSync(filePath);
    this.database.exec(`CREATE TABLE IF NOT EXISTS production_receipts (
      idempotency_key TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  record(receipt: ProductionReceipt) {
    this.database.prepare("INSERT OR IGNORE INTO production_receipts (idempotency_key, novel_id, workflow_run_id, created_at) VALUES (?, ?, ?, ?)")
      .run(receipt.idempotencyKey, receipt.novelId, receipt.workflowRunId, receipt.createdAt);
    return this.byKey(receipt.idempotencyKey)!;
  }

  byKey(idempotencyKey: string): ProductionReceipt | undefined {
    const row = this.database.prepare("SELECT * FROM production_receipts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? { idempotencyKey: String(row.idempotency_key), novelId: String(row.novel_id), workflowRunId: String(row.workflow_run_id), createdAt: String(row.created_at) } : undefined;
  }

  close() { this.database.close(); }
}
