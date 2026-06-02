const tallyService = require("./tally.service");
const importRepository = require("../repositories/importRepository");
const vendorRepository = require("../repositories/vendorRepository");
const { enrichCreditorsWithVoucherAging } = require("./payableAging.service");
const { attachLedgerMetadata, buildStatementBundle, deriveSundryCreditors } = require("./financialStatements.service");

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

function normalizeCompactDate(value) {
  return String(value || "").replace(/-/g, "");
}

function isValidCompactDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function assertImportPeriod({ periodType = "financial_year", fiscalYear, fromDate, toDate }) {
  const normalizedFrom = normalizeCompactDate(fromDate);
  const normalizedTo = normalizeCompactDate(toDate);
  if (!isValidCompactDate(normalizedFrom) || !isValidCompactDate(normalizedTo)) {
    throw new Error("fromDate and toDate must be valid dates in YYYYMMDD format.");
  }
  if (normalizedFrom > normalizedTo) throw new Error("fromDate must be before or equal to toDate.");
  if (periodType === "custom") return { fromDate: normalizedFrom, toDate: normalizedTo };
  const expected = expectedDatesForFiscalYear(fiscalYear);
  if (!expected) throw new Error("A valid fiscalYear is required for financial year imports.");
  if (normalizedFrom !== expected.fromDate || normalizedTo !== expected.toDate) {
    throw new Error(
      `Selected financial year ${fiscalYear} requires ${expected.fromDate} to ${expected.toDate}, received ${normalizedFrom} to ${normalizedTo}.`
    );
  }
  return { fromDate: normalizedFrom, toDate: normalizedTo };
}

function creditorRowsFromDaybook({ ledgerMetadata, ledgerVouchers, asOn }) {
  const creditors = deriveSundryCreditors(ledgerMetadata, ledgerVouchers);
  return creditors.map((creditor) => ({
    party: creditor.ledgerName,
    normalizedVendorName: creditor.normalizedLedgerName,
    outstandingAmount: Math.round(Number(creditor.outstandingAmount || 0) * 100) / 100,
    openingBalance: creditor.openingBalance,
    closingBalance: creditor.closingBalance,
    openingBalanceRaw: creditor.ledgerOpeningBalanceRaw || "",
    closingBalanceRaw: creditor.ledgerClosingBalanceRaw || "",
    openingBalanceType: "",
    closingBalanceType: creditor.closingBalance < 0 ? "credit" : creditor.closingBalance > 0 ? "debit" : "zero",
    payableBalance: creditor.closingBalance < 0 || creditor.outstandingAmount > 0,
    guid: creditor.guid || "",
    gstin: creditor.gstin || "",
    panNumber: creditor.panNumber || "",
    udyamNumber: creditor.udyamNumber || "",
    detectionReasons: [
      ...(creditor.isSundryCreditor ? ["creditor_parent_or_ancestor"] : []),
      ...(creditor.hasCurrentActivity ? ["current_period_activity"] : []),
      ...(creditor.reviewReason ? [creditor.reviewReason] : []),
    ],
    groupHierarchy: creditor.groupHierarchy || [],
    parent: creditor.parent || "",
    raw: {
      name: creditor.ledgerName,
      parent: creditor.parent || "",
      groupHierarchy: creditor.groupHierarchy || [],
      reviewReason: creditor.reviewReason || "",
      asOn,
    },
    daysOutstanding: null,
    bucket: "Unknown",
    delayed: false,
    interestLiability: 0,
    disallowanceAmount: 0,
    oldestInvoiceDate: "",
  }));
}

