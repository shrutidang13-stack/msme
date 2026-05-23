const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const db = require("../config/database");
const importRepository = require("../repositories/importRepository");
const reportRepository = require("../repositories/reportRepository");
const { normalizeVendorName } = require("../utils/normalizeVendorName");

const TEMPLATE_PATH = path.resolve(process.cwd(), "backend/templates/MSME_Excel_Layout.xlsm");
const OUTPUT_DIR = path.resolve(process.cwd(), "backend/storage/mca-msme1");
const MAX_UTILITY_ROWS = 99998;
const DEFAULT_REASON = "Amount outstanding beyond MSMED Act payment period as per books";

function nowIso() {
  return new Date().toISOString();
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(fromDate, toDate) {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (!from || !to) return null;
  return Math.max(Math.floor((to - from) / 86400000), 0);
}

function halfYearRange(fiscalYear, halfYear) {
  const match = String(fiscalYear || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("Valid fiscalYear is required");
  const startYear = Number(match[1]);
  if (halfYear === "apr-sep") {
    return { label: "April-September", from: `${startYear}-04-01`, to: `${startYear}-09-30` };
  }
  if (halfYear === "oct-mar") {
    return { label: "October-March", from: `${startYear}-10-01`, to: `${startYear + 1}-03-31` };
  }
  throw new Error("halfYear must be apr-sep or oct-mar");
}

function inRange(date, range) {
  return date && date >= range.from && date <= range.to;
}

function voucherKind(row) {
  const type = String(row.voucherType || "").toLowerCase();
  if (/purchase|journal/.test(type)) return "invoice";
  if (/payment/.test(type)) return "payment";
  return "other";
}

function voucherAmount(row) {
  return roundMoney(row.pendingAmount || row.amount || Math.max(row.debit || 0, row.credit || 0));
}

function normalizeRef(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildPaidBuckets(vouchers = [], range, allowedDays = 45) {
  const byVendor = new Map();
  const ensureVendor = (row) => {
    const normalizedVendorName = row.normalizedVendorName || row.normalizedLedgerName || normalizeVendorName(row.vendorName || row.ledgerName);
    if (!normalizedVendorName) return null;
    if (!byVendor.has(normalizedVendorName)) byVendor.set(normalizedVendorName, { invoices: [], payments: [] });
    return byVendor.get(normalizedVendorName);
  };

  for (const row of vouchers) {
    const vendor = ensureVendor(row);
    if (!vendor || !row.date) continue;
    const amount = voucherAmount(row);
    if (!amount) continue;
    const billReference = normalizeRef(row.billReference || row.voucherNumber);
    const kind = voucherKind(row);
    if (kind === "invoice") {
      vendor.invoices.push({
        date: row.date,
        billReference,
        pendingAmount: amount,
      });
    } else if (kind === "payment") {
      vendor.payments.push({
        date: row.date,
        billReference,
        unappliedAmount: amount,
      });
    }
  }

  const buckets = new Map();
  const addPayment = (normalizedVendorName, invoice, payment, applied) => {
    if (!inRange(payment.date, range)) return;
    const delayDays = daysBetween(invoice.date, payment.date);
    const bucket = delayDays != null && delayDays <= allowedDays ? "paidWithin45Other" : "paidAfter45";
    const current = buckets.get(normalizedVendorName) || {
      paidWithin45OtherCount: 0,
      paidWithin45OtherAmount: 0,
      paidAfter45Count: 0,
      paidAfter45Amount: 0,
    };
    if (bucket === "paidWithin45Other") {
      current.paidWithin45OtherCount += 1;
      current.paidWithin45OtherAmount = roundMoney(current.paidWithin45OtherAmount + applied);
    } else {
      current.paidAfter45Count += 1;
      current.paidAfter45Amount = roundMoney(current.paidAfter45Amount + applied);
    }
    buckets.set(normalizedVendorName, current);
  };

  for (const [normalizedVendorName, vendor] of byVendor.entries()) {
    vendor.invoices.sort((a, b) => new Date(a.date) - new Date(b.date));
    vendor.payments.sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const payment of vendor.payments) {
      if (payment.billReference) {
        for (const invoice of vendor.invoices) {
          if (payment.unappliedAmount <= 0) break;
          if (!invoice.billReference || invoice.billReference !== payment.billReference || invoice.pendingAmount <= 0) continue;
          const applied = Math.min(invoice.pendingAmount, payment.unappliedAmount);
          invoice.pendingAmount = roundMoney(invoice.pendingAmount - applied);
          payment.unappliedAmount = roundMoney(payment.unappliedAmount - applied);
          addPayment(normalizedVendorName, invoice, payment, applied);
        }
      }
      for (const invoice of vendor.invoices) {
        if (payment.unappliedAmount <= 0) break;
        if (invoice.pendingAmount <= 0) continue;
        const applied = Math.min(invoice.pendingAmount, payment.unappliedAmount);
        invoice.pendingAmount = roundMoney(invoice.pendingAmount - applied);
        payment.unappliedAmount = roundMoney(payment.unappliedAmount - applied);
        addPayment(normalizedVendorName, invoice, payment, applied);
      }
    }
  }

  return buckets;
}

function emptyMcaRow(row, index, reason) {
  const panNumber = String(row.panNumber || "").trim().toUpperCase();
  return {
    serialNumber: index + 1,
    vendorName: row.vendorName,
    normalizedVendorName: row.normalizedVendorName || normalizeVendorName(row.vendorName),
    panNumber,
    paidWithin45TredsCount: 0,
    paidWithin45TredsAmount: 0,
    paidWithin45OtherCount: 0,
    paidWithin45OtherAmount: 0,
    paidAfter45Count: 0,
    paidAfter45Amount: 0,
    outstanding45OrLessCount: 0,
    outstanding45OrLessAmount: 0,
    outstandingMoreThan45Count: 0,
    outstandingMoreThan45Amount: 0,
    reason,
    source: {
      ledgerOutstandingAmount: Number(row.ledgerOutstandingAmount ?? row.outstandingAmount ?? 0),
      voucherOutstandingAmount: Number(row.voucherOutstandingAmount || 0),
      outstandingMismatch: Boolean(row.outstandingMismatch),
      daysOutstanding: row.daysOutstanding ?? null,
      delayDays: row.delayDays ?? null,
      udyamNumber: row.udyamNumber || "",
    },
  };
}

function totalsForRows(rows) {
  return rows.reduce((acc, row) => {
    for (const key of [
      "paidWithin45TredsCount",
      "paidWithin45TredsAmount",
      "paidWithin45OtherCount",
      "paidWithin45OtherAmount",
      "paidAfter45Count",
      "paidAfter45Amount",
      "outstanding45OrLessCount",
      "outstanding45OrLessAmount",
      "outstandingMoreThan45Count",
      "outstandingMoreThan45Amount",
    ]) {
      acc[key] = roundMoney((acc[key] || 0) + Number(row[key] || 0));
    }
    return acc;
  }, {});
}

function validateRows(rows) {
  const errors = [];
  const warnings = [];
  if (!rows.length) errors.push({ code: "no_rows", message: "No verified MSME supplier rows are available for MCA MSME-1." });
  if (rows.length > MAX_UTILITY_ROWS) errors.push({ code: "row_limit", message: `MCA utility supports up to ${MAX_UTILITY_ROWS} supplier rows.` });
  rows.forEach((row, index) => {
    if (!row.vendorName) errors.push({ code: "missing_vendor_name", row: index + 1, message: "Supplier name is required." });
    if (!row.panNumber) errors.push({ code: "missing_pan", row: index + 1, vendorName: row.vendorName, message: "Supplier PAN is required for MCA MSME-1 utility." });
    if (row.source.outstandingMismatch) warnings.push({ code: "ledger_voucher_mismatch", row: index + 1, vendorName: row.vendorName, message: "Ledger payable outstanding differs from voucher-only outstanding; ledger amount is used." });
  });
  return {
    errors,
    warnings,
    valid: errors.length === 0,
  };
}

function buildPreview({ reportId, halfYear = "oct-mar", reasonOverrides = {} }) {
  const report = reportRepository.getReport(reportId);
  if (!report) throw new Error("Report not found");
  const run = importRepository.getRun(report.importRunId);
  if (!run) throw new Error("Import run not found");
  const range = halfYearRange(report.fiscalYear, halfYear);
  const paidBuckets = buildPaidBuckets(importRepository.getAllLedgerVouchers(report.importRunId), range);

  const rows = (report.report || [])
    .map((row, index) => {
      const normalizedVendorName = row.normalizedVendorName || normalizeVendorName(row.vendorName);
      const reason = reasonOverrides[normalizedVendorName] || reasonOverrides[row.vendorName] || DEFAULT_REASON;
      const mcaRow = emptyMcaRow(row, index, reason);
      const paid = paidBuckets.get(normalizedVendorName) || {};
      mcaRow.paidWithin45OtherCount = paid.paidWithin45OtherCount || 0;
      mcaRow.paidWithin45OtherAmount = paid.paidWithin45OtherAmount || 0;
      mcaRow.paidAfter45Count = paid.paidAfter45Count || 0;
      mcaRow.paidAfter45Amount = paid.paidAfter45Amount || 0;
      const ledgerOutstanding = roundMoney(row.ledgerOutstandingAmount ?? row.outstandingAmount ?? 0);
      if (ledgerOutstanding > 0) {
        if (Number(row.daysOutstanding || 0) <= 45) {
          mcaRow.outstanding45OrLessCount = 1;
          mcaRow.outstanding45OrLessAmount = ledgerOutstanding;
        } else {
          mcaRow.outstandingMoreThan45Count = 1;
          mcaRow.outstandingMoreThan45Amount = ledgerOutstanding;
        }
      }
      return mcaRow;
    })
    .filter((row) =>
      row.paidWithin45OtherAmount > 0 ||
      row.paidAfter45Amount > 0 ||
      row.outstanding45OrLessAmount > 0 ||
      row.outstandingMoreThan45Amount > 0
    )
    .map((row, index) => ({ ...row, serialNumber: index + 1 }));

  const validation = validateRows(rows);
  return {
    reportId: report.id,
    importRunId: report.importRunId,
    fiscalYear: report.fiscalYear,
    halfYear,
    halfYearLabel: range.label,
    period: range,
    eligibleRowCount: rows.length,
    rows,
    totals: totalsForRows(rows),
    validation,
  };
}

function writeCell(sheet, address, value) {
  sheet[address] = {
    t: typeof value === "number" ? "n" : "s",
    v: typeof value === "number" ? roundMoney(value) : String(value || ""),
  };
}

function populateWorkbook(preview, outputPath) {
  if (!fs.existsSync(TEMPLATE_PATH)) throw new Error(`MCA MSME-1 template not found at ${TEMPLATE_PATH}`);
  const workbook = XLSX.readFile(TEMPLATE_PATH, { bookVBA: true, cellStyles: true, cellFormula: true });
  const sheet = workbook.Sheets.MSME;
  if (!sheet) throw new Error("MCA MSME-1 template is missing MSME sheet");
  preview.rows.forEach((row, index) => {
    const excelRow = index + 5;
    writeCell(sheet, `A${excelRow}`, row.serialNumber);
    writeCell(sheet, `B${excelRow}`, row.vendorName);
    writeCell(sheet, `C${excelRow}`, row.panNumber);
    writeCell(sheet, `D${excelRow}`, row.paidWithin45TredsCount);
    writeCell(sheet, `E${excelRow}`, row.paidWithin45TredsAmount);
    writeCell(sheet, `F${excelRow}`, row.paidWithin45OtherCount);
    writeCell(sheet, `G${excelRow}`, row.paidWithin45OtherAmount);
    writeCell(sheet, `H${excelRow}`, row.paidAfter45Count);
    writeCell(sheet, `I${excelRow}`, row.paidAfter45Amount);
    writeCell(sheet, `J${excelRow}`, row.outstanding45OrLessCount);
    writeCell(sheet, `K${excelRow}`, row.outstanding45OrLessAmount);
    writeCell(sheet, `L${excelRow}`, row.outstandingMoreThan45Count);
    writeCell(sheet, `M${excelRow}`, row.outstandingMoreThan45Amount);
    writeCell(sheet, `N${excelRow}`, row.reason);
  });
  sheet["!ref"] = "A1:N100003";
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(workbook, outputPath, { bookType: "xlsm", bookVBA: true, cellStyles: true });
}

function mapFiling(row) {
  if (!row) return null;
  let validation = {};
  try {
    validation = JSON.parse(row.validation_json || "{}");
  } catch {
    validation = {};
  }
  return {
    id: row.id,
    reportId: row.report_id,
    importRunId: row.import_run_id,
    fiscalYear: row.fiscal_year,
    halfYear: row.half_year,
    status: row.status,
    templatePath: row.template_path,
    generatedFilePath: row.generated_file_path,
    rowCount: row.row_count,
    validation,
    mcaUserId: row.mca_user_id || "",
    srn: row.srn || "",
    uploadedAt: row.uploaded_at || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    downloadUrl: row.generated_file_path ? `/api/mca/msme1/filings/${row.id}/download` : "",
  };
}

function saveFiling({ preview, status, outputPath = "", actor = "unknown", mcaUserId = "" }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mca_msme1_filings (
      id, report_id, import_run_id, fiscal_year, half_year, status, template_path,
      generated_file_path, row_count, validation_json, mca_user_id, srn, uploaded_at, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?)
  `).run(
    id,
    preview.reportId,
    preview.importRunId,
    preview.fiscalYear,
    preview.halfYear,
    status,
    TEMPLATE_PATH,
    outputPath,
    preview.rows.length,
    JSON.stringify(preview.validation),
    mcaUserId || "",
    actor,
    nowIso()
  );
  return getFiling(id);
}

function generate({ reportId, halfYear, reasonOverrides, actor }) {
  const preview = buildPreview({ reportId, halfYear, reasonOverrides });
  if (!preview.validation.valid) {
    return {
      success: true,
      generated: false,
      filing: saveFiling({ preview, status: "validation_failed", actor }),
      preview,
    };
  }
  const safeHalf = String(halfYear || "").replace(/[^a-z0-9-]/gi, "");
  const outputPath = path.join(OUTPUT_DIR, `MCA_MSME1_${preview.fiscalYear}_${safeHalf}_${Date.now()}.xlsm`);
  populateWorkbook(preview, outputPath);
  return {
    success: true,
    generated: true,
    filing: saveFiling({ preview, status: "generated", outputPath, actor }),
    preview,
  };
}

function getFiling(id) {
  return mapFiling(db.prepare("SELECT * FROM mca_msme1_filings WHERE id = ?").get(id));
}

function listFilings() {
  return db.prepare("SELECT * FROM mca_msme1_filings ORDER BY created_at DESC LIMIT 50").all().map(mapFiling);
}

function recordSrn(id, { srn, actor }) {
  const filing = getFiling(id);
  if (!filing) throw new Error("MCA MSME-1 filing not found");
  db.prepare("UPDATE mca_msme1_filings SET srn = ?, status = 'submitted', uploaded_at = ? WHERE id = ?").run(String(srn || "").trim(), nowIso(), id);
  return getFiling(id);
}

function startUpload(id, { mcaUserId = "" } = {}) {
  const filing = getFiling(id);
  if (!filing) throw new Error("MCA MSME-1 filing not found");
  if (!filing.generatedFilePath || !fs.existsSync(filing.generatedFilePath)) throw new Error("Generated MCA MSME-1 file is missing");
  db.prepare("UPDATE mca_msme1_filings SET status = 'awaiting_user_action', mca_user_id = ? WHERE id = ?").run(String(mcaUserId || "").trim(), id);
  return {
    filing: getFiling(id),
    uploadUrl: "https://www.mca.gov.in/content/mca/global/en/mca/e-filing/company-forms-download.html",
    message: "Open MCA V3 portal, login, upload the generated MSME-1 utility, complete CAPTCHA/OTP/DSC manually, then record SRN here.",
  };
}

function downloadPath(id) {
  const filing = getFiling(id);
  if (!filing) throw new Error("MCA MSME-1 filing not found");
  if (!filing.generatedFilePath || !fs.existsSync(filing.generatedFilePath)) throw new Error("Generated MCA MSME-1 file is missing");
  return filing.generatedFilePath;
}

module.exports = {
  DEFAULT_REASON,
  TEMPLATE_PATH,
  buildPreview,
  generate,
  getFiling,
  listFilings,
  recordSrn,
  startUpload,
  downloadPath,
  halfYearRange,
};
