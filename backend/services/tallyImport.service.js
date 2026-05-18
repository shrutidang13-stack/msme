const tallyService = require("./tally.service");
const importRepository = require("../repositories/importRepository");
const vendorRepository = require("../repositories/vendorRepository");
const { enrichCreditorsWithVoucherAging } = require("./payableAging.service");

function buildVerificationSummary(creditors) {
  const total = creditors.length;
  const verifiedMSME = creditors.filter((row) =>
    row.vendorMaster?.isMSME &&
    ["verified", "approved"].includes(row.vendorMaster?.udyamStatus)
  ).length;
  const nonMSME = creditors.filter((row) => row.vendorMaster?.verificationStatus === "not_msme").length;
  const failed = creditors.filter((row) =>
    ["failed", "manual_fallback_required", "pending_manual_review", "rejected"].includes(row.vendorMaster?.udyamStatus)
  ).length;
  const pendingVerification = total - verifiedMSME - nonMSME - failed;
  return { total, verifiedMSME, pendingVerification, nonMSME, failedVerification: failed };
}

function enrichCreditors(creditors) {
  const master = vendorRepository.findManyByNames(creditors.map((creditor) => creditor.party));
  const masterByNormalized = new Map(master.map((vendor) => [vendor.normalizedVendorName, vendor]));
  return creditors.map((creditor) => ({
    ...creditor,
    vendorMaster: masterByNormalized.get(creditor.normalizedVendorName) || null,
  }));
}

function logImportStage(stage, details = {}) {
  console.log(`[tally-import] stage=${stage} ${JSON.stringify(details)}`);
}

function healthFailureMessage(health) {
  if (health.reachable === false) return health.error || health.message || "TallyPrime is not open or port 9000 is unreachable";
  if (health.portOpen === false) return "TallyPrime is not open or port 9000 is unreachable";
  if (health.serverRunning === false) return health.error || health.message || "Tally server is not running";
  if (health.xmlPostWorking === false) return "Tally server is reachable, but XML export request failed.";
  return null;
}

