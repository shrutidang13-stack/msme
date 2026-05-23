const crypto = require("crypto");
const db = require("../config/database");
const { normalizeVendorName } = require("../utils/normalizeVendorName");
const { isSundryCreditorRow } = require("../utils/sundryCreditor");

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function logImportStage(stage, details = {}) {
  console.log(`[tally-import] stage=${stage} ${JSON.stringify(details)}`);
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    fiscalYear: row.fiscal_year,
    fromDate: row.from_date,
    toDate: row.to_date,
    asOn: row.as_on,
    companyName: row.company_name || "",
    status: row.status,
    error: row.error || "",
    summary: parseJson(row.summary_json, {}),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCreditor(row, vendorMaster = null) {
  const raw = parseJson(row.raw_json, {});
  const sundryCreditor = isSundryCreditorRow(raw);
  return {
    id: row.id,
    importRunId: row.import_run_id,
    party: row.vendor_name,
    normalizedVendorName: row.normalized_vendor_name,
    outstandingAmount: row.outstanding_amount,
    daysOutstanding: row.days_outstanding,
    bucket: row.bucket || "Unknown",
    delayed: Boolean(row.delayed),
    interestLiability: row.interest_liability,
    disallowanceAmount: row.disallowance_amount,
    oldestInvoiceDate: row.oldest_invoice_date || "",
    openingBalance: Number(row.opening_balance ?? raw.openingBalance ?? 0),
    closingBalance: Number(row.closing_balance ?? raw.closingBalance ?? 0),
    openingBalanceRaw: row.opening_balance_raw || raw.openingBalanceRaw || "",
    closingBalanceRaw: row.closing_balance_raw || raw.closingBalanceRaw || "",
    openingBalanceType: raw.openingBalanceType || "",
    closingBalanceType: raw.closingBalanceType || "",
    ledgerOutstandingAmount: Number(raw.ledgerOutstandingAmount ?? row.outstanding_amount ?? 0),
    voucherOutstandingAmount: Number(raw.voucherOutstandingAmount ?? 0),
    outstandingMismatch: Boolean(raw.outstandingMismatch),
    mismatchReason: raw.mismatchReason || "",
    payableAging: raw.payableAging || null,
    voucherCount: Number(row.voucher_count ?? raw.voucherCount ?? 0),
    detectedUdyamNumber: raw.udyamNumber || raw.detectedUdyamNumber || "",
    gstin: raw.gstin || "",
    panNumber: row.pan_number || raw.panNumber || "",
    agreedPaymentDays: Number(row.agreed_payment_days ?? raw.agreedPaymentDays ?? 0),
    parent: raw.parent || "",
    groupHierarchy: Array.isArray(raw.groupHierarchy) ? raw.groupHierarchy : [],
    detectionReasons: Array.isArray(raw.detectionReasons) ? raw.detectionReasons : [],
    isSundryCreditor: sundryCreditor,
    raw,
    vendorMaster,
  };
}

function mapLedgerVoucher(row) {
  return {
    id: row.id,
    importRunId: row.import_run_id,
    fiscalYear: row.fiscal_year || "",
    companyName: row.company_name || "",
    vendorName: row.vendor_name || row.ledger_name,
    normalizedVendorName: row.normalized_vendor_name || row.normalized_ledger_name,
    ledgerName: row.ledger_name,
    normalizedLedgerName: row.normalized_ledger_name,
    date: row.voucher_date || "",
    particulars: row.particulars || "",
    voucherType: row.voucher_type || "",
    voucherNumber: row.voucher_number || "",
    debit: row.debit || 0,
    credit: row.credit || 0,
    amount: row.amount || 0,
    billReference: row.bill_reference || "",
    pendingAmount: row.pending_amount || 0,
    voucherSource: row.voucher_source || "Day Book",
    raw: parseJson(row.raw_json, {}),
    createdAt: row.created_at,
  };
}

function createRun({ fiscalYear, fromDate, toDate, asOn, companyName, status = "running", actor }) {
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO tally_import_runs (
      id, fiscal_year, from_date, to_date, as_on, company_name, status, summary_json, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, fiscalYear, fromDate, toDate, asOn, companyName || "", status, "{}", actor || "unknown", timestamp, timestamp);
  return id;
}

function completeRun(id, { summary, creditors, ledgerVouchers = [] }) {
  let persistedVoucherCount = 0;
  let sampleVoucher = null;
  const runContext = db.prepare("SELECT fiscal_year, company_name FROM tally_import_runs WHERE id = ?").get(id) || {};
  const fiscalYear = summary?.fiscalYear || runContext.fiscal_year || "";
  const companyName = summary?.companyName || runContext.company_name || "";
  logImportStage("voucherPersist", {
    status: "start",
    importRunId: id,
    fiscalYear,
    companyName,
    exportedVoucherCount: ledgerVouchers.length,
    parsedVoucherCount: ledgerVouchers.length,
  });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM tally_import_creditors WHERE import_run_id = ?").run(id);
    db.prepare("DELETE FROM tally_ledger_vouchers WHERE import_run_id = ?").run(id);
    const insert = db.prepare(`
      INSERT INTO tally_import_creditors (
        id, import_run_id, vendor_name, normalized_vendor_name, outstanding_amount, days_outstanding,
        bucket, delayed, interest_liability, disallowance_amount, oldest_invoice_date,
        pan_number, agreed_payment_days, opening_balance, closing_balance, opening_balance_raw, closing_balance_raw, voucher_count, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const voucherCountsByVendor = new Map();
    for (const voucher of ledgerVouchers) {
      const vendorName = voucher.vendorName || voucher.ledgerName;
      const normalizedVendorName = voucher.normalizedVendorName || voucher.normalizedLedgerName || normalizeVendorName(vendorName);
      if (!normalizedVendorName) continue;
      voucherCountsByVendor.set(normalizedVendorName, (voucherCountsByVendor.get(normalizedVendorName) || 0) + 1);
    }
    for (const creditor of creditors) {
      const normalizedVendorName = creditor.normalizedVendorName || normalizeVendorName(creditor.party);
      const voucherCount = voucherCountsByVendor.get(normalizedVendorName) || creditor.voucherCount || 0;
      insert.run(
        crypto.randomUUID(),
        id,
        creditor.party,
        normalizedVendorName,
        creditor.outstandingAmount || 0,
        creditor.daysOutstanding ?? null,
        creditor.bucket || "Unknown",
        creditor.delayed ? 1 : 0,
        creditor.interestLiability || 0,
        creditor.disallowanceAmount || 0,
        creditor.oldestInvoiceDate || "",
        creditor.panNumber || "",
        creditor.agreedPaymentDays || creditor.vendorMaster?.agreedPaymentDays || 0,
        creditor.openingBalance || 0,
        creditor.closingBalance || 0,
        creditor.openingBalanceRaw || "",
        creditor.closingBalanceRaw || "",
        voucherCount,
        JSON.stringify({ ...creditor, voucherCount })
      );
    }
    const insertVoucher = db.prepare(`
      INSERT INTO tally_ledger_vouchers (
        id, import_run_id, fiscal_year, company_name, vendor_name, normalized_vendor_name,
        ledger_name, normalized_ledger_name, voucher_date, particulars, voucher_type,
        voucher_number, debit, credit, amount, bill_reference, pending_amount, voucher_source, raw_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = nowIso();
    const seenVouchers = new Set();
    let duplicateVoucherCount = 0;
    for (const voucher of ledgerVouchers) {
      const vendorName = voucher.vendorName || voucher.ledgerName;
      const normalizedVendorName = voucher.normalizedVendorName || voucher.normalizedLedgerName || normalizeVendorName(vendorName);
      const voucherKey = [
        normalizedVendorName,
        voucher.date || "",
        voucher.voucherType || "",
        voucher.voucherNumber || "",
        voucher.amount || Math.max(voucher.debit || 0, voucher.credit || 0),
        voucher.billReference || "",
      ].join("|");
      if (seenVouchers.has(voucherKey)) {
        duplicateVoucherCount += 1;
        continue;
      }
      seenVouchers.add(voucherKey);
      insertVoucher.run(
        crypto.randomUUID(),
        id,
        fiscalYear,
        companyName,
        vendorName,
        normalizedVendorName,
        voucher.ledgerName,
        voucher.normalizedLedgerName || normalizedVendorName,
        voucher.date || "",
        voucher.particulars || "",
        voucher.voucherType || "",
        voucher.voucherNumber || "",
        voucher.debit || 0,
        voucher.credit || 0,
        voucher.amount || Math.max(voucher.debit || 0, voucher.credit || 0),
        voucher.billReference || "",
        voucher.pendingAmount || 0,
        voucher.voucherSource || "Day Book",
        JSON.stringify(voucher.raw || voucher),
        timestamp
      );
    }
    persistedVoucherCount = db.prepare("SELECT COUNT(*) AS total FROM tally_ledger_vouchers WHERE import_run_id = ?").get(id).total;
    sampleVoucher = db.prepare("SELECT * FROM tally_ledger_vouchers WHERE import_run_id = ? ORDER BY voucher_date ASC, ledger_name ASC LIMIT 1").get(id);
    const finalSummary = {
      ...(summary || {}),
      vouchersPersisted: persistedVoucherCount,
      duplicateVouchersSkipped: duplicateVoucherCount,
    };
    db.prepare(`
      UPDATE tally_import_runs
      SET status = 'completed', company_name = ?, summary_json = ?, error = '', updated_at = ?
      WHERE id = ?
    `).run(companyName, JSON.stringify(finalSummary), nowIso(), id);
  });
  tx();
  logImportStage("voucherPersist", {
    status: "success",
    importRunId: id,
    fiscalYear,
    companyName,
    persistedVoucherCount,
    duplicateVouchersSkipped: ledgerVouchers.length - persistedVoucherCount,
    sampleVoucher: sampleVoucher ? {
      ledgerName: sampleVoucher.ledger_name,
      date: sampleVoucher.voucher_date,
      voucherType: sampleVoucher.voucher_type,
      voucherNumber: sampleVoucher.voucher_number,
      billReference: sampleVoucher.bill_reference || "",
      voucherSource: sampleVoucher.voucher_source || "Day Book",
      amount: sampleVoucher.amount,
    } : null,
  });
}

function failRun(id, error) {
  db.prepare("UPDATE tally_import_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
    error.message || String(error),
    nowIso(),
    id
  );
}

function getRun(id) {
  return mapRun(db.prepare("SELECT * FROM tally_import_runs WHERE id = ?").get(id));
}

function listRuns() {
  return db.prepare("SELECT * FROM tally_import_runs ORDER BY created_at DESC LIMIT 50").all().map(mapRun);
}

function getRawCreditorRows(importRunId) {
  return db.prepare("SELECT * FROM tally_import_creditors WHERE import_run_id = ? ORDER BY outstanding_amount DESC").all(importRunId);
}

function getIgnoredNonSundryCreditors(importRunId) {
  return getRawCreditorRows(importRunId)
    .map((row) => mapCreditor(row))
    .filter((row) => !isSundryCreditorRow(row));
}

function getCreditors(importRunId) {
  return getRawCreditorRows(importRunId).map((row) => mapCreditor(row)).filter(isSundryCreditorRow);
}

function getSundryCreditorNames(importRunId) {
  return new Set(getCreditors(importRunId).map((creditor) => creditor.normalizedVendorName).filter(Boolean));
}

function isAllFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "all" || normalized === "all ledgers" || normalized === "all voucher types";
}

