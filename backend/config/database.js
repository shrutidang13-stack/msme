const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const env = require("./env");

const dbPath = path.resolve(process.cwd(), env.databasePath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_master (
      id TEXT PRIMARY KEY,
      vendor_name TEXT NOT NULL,
      normalized_vendor_name TEXT NOT NULL UNIQUE,
      is_msme INTEGER NOT NULL DEFAULT 0,
      udyam_number TEXT,
      enterprise_type TEXT,
      pan_number TEXT,
      agreed_payment_days INTEGER,
      verification_status TEXT NOT NULL DEFAULT 'pending',
      enterprise_name TEXT,
      registration_validity TEXT,
      registration_date TEXT,
      verified_at TEXT,
      last_verified_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vendor_master_normalized_name
      ON vendor_master(normalized_vendor_name);

    CREATE TABLE IF NOT EXISTS vendor_audit_log (
      id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      changed_by TEXT,
      changed_at TEXT NOT NULL,
      source TEXT,
      FOREIGN KEY(vendor_id) REFERENCES vendor_master(id)
    );

    CREATE TABLE IF NOT EXISTS tally_import_runs (
      id TEXT PRIMARY KEY,
      fiscal_year TEXT NOT NULL,
      period_type TEXT NOT NULL DEFAULT 'financial_year',
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      as_on TEXT NOT NULL,
      company_name TEXT,
      status TEXT NOT NULL,
      error TEXT,
      summary_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tally_import_creditors (
      id TEXT PRIMARY KEY,
      import_run_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      normalized_vendor_name TEXT NOT NULL,
      outstanding_amount REAL NOT NULL DEFAULT 0,
      days_outstanding INTEGER,
      bucket TEXT,
      delayed INTEGER NOT NULL DEFAULT 0,
      interest_liability REAL NOT NULL DEFAULT 0,
      disallowance_amount REAL NOT NULL DEFAULT 0,
      oldest_invoice_date TEXT,
      pan_number TEXT,
      agreed_payment_days INTEGER,
      opening_balance REAL NOT NULL DEFAULT 0,
      closing_balance REAL NOT NULL DEFAULT 0,
      opening_balance_raw TEXT,
      closing_balance_raw TEXT,
      voucher_count INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT NOT NULL,
      FOREIGN KEY(import_run_id) REFERENCES tally_import_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_import_creditors_run
      ON tally_import_creditors(import_run_id);

    CREATE TABLE IF NOT EXISTS tally_ledger_vouchers (
      id TEXT PRIMARY KEY,
      import_run_id TEXT NOT NULL,
      fiscal_year TEXT NOT NULL DEFAULT '',
      company_name TEXT NOT NULL DEFAULT '',
      vendor_name TEXT NOT NULL DEFAULT '',
      normalized_vendor_name TEXT NOT NULL DEFAULT '',
      ledger_name TEXT NOT NULL,
      normalized_ledger_name TEXT NOT NULL,
      voucher_date TEXT,
      particulars TEXT,
      voucher_type TEXT,
      voucher_number TEXT,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      bill_reference TEXT,
      pending_amount REAL NOT NULL DEFAULT 0,
      party_ledger_name TEXT NOT NULL DEFAULT '',
      ledger_parent TEXT NOT NULL DEFAULT '',
      group_hierarchy_json TEXT NOT NULL DEFAULT '[]',
      voucher_source TEXT NOT NULL DEFAULT 'Day Book',
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(import_run_id) REFERENCES tally_import_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tally_ledger_vouchers_run
      ON tally_ledger_vouchers(import_run_id);

    CREATE INDEX IF NOT EXISTS idx_tally_ledger_vouchers_ledger
      ON tally_ledger_vouchers(import_run_id, normalized_ledger_name);

    CREATE TABLE IF NOT EXISTS udyam_verification_attempts (
      id TEXT PRIMARY KEY,
      vendor_id TEXT,
      vendor_name TEXT NOT NULL,
      udyam_number TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT NOT NULL,
      screenshot_path TEXT,
      attempted_by TEXT,
      attempted_at TEXT NOT NULL,
      FOREIGN KEY(vendor_id) REFERENCES vendor_master(id)
    );

    CREATE TABLE IF NOT EXISTS compliance_reports (
      id TEXT PRIMARY KEY,
      import_run_id TEXT NOT NULL,
      fiscal_year TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(import_run_id) REFERENCES tally_import_runs(id)
    );

    CREATE TABLE IF NOT EXISTS mca_msme1_filings (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      import_run_id TEXT NOT NULL,
      fiscal_year TEXT NOT NULL,
      half_year TEXT NOT NULL,
      status TEXT NOT NULL,
      template_path TEXT NOT NULL DEFAULT '',
      generated_file_path TEXT NOT NULL DEFAULT '',
      row_count INTEGER NOT NULL DEFAULT 0,
      validation_json TEXT NOT NULL DEFAULT '{}',
      mca_user_id TEXT NOT NULL DEFAULT '',
      srn TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(report_id) REFERENCES compliance_reports(id),
      FOREIGN KEY(import_run_id) REFERENCES tally_import_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mca_msme1_filings_report
      ON mca_msme1_filings(report_id);

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id TEXT PRIMARY KEY,
      vendor_id TEXT,
      vendor_name TEXT NOT NULL,
      normalized_vendor_name TEXT NOT NULL,
      invoice_number TEXT,
      invoice_date TEXT,
      due_date TEXT,
      invoice_amount REAL NOT NULL DEFAULT 0,
      outstanding_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      source TEXT NOT NULL DEFAULT 'manual',
      source_file_name TEXT,
      udyam_number TEXT,
      udyam_status TEXT NOT NULL DEFAULT 'not_started',
      notes TEXT,
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(vendor_id) REFERENCES vendor_master(id)
    );

    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_vendor
      ON purchase_invoices(normalized_vendor_name);

    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_source
      ON purchase_invoices(source, created_at);
  `);

  const tableColumns = (tableName) => db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
  const addMissingColumns = (tableName, columns) => {
    const existingColumns = tableColumns(tableName);
    for (const [name, ddl] of columns) {
      if (!existingColumns.includes(name)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
    }
  };

  addMissingColumns("vendor_master", [
    ["udyam_status", "udyam_status TEXT NOT NULL DEFAULT 'not_started'"],
    ["udyam_proof_file_url", "udyam_proof_file_url TEXT"],
    ["udyam_proof_uploaded_at", "udyam_proof_uploaded_at TEXT"],
    ["udyam_verified_by", "udyam_verified_by TEXT"],
    ["udyam_verified_at", "udyam_verified_at TEXT"],
    ["udyam_remarks", "udyam_remarks TEXT"],
    ["action_status", "action_status TEXT NOT NULL DEFAULT 'pending_action'"],
    ["excluded_reason", "excluded_reason TEXT"],
    ["evidence_url", "evidence_url TEXT"],
    ["proof_notes", "proof_notes TEXT"],
    ["review_status", "review_status TEXT NOT NULL DEFAULT 'queued'"],
    ["reviewed_by", "reviewed_by TEXT"],
    ["reviewed_at", "reviewed_at TEXT"],
    ["review_comment", "review_comment TEXT"],
    ["source_import_run_id", "source_import_run_id TEXT"],
    ["last_import_run_id", "last_import_run_id TEXT"],
    ["pan_number", "pan_number TEXT"],
    ["agreed_payment_days", "agreed_payment_days INTEGER"],
  ]);

  addMissingColumns("tally_ledger_vouchers", [
    ["fiscal_year", "fiscal_year TEXT NOT NULL DEFAULT ''"],
    ["company_name", "company_name TEXT NOT NULL DEFAULT ''"],
    ["vendor_name", "vendor_name TEXT NOT NULL DEFAULT ''"],
    ["normalized_vendor_name", "normalized_vendor_name TEXT NOT NULL DEFAULT ''"],
    ["bill_reference", "bill_reference TEXT"],
    ["pending_amount", "pending_amount REAL NOT NULL DEFAULT 0"],
    ["party_ledger_name", "party_ledger_name TEXT NOT NULL DEFAULT ''"],
    ["ledger_parent", "ledger_parent TEXT NOT NULL DEFAULT ''"],
    ["group_hierarchy_json", "group_hierarchy_json TEXT NOT NULL DEFAULT '[]'"],
    ["voucher_source", "voucher_source TEXT NOT NULL DEFAULT 'Day Book'"],
  ]);

  addMissingColumns("tally_import_runs", [
    ["period_type", "period_type TEXT NOT NULL DEFAULT 'financial_year'"],
  ]);

  addMissingColumns("tally_import_creditors", [
    ["opening_balance", "opening_balance REAL NOT NULL DEFAULT 0"],
    ["closing_balance", "closing_balance REAL NOT NULL DEFAULT 0"],
    ["opening_balance_raw", "opening_balance_raw TEXT"],
    ["closing_balance_raw", "closing_balance_raw TEXT"],
    ["voucher_count", "voucher_count INTEGER NOT NULL DEFAULT 0"],
    ["pan_number", "pan_number TEXT"],
    ["agreed_payment_days", "agreed_payment_days INTEGER"],
  ]);

  addMissingColumns("mca_msme1_filings", [
    ["mca_user_id", "mca_user_id TEXT NOT NULL DEFAULT ''"],
    ["srn", "srn TEXT NOT NULL DEFAULT ''"],
    ["uploaded_at", "uploaded_at TEXT"],
  ]);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tally_ledger_vouchers_vendor
      ON tally_ledger_vouchers(import_run_id, normalized_vendor_name);
  `);
}

migrate();

module.exports = db;