function expectedDatesForFiscalYear(fiscalYear) {
  const match = String(fiscalYear || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const startYear = Number(match[1]);
  return {
    fromDate: `${startYear}0401`,
    toDate: `${startYear + 1}0331`,
  };
}

function assertFiscalYearDates({ fiscalYear, fromDate, toDate }) {
  const expected = expectedDatesForFiscalYear(fiscalYear);
  if (!expected) return;
  if (fromDate !== expected.fromDate || toDate !== expected.toDate) {
    throw new Error(
      `Selected financial year ${fiscalYear} requires ${expected.fromDate} to ${expected.toDate}, received ${fromDate} to ${toDate}.`
    );
  }
}

async function importFromTally({ fiscalYear, fromDate, toDate, asOn, companyName, actor }) {
  assertFiscalYearDates({ fiscalYear, fromDate, toDate });
  const selectedAsOn = asOn || new Date().toISOString().split("T")[0];
  const runId = importRepository.createRun({
    fiscalYear,
    fromDate,
    toDate,
    asOn: selectedAsOn,
    status: "running",
    actor,
  });

  try {
    logImportStage("ping", { status: "preflight_start", runId });
    const health = await tallyService.tallyHealth({ companyName });
    logImportStage("ping", {
      status: "preflight_result",
      runId,
      reachable: health.reachable,
      portOpen: health.portOpen,
      serverRunning: health.serverRunning,
      xmlPostWorking: health.xmlPostWorking,
      companyDetected: health.companyDetected,
      message: health.message,
      error: health.error,
    });
    const preflightError = healthFailureMessage(health);
    if (preflightError) throw new Error(preflightError);

    logImportStage("creditorsExport", { status: "start", runId });
    const data = await tallyService.fetchCreditors({ from: fromDate, to: toDate, asOn, companyName: health.companyName || companyName });
    const selectedCompanyName = data.companyName || health.companyName;
    logImportStage("companyDetect", {
      status: "creditor_export_fallback",
      runId,
      companyDetected: true,
      companyName: selectedCompanyName,
      fallbackMethodUsed: data.companyDetectionMethod || health.companyDetectionMethod,
    });
    logImportStage("creditorsExport", { status: "success", runId, count: data.creditors.length });

    logImportStage("vouchersExport", { status: "start", runId, creditorCount: data.creditors.length });
    const ledgerVoucherResult = await tallyService.fetchAllCreditorLedgerVouchers({
      creditors: data.creditors,
      from: fromDate,
      to: toDate,
      companyName: selectedCompanyName,
    });
    logImportStage("vouchersExport", {
      status: "success",
      runId,
      exportedVoucherCount: ledgerVoucherResult.rows.length,
      parsedVoucherCount: ledgerVoucherResult.rows.length,
      importRunId: runId,
      rows: ledgerVoucherResult.rows.length,
      warnings: ledgerVoucherResult.warnings.length,
      voucherSource: ledgerVoucherResult.voucherSource,
      fallbackUsed: ledgerVoucherResult.fallbackUsed,
    });

    const agedCreditors = enrichCreditorsWithVoucherAging(data.creditors, ledgerVoucherResult.rows, selectedAsOn);
    logImportStage("persistImport", { status: "start", runId });
    importRepository.completeRun(runId, {
      summary: {
        ...data.summary,
        selectedFinancialYear: fiscalYear,
        fiscalYear,
        companyName: selectedCompanyName,
        voucherSource: ledgerVoucherResult.voucherSource,
        fallbackUsed: ledgerVoucherResult.fallbackUsed,
        creditorsImported: data.creditors.length,
        vouchersParsed: ledgerVoucherResult.rows.length,
        ledgerVouchersFetched: ledgerVoucherResult.rows.length,
        ledgerVoucherWarnings: ledgerVoucherResult.warnings.length,
        ledgerVoucherWarningDetails: ledgerVoucherResult.warnings,
      },
      creditors: agedCreditors,
      ledgerVouchers: ledgerVoucherResult.rows,
    });
    const ledgerVoucherDiagnostics = importRepository.getLedgerVoucherDiagnostics(runId);
    logImportStage("dbDiagnostics", {
      importRunId: runId,
      voucherCountAfterImport: ledgerVoucherDiagnostics.persistedVoucherCount,
      sampleVoucher: ledgerVoucherDiagnostics.sampleVoucher ? {
        ledgerName: ledgerVoucherDiagnostics.sampleVoucher.ledgerName,
        date: ledgerVoucherDiagnostics.sampleVoucher.date,
        voucherType: ledgerVoucherDiagnostics.sampleVoucher.voucherType,
        voucherNumber: ledgerVoucherDiagnostics.sampleVoucher.voucherNumber,
        billReference: ledgerVoucherDiagnostics.sampleVoucher.billReference,
        amount: ledgerVoucherDiagnostics.sampleVoucher.amount,
      } : null,
    });
    logImportStage("persistImport", { status: "success", runId, persistedVoucherCount: ledgerVoucherDiagnostics.persistedVoucherCount });
    const run = importRepository.getRun(runId);
    const creditors = enrichCreditors(importRepository.getCreditors(runId));
    return {
      success: true,
      importRun: run,
      creditors,
      ledgerVoucherSummary: {
        totalRows: ledgerVoucherResult.rows.length,
        totalLedgers: data.creditors.length,
        failedLedgers: ledgerVoucherResult.warnings.length,
        persistedRows: ledgerVoucherDiagnostics.persistedVoucherCount,
        voucherSource: ledgerVoucherResult.voucherSource,
        fallbackUsed: ledgerVoucherResult.fallbackUsed,
      },
      ledgerVoucherDiagnostics,
      warnings: ledgerVoucherResult.warnings,
      verificationSummary: buildVerificationSummary(creditors),
    };
  } catch (error) {
    logImportStage("persistImport", { status: "failed", runId, error: error.message });
    importRepository.failRun(runId, error);
    throw error;
  }
}

function getImportRun(id) {
  const run = importRepository.getRun(id);
  if (!run) return null;
  const creditors = enrichCreditors(importRepository.getCreditors(id));
  return {
    importRun: run,
    creditors,
    verificationSummary: buildVerificationSummary(creditors),
  };
}

function getLedgerVouchers(importRunId, filters = {}) {
  const run = importRepository.getRun(importRunId);
  if (!run) return null;
  if (filters.fiscalYear && filters.fiscalYear !== run.fiscalYear) {
    throw new Error(`Import run fiscal year mismatch. Requested ${filters.fiscalYear}, but run belongs to ${run.fiscalYear}.`);
  }
  logImportStage("voucherQuery", { status: "start", importRunId, fiscalYear: run.fiscalYear });
  return {
    importRun: run,
    ledgerVouchers: importRepository.getLedgerVouchers(importRunId, filters),
  };
}

module.exports = { importFromTally, getImportRun, getLedgerVouchers, buildVerificationSummary, enrichCreditors, expectedDatesForFiscalYear };