function getLedgerVouchers(importRunId, filters = {}) {
  const where = ["import_run_id = ?"];
  const params = [importRunId];
  const sundryNames = getSundryCreditorNames(importRunId);
  const hasCreditorRows = getRawCreditorRows(importRunId).length > 0;
  if (hasCreditorRows && sundryNames.size === 0) {
    where.push("1 = 0");
  } else if (sundryNames.size > 0) {
    where.push(`normalized_ledger_name IN (${Array.from(sundryNames).map(() => "?").join(",")})`);
    params.push(...Array.from(sundryNames));
  }
  const ledgerName = isAllFilter(filters.ledgerName) ? "" : filters.ledgerName;
  const voucherType = isAllFilter(filters.voucherType) ? "" : filters.voucherType;

  if (ledgerName) {
    where.push("normalized_ledger_name = ?");
    params.push(normalizeVendorName(ledgerName));
  }
  if (voucherType) {
    where.push("LOWER(voucher_type) = LOWER(?)");
    params.push(voucherType);
  }
  if (filters.fromDate) {
    where.push("voucher_date >= ?");
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    where.push("voucher_date <= ?");
    params.push(filters.toDate);
  }
  if (filters.search) {
    where.push("(LOWER(ledger_name) LIKE LOWER(?) OR LOWER(particulars) LIKE LOWER(?) OR LOWER(voucher_number) LIKE LOWER(?) OR LOWER(bill_reference) LIKE LOWER(?))");
    const query = `%${filters.search}%`;
    params.push(query, query, query, query);
  }

  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 250, 1), 1000);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
  const whereSql = where.join(" AND ");
  const rows = db.prepare(`
    SELECT * FROM tally_ledger_vouchers
    WHERE ${whereSql}
    ORDER BY voucher_date ASC, ledger_name ASC, voucher_number ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map(mapLedgerVoucher);
  const total = db.prepare(`SELECT COUNT(*) AS total FROM tally_ledger_vouchers WHERE ${whereSql}`).get(...params).total;
  logImportStage("voucherQuery", {
    importRunId,
    filters: {
      ledgerName: ledgerName || null,
      voucherType: voucherType || null,
      fromDate: filters.fromDate || null,
      toDate: filters.toDate || null,
      search: filters.search || null,
    },
    queriedVoucherCount: rows.length,
    total,
    limit,
    offset,
    sampleVoucher: rows[0] ? {
      ledgerName: rows[0].ledgerName,
      date: rows[0].date,
      voucherType: rows[0].voucherType,
      voucherNumber: rows[0].voucherNumber,
      billReference: rows[0].billReference,
      voucherSource: rows[0].voucherSource,
      amount: rows[0].amount,
    } : null,
  });
  return { rows, total, limit, offset };
}

function getAllLedgerVouchers(importRunId) {
  const sundryNames = getSundryCreditorNames(importRunId);
  const hasCreditorRows = getRawCreditorRows(importRunId).length > 0;
  const rows = db.prepare(`
    SELECT * FROM tally_ledger_vouchers
    WHERE import_run_id = ?
    ORDER BY voucher_date ASC, ledger_name ASC, voucher_number ASC
  `).all(importRunId).map(mapLedgerVoucher);
  if (hasCreditorRows && !sundryNames.size) return [];
  if (!sundryNames.size) return rows;
  return rows.filter((row) => sundryNames.has(row.normalizedLedgerName || row.normalizedVendorName));
}

function getLedgerVoucherDiagnostics(importRunId) {
  const total = db.prepare("SELECT COUNT(*) AS total FROM tally_ledger_vouchers WHERE import_run_id = ?").get(importRunId).total;
  const sample = db.prepare("SELECT * FROM tally_ledger_vouchers WHERE import_run_id = ? ORDER BY voucher_date ASC, ledger_name ASC LIMIT 1").get(importRunId);
  return {
    importRunId,
    persistedVoucherCount: total,
    sampleVoucher: sample ? mapLedgerVoucher(sample) : null,
  };
}

module.exports = {
  createRun,
  completeRun,
  failRun,
  getRun,
  listRuns,
  getCreditors,
  getIgnoredNonSundryCreditors,
  getLedgerVouchers,
  getAllLedgerVouchers,
  getLedgerVoucherDiagnostics,
  mapCreditor,
  mapLedgerVoucher,
};