async function importFromTally({ periodType = "financial_year", fiscalYear, fromDate, toDate, asOn, companyName, actor }) {
  const period = assertImportPeriod({ periodType, fiscalYear, fromDate, toDate });
  const selectedFiscalYear = periodType === "custom" ? (fiscalYear || "custom") : fiscalYear;
  const selectedAsOn = asOn || new Date().toISOString().split("T")[0];
  const runId = importRepository.createRun({
    fiscalYear: selectedFiscalYear,
    periodType,
    fromDate: period.fromDate,
    toDate: period.toDate,
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

    logImportStage("ledgerMetadata", { status: "start", runId });
    const ledgerMetadataResult = await tallyService.fetchLedgerMetadata({ companyName: health.companyName || companyName });
    const selectedCompanyName = ledgerMetadataResult.companyName || health.companyName;
    logImportStage("ledgerMetadata", { status: "success", runId, ledgerCount: ledgerMetadataResult.ledgers.length });

    logImportStage("daybookExport", { status: "start", runId, from: period.fromDate, to: period.toDate });
    const dayBookResult = await tallyService.fetchAllDayBookVouchers({
      from: period.fromDate,
      to: period.toDate,
      companyName: selectedCompanyName,
    });
    const ledgerVoucherRows = attachLedgerMetadata(dayBookResult.rows, ledgerMetadataResult.ledgers);
    const statements = buildStatementBundle(ledgerVoucherRows, ledgerMetadataResult.ledgers);
    const data = {
      success: true,
      asOn: selectedAsOn,
      period,
      companyName: selectedCompanyName,
      companyNames: ledgerMetadataResult.companyNames,
      companyDetectionMethod: ledgerMetadataResult.companyDetectionMethod,
      summary: {
        totalCreditors: statements.sundryCreditors.length,
        totalOutstanding: Math.round(statements.sundryCreditors.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0) * 100) / 100,
        tallySource: "full_daybook",
        creditorDiagnostics: {
          totalLedgersExported: ledgerMetadataResult.ledgers.length,
          detectedCreditorCount: statements.sundryCreditors.length,
          zeroDebitCreditorsWithActivity: statements.summary.zeroDebitCreditorsWithActivity,
        },
        warnings: dayBookResult.warnings,
      },
      creditors: creditorRowsFromDaybook({
        ledgerMetadata: ledgerMetadataResult.ledgers,
        ledgerVouchers: ledgerVoucherRows,
        asOn: selectedAsOn,
      }),
    };
    logImportStage("companyDetect", {
      status: "ledger_metadata_selected",
      runId,
      companyDetected: true,
      companyName: selectedCompanyName,
      fallbackMethodUsed: data.companyDetectionMethod || health.companyDetectionMethod,
    });
    logImportStage("creditorsExport", { status: "derived", runId, count: data.creditors.length });

    const ledgerVoucherResult = {
      rows: ledgerVoucherRows,
      warnings: dayBookResult.warnings,
      voucherSource: dayBookResult.voucherSource,
      fallbackUsed: dayBookResult.fallbackUsed,
    };
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
        selectedFinancialYear: selectedFiscalYear,
        fiscalYear: selectedFiscalYear,
        periodType,
        fromDate: period.fromDate,
        toDate: period.toDate,
        asOn: selectedAsOn,
        companyName: selectedCompanyName,
        voucherSource: ledgerVoucherResult.voucherSource,
        fallbackUsed: ledgerVoucherResult.fallbackUsed,
        creditorsImported: data.creditors.length,
        vouchersParsed: ledgerVoucherResult.rows.length,
        ledgerVouchersFetched: ledgerVoucherResult.rows.length,
        ledgerVoucherWarnings: ledgerVoucherResult.warnings.length,
        ledgerVoucherWarningDetails: ledgerVoucherResult.warnings,
        statementSummary: statements.summary,
        diagnostics: {
          totalDaybookRows: ledgerVoucherResult.rows.length,
          detectedSundryCreditors: data.creditors.length,
          zeroDebitCreditorsWithActivity: statements.summary.zeroDebitCreditorsWithActivity,
          failedOrTruncatedBatches: ledgerVoucherResult.warnings.length,
        },
        ledgerMetadata: ledgerMetadataResult.ledgers,
      },
      creditors: agedCreditors,
      ledgerVouchers: ledgerVoucherResult.rows,
    });
    const persistedCreditors = importRepository.getCreditors(runId);
    const ignoredNonSundry = importRepository.getIgnoredNonSundryCreditors(runId);
    const seedSummary = vendorRepository.seedFromImport(runId, persistedCreditors, actor || "unknown");
    const ledgerVoucherDiagnostics = importRepository.getLedgerVoucherDiagnostics(runId);
    const creditorVisibleVoucherCount = importRepository.getLedgerVouchers(runId, { limit: 1 }).total;
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
    const ignoredNonSundrySamples = ignoredNonSundry.slice(0, 10).map((row) => row.party);
    return {
      success: true,
      importRun: {
        ...run,
        summary: {
          ...(run.summary || {}),
          ignoredNonSundryCount: ignoredNonSundry.length,
          ignoredNonSundrySamples,
        },
      },
      creditors,
      ledgerVoucherSummary: {
        totalRows: creditorVisibleVoucherCount,
        totalLedgers: data.creditors.length,
        failedLedgers: ledgerVoucherResult.warnings.length,
        persistedRows: creditorVisibleVoucherCount,
        voucherSource: ledgerVoucherResult.voucherSource,
        fallbackUsed: ledgerVoucherResult.fallbackUsed,
        totalDaybookRows: ledgerVoucherDiagnostics.persistedVoucherCount,
      },
      ledgerVoucherDiagnostics,
      seedSummary,
      warnings: ledgerVoucherResult.warnings,
      ignoredNonSundryCount: ignoredNonSundry.length,
      ignoredNonSundrySamples,
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
  const ignoredNonSundry = importRepository.getIgnoredNonSundryCreditors(id);
  return {
    importRun: {
      ...run,
      summary: {
        ...(run.summary || {}),
        ignoredNonSundryCount: ignoredNonSundry.length,
        ignoredNonSundrySamples: ignoredNonSundry.slice(0, 10).map((row) => row.party),
      },
    },
    creditors,
    verificationSummary: buildVerificationSummary(creditors),
  };
}

function seedVendorMasterFromImport(importRunId, actor = "unknown") {
  const run = importRepository.getRun(importRunId);
  if (!run) throw new Error("Import run not found");
  if (run.status !== "completed") throw new Error("Import run is not completed");
  return vendorRepository.seedFromImport(importRunId, importRepository.getCreditors(importRunId), actor);
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

function getDaybook(importRunId, filters = {}) {
  const run = importRepository.getRun(importRunId);
  if (!run) return null;
  return {
    importRun: run,
    daybook: importRepository.getDaybookVouchers(importRunId, filters),
  };
}

function ledgerMetadataForRun(run) {
  return Array.isArray(run?.summary?.ledgerMetadata) ? run.summary.ledgerMetadata : [];
}

function getStatement(importRunId, type) {
  const run = importRepository.getRun(importRunId);
  if (!run) return null;
  const rows = importRepository.getAllDaybookVouchers(importRunId);
  const metadata = ledgerMetadataForRun(run);
  const bundle = buildStatementBundle(rows, metadata);
  const statement = type === "trial-balance"
    ? bundle.trialBalance
    : type === "balance-sheet"
      ? bundle.balanceSheet
      : type === "profit-loss"
        ? bundle.profitLoss
        : null;
  return statement ? { importRun: run, statement } : null;
}

module.exports = {
  importFromTally,
  getImportRun,
  getLedgerVouchers,
  getDaybook,
  getStatement,
  seedVendorMasterFromImport,
  buildVerificationSummary,
  enrichCreditors,
  expectedDatesForFiscalYear,
  assertImportPeriod,
};
