const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer");
const importRepository = require("../repositories/importRepository");
const reportRepository = require("../repositories/reportRepository");
const vendorRepository = require("../repositories/vendorRepository");
const { buildVerificationSummary, enrichCreditors } = require("./tallyImport.service");
const {
  evaluateVendor,
  loadRulePack,
  getConfiguredBankRatePercent,
  getDefaultAnnualInterestRate,
  taxBasisForFiscalYear,
} = require("./msmeRuleEngine.service");
const { enrichCreditorsWithVoucherAging } = require("./payableAging.service");
const { validateUdyamNumber } = require("./udyamVerifier.service");
const carryForwardService = require("./carryForward.service");
const { isSundryCreditorRow } = require("../utils/sundryCreditor");
const { fiscalYearDates, displayDate, normalizeCompactDate } = require("../utils/financialYear");

const LEGAL_SOURCE_MANIFEST_PATH = path.resolve(process.cwd(), "docs/legal/rule-source-manifest.json");

function loadLegalSourceManifest() {
  return JSON.parse(fs.readFileSync(LEGAL_SOURCE_MANIFEST_PATH, "utf8"));
}

function isReportableMSME(vendor) {
  return Boolean(
    vendor.vendorMaster?.isMSME &&
    ["verified", "approved"].includes(vendor.vendorMaster?.udyamStatus) &&
    validateUdyamNumber(vendor.vendorMaster?.udyamNumber)
  );
}

function isZeroActivity(vendor) {
  return Math.abs(Number(vendor.outstandingAmount || 0)) === 0 && Number(vendor.voucherCount || 0) === 0;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizedNameOf(row) {
  return row.normalizedVendorName || row.normalizedLedgerName || "";
}

function buildScopedLedgerCreditors(baseCreditors = [], vouchers = [], run, selectedFinancialYear, scope) {
  const periods = Array.isArray(run.summary?.financialYearPeriods) && run.summary.financialYearPeriods.length
    ? run.summary.financialYearPeriods
    : [{
      financialYear: run.fiscalYear,
      fyStartDate: run.fromDate,
      fyEndDate: run.toDate,
      reportFromDate: run.fromDate,
      reportToDate: run.toDate,
      asOnDate: run.asOn,
      cappedByAsOn: Boolean(run.summary?.cappedByAsOn),
    }];
  const wanted = selectedFinancialYear === "all"
    ? periods
    : periods.filter((period) => period.financialYear === selectedFinancialYear || selectedFinancialYear === run.fiscalYear);
  const movementByPeriodVendor = new Map();
  for (const row of vouchers) {
    const fy = row.financialYear || row.fiscalYear || selectedFinancialYear || run.fiscalYear;
    const normalized = normalizedNameOf(row);
    if (!normalized) continue;
    const key = `${fy}|${normalized}`;
    if (!movementByPeriodVendor.has(key)) movementByPeriodVendor.set(key, { debit: 0, credit: 0, voucherCount: 0 });
    const movement = movementByPeriodVendor.get(key);
    movement.debit = roundMoney(movement.debit + Number(row.debit || 0));
    movement.credit = roundMoney(movement.credit + Number(row.credit || 0));
    movement.voucherCount += 1;
  }

  const currentOpeningByVendor = new Map(baseCreditors.map((creditor) => [
    creditor.normalizedVendorName,
    Number(creditor.openingBalance || 0),
  ]));
  const snapshots = [];
  for (const period of periods) {
    const includePeriod = wanted.some((item) => item.financialYear === period.financialYear);
    for (const creditor of baseCreditors) {
      const normalized = creditor.normalizedVendorName;
      const openingBalance = currentOpeningByVendor.get(normalized) ?? Number(creditor.openingBalance || 0);
      const movement = movementByPeriodVendor.get(`${period.financialYear}|${normalized}`) || { debit: 0, credit: 0, voucherCount: 0 };
      const derivedClosing = roundMoney(openingBalance + movement.debit - movement.credit);
      const hasLedgerBalanceDetail = Boolean(
        creditor.openingBalanceRaw ||
        creditor.closingBalanceRaw ||
        Number(creditor.openingBalance || 0) ||
        Number(creditor.closingBalance || 0)
      );
      const singleFyStoredOutstanding = run.fiscalYear !== "custom" && !hasLedgerBalanceDetail
        ? Number(creditor.ledgerOutstandingAmount ?? creditor.outstandingAmount ?? 0)
        : null;
      const ledgerOutstanding = singleFyStoredOutstanding == null
        ? (derivedClosing < 0 ? Math.abs(derivedClosing) : 0)
        : Math.max(singleFyStoredOutstanding, 0);
      if (includePeriod) {
        snapshots.push({
          ...creditor,
          financialYear: period.financialYear,
          reportFromDate: period.reportFromDate,
          reportToDate: period.reportToDate,
          asOnDate: period.asOnDate || scope.asOnDate || run.asOn,
          cappedByAsOn: Boolean(period.cappedByAsOn),
          openingBalance,
          closingBalance: singleFyStoredOutstanding == null ? derivedClosing : -ledgerOutstanding,
          openingBalanceRaw: creditor.openingBalanceRaw || "",
          closingBalanceRaw: "",
          fyDebit: roundMoney(movement.debit),
          fyCredit: roundMoney(movement.credit),
          voucherCount: movement.voucherCount,
          outstandingAmount: ledgerOutstanding,
          ledgerOutstandingAmount: ledgerOutstanding,
          openingBaselineDate: "2025-03-31",
          openingBaselineAmount: Number(creditor.openingBalance || 0) < 0 ? Math.abs(Number(creditor.openingBalance || 0)) : 0,
          openingAsOnDate: "2025-04-01",
        });
      }
      currentOpeningByVendor.set(normalized, derivedClosing);
    }
  }
  return snapshots.filter((creditor) =>
    selectedFinancialYear === "all" ||
    Number(creditor.voucherCount || 0) > 0 ||
    Math.abs(Number(creditor.outstandingAmount || 0)) > 0
  );
}

function calculateReportRows(creditors, options = {}) {
  const rulePack = loadRulePack();
  const evaluationOptions = {
    rulePack,
    fiscalYear: options.fiscalYear,
    bankRatePercent: options.bankRatePercent,
    annualInterestRate: options.annualInterestRate,
  };
  return creditors
    .filter(isSundryCreditorRow)
    .filter((vendor) => {
      return isReportableMSME(vendor) && evaluateVendor(vendor, evaluationOptions).eligible;
    })
    .map((vendor) => {
      const ruleResult = evaluateVendor(vendor, evaluationOptions);
      const invoiceLines = vendor.payableAging?.allInvoices || [];
      const unpaidDelayedInvoices = invoiceLines.filter((invoice) => invoice.unpaidDelayed);
      const paidLateInvoices = invoiceLines.filter((invoice) => invoice.paidLate);
      const interestLines = invoiceLines.filter((invoice) => invoice.overdue).map((invoice) => ({
        vendorName: vendor.party,
        financialYear: vendor.financialYear || options.fiscalYear || "",
        invoiceNumber: invoice.invoiceNumber || invoice.voucherNumber || invoice.billReference || "",
        invoiceDate: invoice.invoiceDate || invoice.date || "",
        acceptanceDate: invoice.acceptanceDate || invoice.invoiceDate || invoice.date || "",
        appointedDay: invoice.appointedDay || invoice.dueDate || "",
        dueDate: invoice.dueDate || invoice.appointedDay || "",
        agreedPaymentDays: invoice.agreedPaymentDays || vendor.agreedPaymentDays || vendor.vendorMaster?.agreedPaymentDays || 0,
        allowedPaymentDays: invoice.allowedPaymentDays || ruleResult.allowedPaymentDays,
        principal: Number(invoice.principalAmount || invoice.originalAmount || invoice.pendingAmount || 0),
        unpaidAmount: Number(invoice.pendingAmount || 0),
        paidLateAmount: Number(invoice.paidLateAmount || 0),
        paymentDate: invoice.paymentDate || "",
        daysDelayed: invoice.delayDays || 0,
        rbiBankRate: invoice.bankRatePercent ?? ruleResult.bankRatePercent,
        interestAmount: Number(invoice.interest || 0),
        evidenceReference: invoice.evidenceReference || invoice.voucherId || invoice.voucherNumber || "",
        status: invoice.status || "",
      }));
      const invoiceInterest = roundMoney(interestLines.reduce((sum, row) => sum + Number(row.interestAmount || 0), 0));
      const invoiceDisallowance = roundMoney(unpaidDelayedInvoices.reduce((sum, row) => sum + Number(row.exposure43Bh || 0), 0));
      return {
        vendorName: vendor.party,
        normalizedVendorName: vendor.normalizedVendorName,
        vendorMaster: vendor.vendorMaster,
        financialYear: vendor.financialYear || options.fiscalYear || "",
        reportFromDate: vendor.reportFromDate || "",
        reportToDate: vendor.reportToDate || "",
        asOnDate: vendor.asOnDate || "",
        cappedByAsOn: Boolean(vendor.cappedByAsOn),
        udyamNumber: vendor.vendorMaster.udyamNumber,
        enterpriseName: vendor.vendorMaster.enterpriseName,
        enterpriseType: vendor.vendorMaster.enterpriseType,
        panNumber: vendor.panNumber || vendor.vendorMaster?.panNumber || "",
        outstandingAmount: Number(vendor.outstandingAmount ?? vendor.ledgerOutstandingAmount ?? 0),
        ledgerOutstandingAmount: Number(vendor.ledgerOutstandingAmount ?? vendor.outstandingAmount ?? 0),
        voucherOutstandingAmount: Number(vendor.voucherOutstandingAmount || 0),
        outstandingMismatch: Boolean(vendor.outstandingMismatch),
        mismatchReason: vendor.mismatchReason || "",
        openingBalance: vendor.openingBalance || 0,
        closingBalance: vendor.closingBalance || 0,
        openingBalanceRaw: vendor.openingBalanceRaw || "",
        closingBalanceRaw: vendor.closingBalanceRaw || "",
        daysOutstanding: vendor.daysOutstanding,
        allowedPaymentDays: ruleResult.allowedPaymentDays,
        delayDays: ruleResult.delayDays,
        bucket: vendor.bucket,
        oldestInvoiceDate: vendor.oldestInvoiceDate,
        isDelayed: ruleResult.isDelayed,
        disallowed: ruleResult.disallowed,
        interest: invoiceInterest || ruleResult.interest,
        invoiceAging: invoiceLines,
        unpaidDelayedInvoices,
        paidLateInvoices,
        interestLines,
        principalDisallowance43Bh: ruleResult.disallowed,
        interestDisallowanceSection23: invoiceInterest || ruleResult.interest,
        interestRate: ruleResult.interestRate,
        bankRatePercent: ruleResult.bankRatePercent,
        annualInterestRatePercent: ruleResult.annualInterestRatePercent,
        interestRateSource: ruleResult.interestRateSource,
        agreedPaymentDays: vendor.agreedPaymentDays || vendor.vendorMaster?.agreedPaymentDays || ruleResult.allowedPaymentDays,
        applicableAct: ruleResult.applicableAct,
        applicableSection: ruleResult.applicableSection,
        actualPaymentRuleId: ruleResult.actualPaymentRuleId,
        taxImpact: ruleResult.taxImpact,
        appliedRules: ruleResult.appliedRules,
        findings: ruleResult.findings,
        legalBasis: ruleResult.legalBasis,
        openingBaselineDate: vendor.openingBaselineDate || "",
        openingBaselineAmount: vendor.openingBaselineAmount || 0,
        openingAsOnDate: vendor.openingAsOnDate || "",
        fyDebit: vendor.fyDebit || 0,
        fyCredit: vendor.fyCredit || 0,
      };
    });
}

function exclusionReason(vendor) {
  const master = vendor.vendorMaster;
  if (isZeroActivity(vendor)) return "no_current_activity";
  if (!master) return "missing_udyam";
  if (master.actionStatus === "not_required_zero_outstanding" || master.verificationStatus === "not_required_zero_outstanding") return "not_required_zero_outstanding";
  if (master.verificationStatus === "not_msme") return "non_msme";
  if (master.udyamStatus === "manual_fallback_required") return "manual_review_required";
  if (master.udyamStatus === "pending_manual_review") return "proof_pending_review";
  if (master.udyamStatus === "rejected" || master.reviewStatus === "rejected") return "manual_rejected";
  if (!master.udyamNumber) return "missing_udyam";
  if (!["verified", "approved"].includes(master.udyamStatus)) return "not_verified";
  if (!master.isMSME) return "non_msme";
  if (!validateUdyamNumber(master.udyamNumber)) return "invalid_udyam";
  return "";
}

function calculateExcludedRows(creditors) {
  return creditors
    .filter(isSundryCreditorRow)
    .map((vendor) => ({ vendor, reason: exclusionReason(vendor) }))
    .filter((row) => row.reason)
    .map(({ vendor, reason }) => ({
      vendorName: vendor.party,
      normalizedVendorName: vendor.normalizedVendorName,
      udyamNumber: vendor.vendorMaster?.udyamNumber || "",
      udyamStatus: vendor.vendorMaster?.udyamStatus || "not_started",
      panNumber: vendor.panNumber || vendor.vendorMaster?.panNumber || "",
      agreedPaymentDays: vendor.agreedPaymentDays || vendor.vendorMaster?.agreedPaymentDays || 0,
      financialYear: vendor.financialYear || "",
      actionStatus: vendor.vendorMaster?.actionStatus || "pending_action",
      reviewStatus: vendor.vendorMaster?.reviewStatus || "queued",
      outstandingAmount: vendor.outstandingAmount,
      ledgerOutstandingAmount: Number(vendor.ledgerOutstandingAmount ?? vendor.outstandingAmount ?? 0),
      voucherOutstandingAmount: Number(vendor.voucherOutstandingAmount || 0),
      outstandingMismatch: Boolean(vendor.outstandingMismatch),
      mismatchReason: vendor.mismatchReason || "",
      daysOutstanding: vendor.daysOutstanding,
      voucherCount: vendor.voucherCount || 0,
      reason,
      excludedReason: reason,
    }));
}

function requestedReportFinancialYear(run, fiscalYear) {
  const requested = String(fiscalYear || run.fiscalYear || "").trim();
  if (!requested || requested === "custom") return run.fiscalYear === "custom" ? "all" : run.fiscalYear;
  return requested;
}

function assertReportFinancialYear(run, requested) {
  if (!requested || requested === "all") return;
  const available = run.summary?.financialYears || [];
  if (run.fiscalYear !== "custom" && requested !== run.fiscalYear) {
    throw new Error(`Import run fiscal year mismatch. Requested ${requested}, but run belongs to ${run.fiscalYear}.`);
  }
  if (run.fiscalYear === "custom" && available.length && !available.includes(requested)) {
    throw new Error(`Import run does not contain financial year ${requested}.`);
  }
}

function periodScopeForReport(run, selectedFinancialYear) {
  if (selectedFinancialYear && selectedFinancialYear !== "all") {
    const period = (run.summary?.financialYearPeriods || []).find((item) => item.financialYear === selectedFinancialYear);
    const fyDates = fiscalYearDates(selectedFinancialYear) || {};
    return {
      reportFromDate: period?.reportFromDate || fyDates.fyStartDate || run.fromDate,
      reportToDate: period?.reportToDate || fyDates.fyEndDate || run.toDate,
      asOnDate: period?.asOnDate || run.asOn,
      cappedByAsOn: Boolean(period?.cappedByAsOn),
    };
  }
  return {
    reportFromDate: run.fromDate,
    reportToDate: run.toDate,
    asOnDate: run.asOn,
    cappedByAsOn: Boolean(run.summary?.cappedByAsOn),
  };
}

function capScopeByAsOn(scope, asOnDate) {
  const asOn = normalizeCompactDate(asOnDate);
  if (!asOn) return scope;
  const currentTo = normalizeCompactDate(scope.reportToDate);
  if (currentTo && asOn < currentTo) {
    return { ...scope, reportToDate: asOn, asOnDate: asOnDate, cappedByAsOn: true };
  }
  return { ...scope, asOnDate: asOnDate || scope.asOnDate };
}

function buildFinancialYearSummary(creditors) {
  const groups = new Map();
  for (const creditor of creditors) {
    const fy = creditor.financialYear || "Unassigned";
    if (!groups.has(fy)) groups.set(fy, { financialYear: fy, totalVendors: 0, msmeVendors: 0, totalPayable: 0, delayedAmount: 0, interest: 0, disallowance: 0 });
    const group = groups.get(fy);
    group.totalVendors += 1;
    if (isReportableMSME(creditor)) group.msmeVendors += 1;
    group.totalPayable += Number(creditor.outstandingAmount || 0);
    if (creditor.delayed) group.delayedAmount += Number(creditor.outstandingAmount || 0);
    group.disallowance += Number(creditor.disallowanceAmount || 0);
    group.interest += Number(creditor.interestLiability || 0);
  }
  return [...groups.values()].map((row) => ({
    ...row,
    totalPayable: Math.round(row.totalPayable * 100) / 100,
    delayedAmount: Math.round(row.delayedAmount * 100) / 100,
    interest: Math.round(row.interest * 100) / 100,
    disallowance: Math.round(row.disallowance * 100) / 100,
  })).sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}

function buildBaselineValidation(creditors = [], run, selectedFinancialYear) {
  const baselineRows = importRepository.getBaselineSnapshot(run.id, "2025-03-31");
  const baselineByVendor = new Map(baselineRows.map((row) => [row.normalizedVendorName, row]));
  const byVendor = new Map();
  for (const row of creditors) {
    const normalized = row.normalizedVendorName || row.party;
    if (!normalized) continue;
    if (!byVendor.has(normalized)) byVendor.set(normalized, []);
    byVendor.get(normalized).push(row);
  }
  for (const rows of byVendor.values()) rows.sort((a, b) => String(a.financialYear || "").localeCompare(String(b.financialYear || "")));
  return creditors.map((row) => {
    const vendorRows = byVendor.get(row.normalizedVendorName || row.party) || [];
    const currentIndex = vendorRows.indexOf(row);
    const previous = currentIndex > 0 ? vendorRows[currentIndex - 1] : null;
    const baseline = baselineByVendor.get(row.normalizedVendorName || row.party);
    const openingBalance = Number(row.openingBalance || 0);
    const priorClosingBalance = previous
      ? Number(previous.closingBalance || 0)
      : baseline
        ? Number(baseline.closingBalance || 0)
        : null;
    const hasBaseline = baseline || previous;
    const difference = priorClosingBalance == null ? null : roundMoney(openingBalance - priorClosingBalance);
    const status = !hasBaseline
      ? "unavailable"
      : difference == null || Math.abs(difference) < 0.01
        ? "matched"
        : "mismatch";
    return {
      financialYear: row.financialYear || selectedFinancialYear || run.fiscalYear,
      vendorName: row.party,
      normalizedVendorName: row.normalizedVendorName,
      baselineDate: "2025-03-31",
      openingAsOnDate: "2025-04-01",
      openingBalance,
      priorClosingBalance,
      difference,
      status,
      warning: status === "unavailable"
        ? "Prior FY closing snapshot is unavailable; report uses ledger opening balance."
        : status === "mismatch"
          ? "Opening balance does not match available prior FY closing snapshot."
          : "",
    };
  });
}

function buildReportSchedules({ report, excluded, creditors, summary }) {
  const baselineValidation = summary.baselineValidation || [];
  const baselineByVendorFy = new Map(baselineValidation.map((row) => [`${row.financialYear}|${row.normalizedVendorName}`, row]));
  const verifiedByVendor = new Map(report.map((row) => [row.vendorName, row]));
  const invoiceAging = report.flatMap((row) => (row.invoiceAging || []).map((invoice) => {
    const verificationFlags = Array.isArray(invoice.verificationFlags) ? invoice.verificationFlags : [];
    return {
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      panNumber: row.panNumber || "",
      udyamNumber: row.udyamNumber || "",
      invoiceNumber: invoice.invoiceNumber || invoice.voucherNumber || invoice.billReference || "",
      invoiceDate: invoice.invoiceDate || invoice.date || "",
      acceptanceDate: invoice.acceptanceDate || "",
      deemedAcceptanceDate: invoice.deemedAcceptanceDate || "",
      dateSource: invoice.baseDateSource || invoice.acceptanceDateSource || "",
      hasWrittenAgreement: Boolean(invoice.hasWrittenAgreement),
      agreementDays: Number(invoice.agreedPaymentDays || 0),
      agreedPaymentDays: Number(invoice.agreedPaymentDays || 0),
      allowedPaymentDays: Number(invoice.allowedPaymentDays || row.allowedPaymentDays || 0),
      appointedDay: invoice.appointedDay || invoice.dueDate || "",
      interestStartDate: invoice.interestStartDate || "",
      paymentDate: invoice.paymentDate || "",
      principalAmount: roundMoney(invoice.principalAmount || invoice.originalAmount || invoice.paidLateAmount || invoice.pendingAmount || 0),
      unpaidAmount: roundMoney(invoice.pendingAmount || 0),
      paidLateAmount: roundMoney(invoice.paidLateAmount || 0),
      unpaidDelayedAmount: roundMoney(invoice.exposure43Bh || 0),
      daysDelayed: Number(invoice.delayDays || 0),
      rbiBankRate: invoice.bankRatePercent ?? row.bankRatePercent ?? summary.bankRatePercent,
      interestAmount: roundMoney(invoice.interest || 0),
      evidenceReference: invoice.evidenceReference || invoice.voucherId || invoice.voucherNumber || "",
      verificationRequired: Boolean(invoice.verificationRequired || verificationFlags.length),
      verificationFlags: verificationFlags.join(" | "),
      status: invoice.status || "",
      paidLate: Boolean(invoice.paidLate),
      unpaidDelayed: Boolean(invoice.unpaidDelayed),
    };
  }));
  const interestCalculation = report.flatMap((row) => row.interestLines || []).map((row) => ({
    ...row,
    interestAmount: roundMoney(row.interestAmount || 0),
  }));
  const msmedSection16Interest = interestCalculation
    .filter((row) => Number(row.interestAmount || 0) > 0)
    .map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      invoiceNumber: row.invoiceNumber,
      delayedAmount: roundMoney(row.unpaidAmount || row.paidLateAmount || row.principal || 0),
      daysDelayed: row.daysDelayed,
      interestAmount: roundMoney(row.interestAmount),
      rbiBankRate: row.rbiBankRate || summary.bankRatePercent,
      interestPayable: roundMoney(row.interestAmount),
      interestPaid: 0,
    }));
  const msmedSection23PermanentDisallowance = msmedSection16Interest.map((row) => ({
    financialYear: row.financialYear,
    vendorName: row.vendorName,
    invoiceNumber: row.invoiceNumber,
    interestAccrued: row.interestAmount,
    interestPaid: 0,
    interestPayable: row.interestAmount,
    permanentlyDisallowedAmount: row.interestAmount,
    interestAmountPermanentlyDisallowed: row.interestAmount,
    reason: "Interest payable or paid under MSMED Act Section 16 is permanently disallowed under MSMED Act Section 23.",
  }));
  const disallowance43Bh = invoiceAging
    .filter((row) => row.unpaidDelayedAmount > 0)
    .map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      panNumber: row.panNumber,
      udyamNumber: row.udyamNumber,
      invoiceNumber: row.invoiceNumber,
      basis: summary.applicableSection || "Section 43B(h)",
      principalDisallowance: row.unpaidDelayedAmount,
      principalAmount: row.principalAmount,
      daysDelayed: row.daysDelayed,
      paymentStatus: "unpaid_delayed",
      allowedInYear: "Year of actual payment",
      evidenceReference: row.evidenceReference,
      remarks: "Delayed MSME principal unpaid at reporting date.",
    }));
  const clause22 = msmedSection16Interest.map((row) => ({
    financialYear: row.financialYear,
    supplier: row.vendorName,
    vendorName: row.vendorName,
    panNumber: verifiedByVendor.get(row.vendorName)?.panNumber || "",
    udyamNumber: verifiedByVendor.get(row.vendorName)?.udyamNumber || "",
    invoiceNumber: row.invoiceNumber,
    interestPayable: row.interestPayable,
    interestPaid: row.interestPaid,
    interestRemainingUnpaid: row.interestPayable,
    amountInadmissible: row.interestPayable,
    section: "MSMED Act Section 16 / Section 23",
    msmedSection: "Section 16 interest; Section 23 inadmissible",
    interestPayableOrPaid: row.interestAmount,
    daysDelayed: row.daysDelayed,
    remarks: "Report under Form 3CD Clause 22.",
  }));
  const paidLateRows = invoiceAging.filter((row) => row.paidLateAmount > 0).map((row) => ({
    financialYear: row.financialYear,
    supplier: row.vendorName,
    vendorName: row.vendorName,
    panNumber: row.panNumber,
    udyamNumber: row.udyamNumber,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    appointedDay: row.appointedDay,
    paymentDate: row.paymentDate,
    principalAmount: row.principalAmount,
    paidLateAmount: row.paidLateAmount || row.principalAmount,
    unpaidDelayedAmount: 0,
    disallowanceAmount: 0,
    principalDisallowance: 0,
    status: "paid_late",
    remarks: "Paid beyond appointed day during the reporting period; disclosed separately from closing unpaid disallowance.",
  }));
  const reportToCompact = normalizeCompactDate(summary.reportToDate);
  const clause22ByVendor = new Map();
  for (const row of invoiceAging) {
    const key = `${row.financialYear}|${row.vendorName}|${row.udyamNumber || ""}`;
    if (!clause22ByVendor.has(key)) {
      clause22ByVendor.set(key, {
        financialYear: row.financialYear,
        supplier: row.vendorName,
        vendorName: row.vendorName,
        panNumber: row.panNumber,
        udyamNumber: row.udyamNumber,
        totalPurchasesFromMicroSmall: 0,
        amountPaidDuringYear: 0,
        postMarchPaymentsWithin45Days: 0,
        clause22iiiBOutstandingDisallowance: 0,
        outstandingBalanceDisallowance: 0,
        interestUnderSection16: 0,
        source: "Tally import invoice aging",
        remarks: "43B(h) disallowance is derived from Clause 22(iii)(b) outstanding balance.",
      });
    }
    const target = clause22ByVendor.get(key);
    target.totalPurchasesFromMicroSmall = roundMoney(target.totalPurchasesFromMicroSmall + Number(row.principalAmount || 0));
    target.amountPaidDuringYear = roundMoney(target.amountPaidDuringYear + Number(row.paidLateAmount || 0));
    target.clause22iiiBOutstandingDisallowance = roundMoney(target.clause22iiiBOutstandingDisallowance + Number(row.unpaidDelayedAmount || 0));
    target.outstandingBalanceDisallowance = target.clause22iiiBOutstandingDisallowance;
    target.interestUnderSection16 = roundMoney(target.interestUnderSection16 + Number(row.interestAmount || 0));
    const paymentCompact = normalizeCompactDate(row.paymentDate);
    if (paymentCompact && reportToCompact && paymentCompact > reportToCompact && Number(row.daysDelayed || 0) <= 45) {
      target.postMarchPaymentsWithin45Days = roundMoney(target.postMarchPaymentsWithin45Days + Number(row.paidLateAmount || row.principalAmount || 0));
    }
  }
  const clause22Computation = [...clause22ByVendor.values()]
    .filter((row) =>
      Number(row.totalPurchasesFromMicroSmall || 0) ||
      Number(row.amountPaidDuringYear || 0) ||
      Number(row.clause22iiiBOutstandingDisallowance || 0) ||
      Number(row.interestUnderSection16 || 0)
    )
    .sort((a, b) => String(a.supplier).localeCompare(String(b.supplier)));
  const clause43BhFromClause22 = clause22Computation
    .filter((row) => Number(row.clause22iiiBOutstandingDisallowance || 0) > 0)
    .map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      supplier: row.supplier,
      panNumber: row.panNumber,
      udyamNumber: row.udyamNumber,
      principalDisallowance: row.clause22iiiBOutstandingDisallowance,
      sourceClause: "Clause 22(iii)(b)",
      allowedInYear: "Year of actual payment",
      remarks: "Derived from Clause 22(iii)(b) outstanding balance.",
    }));
  const clause26 = [
    ...disallowance43Bh.map((row) => ({
      financialYear: row.financialYear,
      supplier: row.vendorName,
      vendorName: row.vendorName,
      panNumber: row.panNumber,
      udyamNumber: row.udyamNumber,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: invoiceAging.find((invoice) => invoice.vendorName === row.vendorName && invoice.invoiceNumber === row.invoiceNumber)?.invoiceDate || "",
      appointedDay: invoiceAging.find((invoice) => invoice.vendorName === row.vendorName && invoice.invoiceNumber === row.invoiceNumber)?.appointedDay || "",
      paymentDate: "",
      principalAmount: row.principalAmount,
      paidLateAmount: 0,
      unpaidDelayedAmount: row.principalDisallowance,
      disallowanceAmount: row.principalDisallowance,
      principalDisallowance: row.principalDisallowance,
      status: "unpaid_delayed",
      remarks: "Principal disallowance under actual-payment rule.",
    })),
    ...paidLateRows,
  ];
  const interestMovement = report.map((row) => {
    const vendorInterestRows = msmedSection16Interest.filter((item) => item.vendorName === row.vendorName && item.financialYear === row.financialYear);
    const interestAccrued = roundMoney(vendorInterestRows.reduce((sum, item) => sum + Number(item.interestAmount || 0), 0));
    return {
      financialYear: row.financialYear,
      vendor: row.vendorName,
      vendorName: row.vendorName,
      ledgerPayableOutstanding: row.ledgerOutstandingAmount,
      openingInterest: 0,
      interestAccrued,
      interestPaid: 0,
      interestWaived: 0,
      closingInterestPayable: interestAccrued,
      section23Disallowance: interestAccrued,
    };
  });
  const creditorLedgerSummary = creditors.map((row) => {
    const baseline = baselineByVendorFy.get(`${row.financialYear || ""}|${row.normalizedVendorName || ""}`) || {};
    const mismatchFlag = Boolean(row.outstandingMismatch) || Math.abs(Number(row.ledgerOutstandingAmount || 0) - Number(row.voucherOutstandingAmount || 0)) >= 0.01;
    return {
      financialYear: row.financialYear || "",
      creditorLedger: row.party,
      vendorName: row.party,
      panNumber: row.panNumber || row.vendorMaster?.panNumber || "",
      openingBalance: roundMoney(row.openingBalance),
      voucherRows: row.voucherCount || 0,
      ledgerPayableOutstanding: roundMoney(row.ledgerOutstandingAmount ?? row.outstandingAmount ?? 0),
      voucherOnlyOutstanding: roundMoney(row.voucherOutstandingAmount || 0),
      closingBalance: roundMoney(row.closingBalance),
      days: row.daysOutstanding ?? "",
      balanceSource: mismatchFlag ? "Ledger used; voucher mismatch" : "Ledger closing credit",
      mismatchFlag: mismatchFlag ? "YES" : "NO",
      baselineStatus: baseline.status || "unavailable",
    };
  });
  const ledgerVoucherMismatch = creditorLedgerSummary
    .filter((row) => row.mismatchFlag === "YES")
    .map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      ledgerPayableOutstanding: row.ledgerPayableOutstanding,
      voucherOnlyOutstanding: row.voucherOnlyOutstanding,
      reason: "Ledger closing balance differs from voucher-only outstanding",
    }));
  const msmeVendorRegistry = [
    ...report.map((row) => ({
      vendorName: row.vendorName,
      ledgerName: row.vendorName,
      panNumber: row.panNumber || "",
      udyamNumber: row.udyamNumber || "",
      enterpriseType: row.enterpriseType || "",
      msmeStatus: "MSME",
      verificationStatus: row.vendorMaster?.udyamStatus || "verified",
      verificationSource: row.vendorMaster?.verificationSource || row.vendorMaster?.source || "master",
      evidenceLink: row.vendorMaster?.evidenceLink || row.vendorMaster?.evidenceUrl || row.vendorMaster?.udyamProofFileUrl || "",
      approvedBy: row.vendorMaster?.approvedBy || row.vendorMaster?.reviewedBy || row.vendorMaster?.udyamVerifiedBy || "",
      approvedAt: row.vendorMaster?.approvedAt || row.vendorMaster?.reviewedAt || row.vendorMaster?.udyamVerifiedAt || "",
      reasonExcluded: "",
      financialYear: row.financialYear,
    })),
    ...excluded.map((row) => ({
      vendorName: row.vendorName,
      ledgerName: row.vendorName,
      panNumber: row.panNumber || "",
      udyamNumber: row.udyamNumber || "",
      enterpriseType: row.enterpriseType || "",
      msmeStatus: "Excluded",
      verificationStatus: row.udyamStatus || row.verificationStatus || "pending",
      verificationSource: row.verificationSource || "master",
      evidenceLink: row.evidenceLink || row.evidenceUrl || "",
      approvedBy: row.approvedBy || "",
      approvedAt: row.approvedAt || "",
      reasonExcluded: row.reason,
      financialYear: row.financialYear || "",
    })),
  ];
  const verificationRequired = [
    ...excluded.filter((row) => !["no_current_activity", "non_msme", "not_required_zero_outstanding"].includes(row.reason)).map((row) => ({
      financialYear: row.financialYear || "",
      vendorName: row.vendorName,
      ledger: row.vendorName,
      invoiceNumber: "",
      issueType: "MSME Vendor Verification",
      issueDescription: row.reason,
      blockingFor: "MSME statutory schedules",
      suggestedAction: "Verify Udyam number or approve manual MSME evidence.",
      evidenceReference: row.evidenceLink || row.udyamNumber || "",
      outstandingAmount: roundMoney(row.ledgerOutstandingAmount ?? row.outstandingAmount ?? 0),
    })),
    ...invoiceAging.filter((row) => row.verificationRequired).map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      ledger: row.vendorName,
      invoiceNumber: row.invoiceNumber,
      issueType: "Voucher Evidence",
      issueDescription: row.verificationFlags || "Missing invoice, acceptance, agreement, or payment evidence.",
      blockingFor: "Interest, Clause 26, Schedule III support",
      suggestedAction: "Attach acceptance/payment/agreement evidence or confirm fallback.",
      evidenceReference: row.evidenceReference,
      outstandingAmount: row.unpaidAmount,
    })),
    ...baselineValidation.filter((row) => row.warning).map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      ledger: row.vendorName,
      invoiceNumber: "",
      issueType: "Opening Baseline",
      issueDescription: row.warning,
      blockingFor: "FY continuity reconciliation",
      suggestedAction: "Fetch or upload 31.03.2025 closing snapshot from Tally.",
      evidenceReference: row.baselineDate,
      outstandingAmount: row.openingBalance,
    })),
  ];
  const principalUnpaid = roundMoney(report.reduce((sum, row) => sum + Number(row.ledgerOutstandingAmount || row.outstandingAmount || 0), 0));
  const interestDue = roundMoney(msmedSection16Interest.reduce((sum, row) => sum + Number(row.interestAmount || 0), 0));
  const principalPaidLate = roundMoney(paidLateRows.reduce((sum, row) => sum + Number(row.paidLateAmount || 0), 0));
  const scheduleIIISummary = {
    principalUnpaid,
    interestDueUnpaid: interestDue,
    principalPaidBeyondAppointedDay: principalPaidLate,
    interestPaid: 0,
    interestDueForDelay: interestDue,
    interestAccruedUnpaid: interestDue,
    furtherInterestDueInSucceedingYears: interestDue,
    auditorText: `The Company has identified suppliers registered under the MSMED Act, 2006 based on information available. Principal amount remaining unpaid is Rs ${principalUnpaid}; interest accrued and remaining unpaid is Rs ${interestDue}; principal paid beyond appointed day during the year is Rs ${principalPaidLate}.`,
  };
  const scheduleIIIDisclosure = [
    ["Principal amount remaining unpaid", scheduleIIISummary.principalUnpaid, "Ledger-wise MSME Interest", "Total MSME ledger payable outstanding"],
    ["Interest due and remaining unpaid", scheduleIIISummary.interestDueUnpaid, "Form 3CD Clause 22", "Computed under MSMED Section 16"],
    ["Principal paid beyond appointed day", scheduleIIISummary.principalPaidBeyondAppointedDay, "Form 3CD Clause 26", "Paid late rows only"],
    ["Interest paid", scheduleIIISummary.interestPaid, "Ledger-wise MSME Interest", "No separate interest payment voucher mapping identified"],
    ["Interest due/payable for delay", scheduleIIISummary.interestDueForDelay, "Voucher-wise Delay Evidence", "Computed till report/as-on date"],
    ["Interest accrued and unpaid", scheduleIIISummary.interestAccruedUnpaid, "Ledger-wise MSME Interest", "Closing interest payable"],
    ["Further interest due in succeeding years", scheduleIIISummary.furtherInterestDueInSucceedingYears, "Assumptions & Notes", "Update on actual payment"],
    ["Auditor-ready disclosure text", scheduleIIISummary.auditorText, "Schedule III Disclosure", ""],
  ].map(([disclosureItem, amount, sourceSchedule, notes]) => ({ disclosureItem, amount, sourceSchedule, notes }));
  const taxDisallowanceSummary = [
    ...clause43BhFromClause22.map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName || row.supplier,
      invoiceNumber: row.invoiceNumber || "",
      disallowanceType: "43B(h) principal",
      section: summary.applicableSection || "Section 43B(h)",
      principalDisallowance: row.principalDisallowance,
      interestPermanentDisallowance: 0,
      paymentStatus: "unpaid_or_outstanding_at_year_end",
      allowedInYear: row.allowedInYear,
      remarks: row.remarks,
    })),
    ...msmedSection23PermanentDisallowance.map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      invoiceNumber: row.invoiceNumber,
      disallowanceType: "Section 23 MSME interest",
      section: "MSMED Act Section 23",
      principalDisallowance: 0,
      interestPermanentDisallowance: row.permanentlyDisallowedAmount,
      paymentStatus: "interest_payable",
      allowedInYear: "Never deductible",
      remarks: row.reason,
    })),
  ];
  const assumptionsAndNotes = [
    { area: "RBI bank rate source", assumption: `Static configured bank rate ${summary.bankRatePercent}% used`, impact: "Interest is recalculated when configuration changes.", userActionRequired: "Update MSME_BANK_RATE_PERCENT for period-specific rate." },
    { area: "Interest payment vouchers", assumption: "Interest paid defaults to zero unless separately identifiable.", impact: "Closing interest payable may be overstated if interest was paid outside mapping.", userActionRequired: "Map interest payment vouchers." },
    { area: "Baseline source", assumption: "31.03.2025 baseline is validated when snapshot/prior FY is available.", impact: "Unvalidated opening is treated as a reconciliation note.", userActionRequired: "Fetch or upload Tally baseline snapshot." },
    { area: "Invoice date fallback", assumption: "Invoice date is used when acceptance/deemed acceptance date is missing.", impact: "Calculation uses invoice date where acceptance evidence is unavailable.", userActionRequired: "Attach acceptance/deemed acceptance evidence." },
    { area: "Agreement fallback", assumption: "No written agreement uses 15 days; written agreement with missing days uses 45-day cap with warning.", impact: "Conservative calculation where evidence is incomplete.", userActionRequired: "Attach agreement evidence and credit days." },
  ];
  return {
    masterSummary: [summary],
    executiveSummary: Object.entries({
      "Total creditor ledgers": summary.importedCreditors,
      "Zero FY voucher activity/outstanding": summary.zeroFYVoucherActivityOutstanding,
      "Verified MSME vendors": summary.reportableMSME,
      "Pending verification vendors": summary.pendingVerificationVendors,
      "Ledger payable outstanding": summary.totalOutstanding,
      "MSME principal unpaid": principalUnpaid,
      "43B(h) disallowance": roundMoney(clause43BhFromClause22.reduce((sum, row) => sum + Number(row.principalDisallowance || 0), 0)),
      "Section 16 interest": interestDue,
      "Section 23 disallowance": interestDue,
    }).map(([metric, value]) => ({
      metric,
      value,
      financialYear: summary.selectedFinancialYear,
      reportFrom: summary.reportFromDate,
      reportTo: summary.reportToDate,
      asOnDate: summary.asOnDate,
      cappedByAsOn: summary.cappedByAsOn ? "YES" : "NO",
      notes: summary.noVerifiedMSMEWarning || summary.capWarning || "",
    })),
    creditorLedgerSummary,
    msmeVendorRegistry,
    ledgerWiseMSMEInterest: interestMovement,
    ledgerWiseOutstanding: report.map((row) => ({
      financialYear: row.financialYear,
      vendorName: row.vendorName,
      panNumber: row.panNumber,
      udyamNumber: row.udyamNumber,
      openingBaselineDate: row.openingBaselineDate,
      openingBaselineAmount: row.openingBaselineAmount,
      openingBalance: row.openingBalance,
      fyDebit: row.fyDebit,
      fyCredit: row.fyCredit,
      ledgerPayableOutstanding: row.ledgerOutstandingAmount,
      voucherOnlyOutstanding: row.voucherOutstandingAmount,
      closingBalance: row.closingBalance,
      mismatchFlag: row.outstandingMismatch ? "YES" : "NO",
    })),
    voucherWiseDelayEvidence: invoiceAging,
    invoiceAging,
    interestCalculation,
    interestMovement,
    msmedSection16Interest,
    msmedSection23PermanentDisallowance,
    disallowance43Bh,
    clause43BhFromClause22,
    taxDisallowanceSummary,
    clause22Computation,
    clause22,
    clause26,
    form3cd: { clause22, clause26 },
    ledgerVoucherMismatch,
    baselineValidation,
    evidenceIndex: verificationRequired,
    verificationRequired,
    pendingVerification: verificationRequired,
    scheduleIIIDisclosure,
    scheduleIIIDisclosureSummary: scheduleIIISummary,
    auditorDisclosureText: scheduleIIISummary.auditorText,
    mcaMsmeForm1Data: [],
    assumptionsAndNotes,
  };
}

function createMSMEReport({ importRunId, fiscalYear, asOnDate, actor, bankRatePercent }) {
  const run = importRepository.getRun(importRunId);
  if (!run) throw new Error("Import run not found");
  if (run.status !== "completed") throw new Error("Import run is not completed");
  const selectedFinancialYear = requestedReportFinancialYear(run, fiscalYear);
  assertReportFinancialYear(run, selectedFinancialYear);
  const scope = capScopeByAsOn(periodScopeForReport(run, selectedFinancialYear), asOnDate || run.asOn);

  const vouchers = importRepository.getLedgerVouchersForReport(importRunId, {
    financialYear: selectedFinancialYear,
    fromDate: scope.reportFromDate ? displayDate(scope.reportFromDate) : "",
    toDate: scope.reportToDate ? displayDate(scope.reportToDate) : "",
  });
  const baseCreditors = enrichCreditors(importRepository.getCreditors(importRunId));
  const scopedLedgerCreditors = buildScopedLedgerCreditors(baseCreditors, vouchers, run, selectedFinancialYear, scope);
  const creditors = selectedFinancialYear === "all" && Array.isArray(run.summary?.financialYearPeriods) && run.summary.financialYearPeriods.length
    ? scopedLedgerCreditors.flatMap((creditor) => {
      const fyVouchers = vouchers.filter((row) => (row.financialYear || row.fiscalYear) === creditor.financialYear);
      return enrichCreditorsWithVoucherAging([creditor], fyVouchers, asOnDate || creditor.asOnDate || run.asOn, { preferVoucherOutstanding: false });
    })
    : enrichCreditorsWithVoucherAging(
      scopedLedgerCreditors,
      vouchers,
      asOnDate || scope.asOnDate || run.asOn,
      { preferVoucherOutstanding: false }
    );
  const stats = buildVerificationSummary(creditors);

  const requestedBankRatePercent = bankRatePercent == null || bankRatePercent === "" ? NaN : Number(bankRatePercent);
  const effectiveBankRatePercent = Number.isFinite(requestedBankRatePercent) && requestedBankRatePercent >= 0
    ? requestedBankRatePercent
    : getConfiguredBankRatePercent();
  const annualInterestRate = getDefaultAnnualInterestRate(effectiveBankRatePercent);
  const taxBasis = taxBasisForFiscalYear(selectedFinancialYear === "all" ? (run.summary?.financialYears?.[0] || run.fiscalYear) : selectedFinancialYear);
  const report = calculateReportRows(creditors, {
    fiscalYear: selectedFinancialYear === "all" ? (run.summary?.financialYears?.[0] || run.fiscalYear) : selectedFinancialYear,
    bankRatePercent: effectiveBankRatePercent,
    annualInterestRate,
  });
  const excluded = calculateExcludedRows(creditors);
  const baselineValidation = buildBaselineValidation(creditors, run, selectedFinancialYear);
  const rulePack = loadRulePack();
  const activeCreditors = creditors.filter((row) => !isZeroActivity(row));
  const zeroActivityCreditors = creditors.filter(isZeroActivity);
  const nonZeroOutstandingCreditors = creditors.filter((row) => Math.abs(Number(row.outstandingAmount || 0)) > 0);
  const zeroOutstandingNotRequired = creditors.filter((row) =>
    row.vendorMaster?.actionStatus === "not_required_zero_outstanding" ||
    row.vendorMaster?.verificationStatus === "not_required_zero_outstanding"
  );
  const excludedByReason = excluded.reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    ...stats,
    rulePackVersion: rulePack.version,
    selectedFinancialYear,
    availableFinancialYears: run.summary?.financialYears || [run.fiscalYear],
    financialYearSummaries: buildFinancialYearSummary(creditors),
    reportFromDate: scope.reportFromDate,
    reportToDate: scope.reportToDate,
    reportPeriodLabel: `${displayDate(scope.reportFromDate)} to ${displayDate(scope.reportToDate)}`,
    cappedByAsOn: scope.cappedByAsOn,
    capWarning: scope.cappedByAsOn ? "Data is capped by the selected as-on date." : "",
    applicableAct: taxBasis.applicableAct,
    applicableSection: taxBasis.applicableSection,
    actualPaymentRuleId: taxBasis.actualPaymentRuleId,
    bankRatePercent: effectiveBankRatePercent,
    annualInterestRatePercent: Math.round(annualInterestRate * 10000) / 100,
    interestRateSource: "config",
    asOnDate: asOnDate || scope.asOnDate || run.asOn,
    voucherSource: run.summary?.voucherSource || "",
    fallbackUsed: Boolean(run.summary?.fallbackUsed),
    creditorsImported: run.summary?.creditorsImported ?? creditors.length,
    importedCreditors: creditors.length,
    activeCreditorLedgers: activeCreditors.length,
    zeroFYVoucherActivityOutstanding: zeroActivityCreditors.length,
    nonZeroOutstandingCreditors: nonZeroOutstandingCreditors.length,
    zeroOutstandingNotRequired: zeroOutstandingNotRequired.length,
    vouchersParsed: run.summary?.vouchersParsed ?? vouchers.length,
    vouchersPersisted: vouchers.length,
    importedOutstanding: Math.round(creditors.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0) * 100) / 100,
    verifiedMSMEOutstanding: Math.round(creditors.filter(isReportableMSME).reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0) * 100) / 100,
    reportVendors: report.length,
    reportableMSME: report.length,
    excludedFromReport: excluded.length,
    excludedByReason,
    totalOutstanding: Math.round(report.reduce((sum, row) => sum + row.outstandingAmount, 0) * 100) / 100,
    totalDisallowed: 0,
    totalTaxImpact: 0,
    totalInterest: Math.round(report.reduce((sum, row) => sum + row.interest, 0) * 100) / 100,
    baselineValidation,
    baselineWarnings: baselineValidation.filter((row) => row.warning).length,
    noVerifiedMSMEWarning: report.length === 0
      ? "No verified MSME vendors are available for the selected period. Complete Udyam/MSME verification to generate statutory MSME schedules."
      : "",
    pendingVerificationVendors: excluded.filter((row) => ["missing_udyam", "not_verified", "manual_review_required", "proof_pending_review", "invalid_udyam"].includes(row.reason)).length,
  };
  const schedules = buildReportSchedules({ report, excluded, creditors, summary });
  const authoritative43Bh = roundMoney((schedules.clause43BhFromClause22 || []).reduce((sum, row) => sum + Number(row.principalDisallowance || 0), 0));
  summary.totalDisallowed = authoritative43Bh;
  summary.totalTaxImpact = roundMoney(authoritative43Bh * 0.25);
  const masterSummary = schedules.masterSummary?.[0];
  if (masterSummary) {
    masterSummary.totalDisallowed = summary.totalDisallowed;
    masterSummary.totalTaxImpact = summary.totalTaxImpact;
  }

  const savedReport = reportRepository.createReport({
    importRunId,
    fiscalYear: selectedFinancialYear,
    summary,
    report: { included: report, excluded, schedules },
    actor,
  });
  const carryForward = carryForwardService.buildRegister(savedReport.id);
  return {
    ...savedReport,
    schedules: {
      ...savedReport.schedules,
      clause26CarryForwardRegister: carryForward.rows,
      clause26CarryForwardSummary: carryForward.summary,
    },
  };
}

function getReport(id) {
  const report = reportRepository.getReport(id);
  if (!report) return null;
  const carryForward = carryForwardService.getOrBuildRegister(id);
  return {
    ...report,
    schedules: {
      ...report.schedules,
      clause26CarryForwardRegister: carryForward.rows,
      clause26CarryForwardSummary: carryForward.summary,
    },
  };
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function listReports() {
  return reportRepository.listReports();
}

function toCsv(report) {
  let csv = "MSME Guard - Compliance Report\n";
  csv += `Report ID,${report.id}\n`;
  csv += `Financial Year,${report.fiscalYear}\n`;
  csv += `Generated On,${new Date(report.createdAt).toLocaleString("en-IN")}\n\n`;
  csv += "Verification Summary\n";
  for (const [key, value] of Object.entries(report.summary)) csv += `${key},${value}\n`;
  csv += "\nRule Basis\n";
  csv += "Rule ID,Name,Sources\n";
  const ruleMap = new Map();
  for (const row of report.report) {
    for (const basis of row.legalBasis || []) ruleMap.set(basis.ruleId, basis);
  }
  for (const basis of ruleMap.values()) {
    csv += `"${basis.ruleId}","${basis.name}","${(basis.sourceRefs || []).join(" | ")}"\n`;
  }
  const legalManifest = loadLegalSourceManifest();
  csv += "\nLegal Source Files\n";
  csv += "Source ID,Title,Official URL,Local PDF,Local Indexes\n";
  for (const source of legalManifest.sources || []) {
    const indexes = [source.localMetadata, source.localJson, source.localText, source.localRuleIndex, source.localSubjectIndex, source.localFormIndex]
      .filter(Boolean)
      .join(" | ");
    csv += [source.id, source.title, source.officialUrl || source.officialPdfUrl || "", source.localPdf || source.localPath || "", indexes].map(csvEscape).join(",") + "\n";
  }
  csv += "\nIncluded Vendors\n";
  csv += "Vendor Name,PAN Number,Udyam No,Enterprise Name,Enterprise Type,Payment Terms,Ledger Payable Outstanding,Voucher-only Outstanding,Outstanding Mismatch,Opening Balance,Closing Balance,Days Outstanding,Allowed Days,Delay Days,Bucket,Delayed?,Disallowed Amount,Tax Impact @25%,Interest,Interest Rate %,Applicable Act,Applicable Section,Applied Rules,Findings\n";
  for (const row of report.report) {
    csv += [row.vendorName, row.panNumber || "", row.udyamNumber, row.enterpriseName, row.enterpriseType, row.agreedPaymentDays ? `${row.agreedPaymentDays} days` : "", row.ledgerOutstandingAmount?.toFixed ? row.ledgerOutstandingAmount.toFixed(2) : row.outstandingAmount.toFixed(2), Number(row.voucherOutstandingAmount || 0).toFixed(2), row.outstandingMismatch ? "YES" : "NO", row.openingBalanceRaw || Number(row.openingBalance || 0).toFixed(2), row.closingBalanceRaw || Number(row.closingBalance || 0).toFixed(2), row.daysOutstanding ?? "N/A", row.allowedPaymentDays, row.delayDays, row.bucket, row.isDelayed ? "YES" : "NO", row.disallowed.toFixed(2), row.taxImpact.toFixed(2), row.interest.toFixed(2), row.annualInterestRatePercent ?? "", row.applicableAct || "", row.applicableSection || "", (row.appliedRules || []).join(" | "), (row.findings || []).join(" | ")].map(csvEscape).join(",") + "\n";
  }
  if (report.excluded?.length) {
    csv += "\nExcluded Vendors\n";
    csv += "Vendor Name,PAN Number,Udyam No,Udyam Status,Action Status,Review Status,Voucher Rows,Ledger Payable Outstanding,Voucher-only Outstanding,Outstanding Mismatch,Days,Excluded Reason\n";
    for (const row of report.excluded) {
      csv += [row.vendorName, row.panNumber || "", row.udyamNumber, row.udyamStatus, row.actionStatus, row.reviewStatus, row.voucherCount, Number(row.ledgerOutstandingAmount ?? row.outstandingAmount ?? 0).toFixed(2), Number(row.voucherOutstandingAmount || 0).toFixed(2), row.outstandingMismatch ? "YES" : "NO", row.daysOutstanding ?? "N/A", row.reason].map(csvEscape).join(",") + "\n";
    }
  }
  return csv;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pdfMoney(value) {
  return Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function verifiedReportHtml(report) {
  const rows = report.report || [];
  const schedules = report.schedules || {};
  const voucherRows = (schedules.voucherWiseDelayEvidence || schedules.invoiceAging || [])
    .filter((row) => rows.some((vendor) => vendor.vendorName === row.vendorName && vendor.financialYear === row.financialYear));
  const summary = report.summary || {};
  const generated = new Date(report.createdAt || Date.now()).toLocaleString("en-IN");
  const vendorRows = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.financialYear || report.fiscalYear)}</td>
      <td>${escapeHtml(row.vendorName)}</td>
      <td>${escapeHtml(row.panNumber || "")}</td>
      <td>${escapeHtml(row.udyamNumber)}</td>
      <td>${escapeHtml(row.enterpriseType || "")}</td>
      <td class="num">${pdfMoney(row.ledgerOutstandingAmount ?? row.outstandingAmount)}</td>
      <td class="num">${escapeHtml(row.allowedPaymentDays || row.agreedPaymentDays || "")}</td>
      <td class="num">${escapeHtml(row.delayDays || 0)}</td>
      <td class="num">${pdfMoney(row.disallowed)}</td>
      <td class="num">${pdfMoney(row.interest)}</td>
    </tr>
  `).join("");
  const evidenceRows = voucherRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.financialYear || "")}</td>
      <td>${escapeHtml(row.vendorName || "")}</td>
      <td>${escapeHtml(row.invoiceNumber || "")}</td>
      <td>${escapeHtml(displayDate(row.invoiceDate || ""))}</td>
      <td>${escapeHtml(displayDate(row.appointedDay || ""))}</td>
      <td>${escapeHtml(displayDate(row.paymentDate || ""))}</td>
      <td class="num">${pdfMoney(row.principalAmount)}</td>
      <td class="num">${pdfMoney(row.unpaidDelayedAmount || 0)}</td>
      <td class="num">${escapeHtml(row.daysDelayed || 0)}</td>
      <td class="num">${pdfMoney(row.interestAmount)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; color: #111827; font-size: 11px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 22px 0 8px; }
    p { line-height: 1.45; margin: 4px 0; }
    .muted { color: #6b7280; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
    .metric { border: 1px solid #e5e7eb; padding: 8px; border-radius: 6px; }
    .metric strong { display: block; font-size: 15px; margin-bottom: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; page-break-inside: auto; }
    th, td { border: 1px solid #e5e7eb; padding: 5px; vertical-align: top; }
    th { background: #f3f4f6; text-align: left; }
    tr { page-break-inside: avoid; page-break-after: auto; }
    .num { text-align: right; white-space: nowrap; }
    .note { background: #f9fafb; border: 1px solid #e5e7eb; padding: 8px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>MSME Compliance Report</h1>
  <p class="muted">Report ${escapeHtml(report.id)} | FY ${escapeHtml(report.fiscalYear)} | Generated ${escapeHtml(generated)}</p>
  <p>Report period: <strong>${escapeHtml(summary.reportPeriodLabel || "")}</strong> | As-on date: <strong>${escapeHtml(displayDate(summary.asOnDate || ""))}</strong></p>

  <div class="grid">
    <div class="metric"><strong>${pdfMoney(summary.reportVendors)}</strong>Verified MSME vendors</div>
    <div class="metric"><strong>Rs ${pdfMoney(summary.totalDisallowed)}</strong>FIFO disallowance</div>
    <div class="metric"><strong>Rs ${pdfMoney(summary.totalInterest)}</strong>MSMED interest</div>
    <div class="metric"><strong>${escapeHtml(summary.applicableSection || "")}</strong>Applicable section</div>
  </div>

  <div class="note">
    <p><strong>Calculation basis.</strong> Only backend-verified MSME vendors with valid Udyam numbers are included. Principal disallowance is derived from Tally-imported creditor/voucher aging using FIFO invoice settlement and the actual-payment rule for ${escapeHtml(summary.applicableSection || "MSME disallowance")}.</p>
    <p>Interest is computed invoice-wise under MSMED Section 16 at three times the configured RBI bank rate (${escapeHtml(summary.bankRatePercent || "")}% bank rate; ${escapeHtml(summary.annualInterestRatePercent || "")}% annual interest), with monthly rests. MSMED interest is treated as inadmissible under Section 23.</p>
  </div>

  <h2>Verified MSME Vendor Summary</h2>
  <table>
    <thead><tr><th>FY</th><th>Vendor</th><th>PAN</th><th>Udyam</th><th>Type</th><th>Ledger Outstanding</th><th>Allowed Days</th><th>Delay Days</th><th>FIFO Disallowed</th><th>Interest</th></tr></thead>
    <tbody>${vendorRows || '<tr><td colspan="10">No verified MSME vendors in this report.</td></tr>'}</tbody>
  </table>

  <h2>Voucher-wise FIFO and Interest Evidence</h2>
  <table>
    <thead><tr><th>FY</th><th>Vendor</th><th>Invoice</th><th>Invoice Date</th><th>Appointed Day</th><th>Payment Date</th><th>Principal</th><th>Unpaid Delayed</th><th>Delay Days</th><th>Interest</th></tr></thead>
    <tbody>${evidenceRows || '<tr><td colspan="10">No delayed invoice evidence rows in this report.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

async function toPdfBuffer(report) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(0);
    await page.setContent(verifiedReportHtml(report), { waitUntil: "domcontentloaded", timeout: 0 });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "10mm", bottom: "14mm", left: "10mm" },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

function toXml(report) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MSMEGuardReport id="${escapeXml(report.id)}" fiscalYear="${escapeXml(report.fiscalYear)}">
  <Summary>
${Object.entries(report.summary).map(([key, value]) => `    <${key}>${escapeXml(value)}</${key}>`).join("\n")}
  </Summary>
  <Vendors>
${report.report.map((row) => `    <Vendor>
      <Name>${escapeXml(row.vendorName)}</Name>
      <PANNumber>${escapeXml(row.panNumber || "")}</PANNumber>
      <UdyamNumber>${escapeXml(row.udyamNumber)}</UdyamNumber>
      <EnterpriseName>${escapeXml(row.enterpriseName)}</EnterpriseName>
      <EnterpriseType>${escapeXml(row.enterpriseType)}</EnterpriseType>
      <PaymentTerms>${escapeXml(row.agreedPaymentDays ? `${row.agreedPaymentDays} days` : "")}</PaymentTerms>
      <OutstandingAmount>${escapeXml(row.outstandingAmount)}</OutstandingAmount>
      <LedgerPayableOutstanding>${escapeXml(row.ledgerOutstandingAmount ?? row.outstandingAmount)}</LedgerPayableOutstanding>
      <VoucherOnlyOutstanding>${escapeXml(row.voucherOutstandingAmount || 0)}</VoucherOnlyOutstanding>
      <OutstandingMismatch>${row.outstandingMismatch ? "YES" : "NO"}</OutstandingMismatch>
      <MismatchReason>${escapeXml(row.mismatchReason || "")}</MismatchReason>
      <DaysOutstanding>${escapeXml(row.daysOutstanding)}</DaysOutstanding>
      <AllowedPaymentDays>${escapeXml(row.allowedPaymentDays)}</AllowedPaymentDays>
      <DelayDays>${escapeXml(row.delayDays)}</DelayDays>
      <Delayed>${row.isDelayed ? "YES" : "NO"}</Delayed>
      <DisallowedAmount>${escapeXml(row.disallowed)}</DisallowedAmount>
      <TaxImpact>${escapeXml(row.taxImpact)}</TaxImpact>
      <Interest>${escapeXml(row.interest)}</Interest>
      <InterestRatePercent>${escapeXml(row.annualInterestRatePercent ?? "")}</InterestRatePercent>
      <ApplicableAct>${escapeXml(row.applicableAct || report.summary?.applicableAct || "")}</ApplicableAct>
      <ApplicableSection>${escapeXml(row.applicableSection || report.summary?.applicableSection || "")}</ApplicableSection>
      <AppliedRules>
${(row.legalBasis || []).map((basis) => `        <Rule id="${escapeXml(basis.ruleId)}">
          <Name>${escapeXml(basis.name)}</Name>
          <Sources>${escapeXml((basis.sourceRefs || []).join(" | "))}</Sources>
        </Rule>`).join("\n")}
      </AppliedRules>
    </Vendor>`).join("\n")}
  </Vendors>
  <ExcludedVendors>
${(report.excluded || []).map((row) => `    <ExcludedVendor>
      <Name>${escapeXml(row.vendorName)}</Name>
      <PANNumber>${escapeXml(row.panNumber || "")}</PANNumber>
      <UdyamNumber>${escapeXml(row.udyamNumber)}</UdyamNumber>
      <UdyamStatus>${escapeXml(row.udyamStatus)}</UdyamStatus>
      <ActionStatus>${escapeXml(row.actionStatus)}</ActionStatus>
      <ReviewStatus>${escapeXml(row.reviewStatus)}</ReviewStatus>
      <Reason>${escapeXml(row.reason)}</Reason>
    </ExcludedVendor>`).join("\n")}
  </ExcludedVendors>
</MSMEGuardReport>`;
}

function buildSimpleZip(files) {
  const buffers = [];
  const central = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
  };
  const dosTime = 0;
  const dosDate = 0x0021;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    buffers.push(local, data);
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...buffers, ...central, end]);
}

function toExcludedCsv(report) {
  const lines = ["Vendor Name,PAN Number,Udyam No,Udyam Status,Action Status,Review Status,Voucher Rows,Ledger Payable Outstanding,Voucher-only Outstanding,Outstanding Mismatch,Days,Excluded Reason"];
  for (const row of report.excluded || []) {
    lines.push([row.vendorName, row.panNumber || "", row.udyamNumber, row.udyamStatus, row.actionStatus, row.reviewStatus, row.voucherCount, Number(row.ledgerOutstandingAmount ?? row.outstandingAmount ?? 0).toFixed(2), Number(row.voucherOutstandingAmount || 0).toFixed(2), row.outstandingMismatch ? "YES" : "NO", row.daysOutstanding ?? "N/A", row.reason].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function toEvidenceMetadataCsv(report) {
  const vendors = vendorRepository.getAllVendors();
  const lines = ["Vendor Name,Udyam Number,Evidence URL,Proof Notes,Review Status,Reviewed By,Reviewed At,Review Comment"];
  for (const vendor of vendors) {
    if (!vendor.evidenceUrl && !vendor.proofNotes && !vendor.reviewComment) continue;
    lines.push([vendor.vendorName, vendor.udyamNumber, vendor.evidenceUrl, vendor.proofNotes, vendor.reviewStatus, vendor.reviewedBy, vendor.reviewedAt, vendor.reviewComment].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function toTallyReconciliationCsv(report) {
  const run = importRepository.getRun(report.importRunId);
  const creditors = enrichCreditors(importRepository.getCreditors(report.importRunId));
  const includedByName = new Map((report.report || []).map((row) => [row.normalizedVendorName, row]));
  const lines = ["Import Run,Fiscal Year,As On,Vendor,PAN Number,Voucher Rows,Opening Balance,Closing Balance,Ledger Payable Outstanding,Voucher-only Outstanding,Reportable Outstanding,Action Status,Mismatch"];
  for (const creditor of creditors) {
    const included = includedByName.get(creditor.normalizedVendorName);
    const reportable = included?.outstandingAmount || 0;
    const mismatch = creditor.outstandingMismatch
      ? "ledger_voucher_mismatch"
      : reportable > Number(creditor.outstandingAmount || 0)
        ? "report_exceeds_import"
        : "";
    lines.push([
      report.importRunId,
      report.fiscalYear,
      report.summary.asOnDate || run?.asOn || "",
      creditor.party,
      creditor.panNumber || creditor.vendorMaster?.panNumber || "",
      creditor.voucherCount || 0,
      creditor.openingBalanceRaw || Number(creditor.openingBalance || 0).toFixed(2),
      creditor.closingBalanceRaw || Number(creditor.closingBalance || 0).toFixed(2),
      Number(creditor.ledgerOutstandingAmount ?? creditor.outstandingAmount ?? 0).toFixed(2),
      Number(creditor.voucherOutstandingAmount || 0).toFixed(2),
      Number(reportable || 0).toFixed(2),
      creditor.vendorMaster?.actionStatus || "",
      mismatch,
    ].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function sheetFromRows(rows = [], fallbackHeaders = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeRows.length) return XLSX.utils.json_to_sheet(safeRows);
  const headers = fallbackHeaders.length ? fallbackHeaders : ["No records"];
  return XLSX.utils.aoa_to_sheet([headers, ["No records"]]);
}

function withTotals(rows = [], amountKeys = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length || !amountKeys.length) return safeRows;
  const total = { ...Object.fromEntries(Object.keys(safeRows[0]).map((key) => [key, ""])) };
  const firstKey = Object.keys(total)[0];
  if (firstKey) total[firstKey] = "Total";
  for (const key of amountKeys) total[key] = roundMoney(safeRows.reduce((sum, row) => sum + Number(row[key] || 0), 0));
  return [...safeRows, total];
}

function toWorkbookBuffer(report) {
  const workbook = XLSX.utils.book_new();
  const schedules = report.schedules || {};
  const sheetSpecs = [
    ["Executive Summary", schedules.executiveSummary || schedules.masterSummary || [report.summary || {}], ["metric", "value", "financialYear", "reportFrom", "reportTo", "asOnDate", "cappedByAsOn", "notes"]],
    ["Creditor Ledger Summary", withTotals(schedules.creditorLedgerSummary, ["openingBalance", "ledgerPayableOutstanding", "voucherOnlyOutstanding", "closingBalance"]), ["financialYear", "creditorLedger", "panNumber", "openingBalance", "voucherRows", "ledgerPayableOutstanding", "voucherOnlyOutstanding", "closingBalance", "days", "balanceSource", "mismatchFlag", "baselineStatus"]],
    ["MSME Vendor Registry", schedules.msmeVendorRegistry, ["vendorName", "ledgerName", "panNumber", "udyamNumber", "enterpriseType", "msmeStatus", "verificationStatus", "verificationSource", "evidenceLink", "approvedBy", "approvedAt", "reasonExcluded", "financialYear"]],
    ["Ledger-wise MSME Interest", withTotals(schedules.ledgerWiseMSMEInterest || schedules.interestMovement, ["ledgerPayableOutstanding", "openingInterest", "interestAccrued", "interestPaid", "interestWaived", "closingInterestPayable", "section23Disallowance"]), ["financialYear", "vendor", "ledgerPayableOutstanding", "openingInterest", "interestAccrued", "interestPaid", "interestWaived", "closingInterestPayable", "section23Disallowance"]],
    ["Voucher-wise Delay Evidence", withTotals(schedules.voucherWiseDelayEvidence || schedules.invoiceAging, ["principalAmount", "unpaidAmount", "paidLateAmount", "interestAmount"]), ["financialYear", "vendorName", "invoiceNumber", "invoiceDate", "acceptanceDate", "dateSource", "hasWrittenAgreement", "agreementDays", "allowedPaymentDays", "appointedDay", "paymentDate", "principalAmount", "unpaidAmount", "paidLateAmount", "daysDelayed", "rbiBankRate", "interestAmount", "evidenceReference", "verificationRequired", "verificationFlags"]],
    ["Tax Disallowance Summary", withTotals(schedules.taxDisallowanceSummary, ["principalDisallowance", "interestPermanentDisallowance"]), ["financialYear", "vendorName", "invoiceNumber", "disallowanceType", "section", "principalDisallowance", "interestPermanentDisallowance", "paymentStatus", "allowedInYear", "remarks"]],
    ["Clause 22 MSME Computation", withTotals(schedules.clause22Computation, ["totalPurchasesFromMicroSmall", "amountPaidDuringYear", "postMarchPaymentsWithin45Days", "clause22iiiBOutstandingDisallowance", "interestUnderSection16"]), ["financialYear", "supplier", "panNumber", "udyamNumber", "totalPurchasesFromMicroSmall", "amountPaidDuringYear", "postMarchPaymentsWithin45Days", "clause22iiiBOutstandingDisallowance", "outstandingBalanceDisallowance", "interestUnderSection16", "source", "remarks"]],
    ["43B(h) From Clause 22", withTotals(schedules.clause43BhFromClause22, ["principalDisallowance"]), ["financialYear", "supplier", "panNumber", "udyamNumber", "principalDisallowance", "sourceClause", "allowedInYear", "remarks"]],
    ["Clause 26A Carry Forward", withTotals(schedules.clause26CarryForwardRegister, ["openingDisallowance", "paidDuringYear", "deductibleCurrentYear", "closingCarryForward"]), ["financialYear", "vendorName", "panNumber", "udyamNumber", "invoiceNumber", "invoiceDate", "openingDisallowance", "paidDuringYear", "deductibleCurrentYear", "closingCarryForward", "settlementSource", "evidenceReference", "status"]],
    ["Form 3CD Clause 22", withTotals(schedules.clause22, ["interestPayable", "interestPaid", "interestRemainingUnpaid", "amountInadmissible"]), ["financialYear", "supplier", "panNumber", "udyamNumber", "interestPayable", "interestPaid", "interestRemainingUnpaid", "amountInadmissible", "msmedSection", "remarks"]],
    ["Form 3CD Clause 26", withTotals(schedules.clause26, ["principalAmount", "paidLateAmount", "unpaidDelayedAmount", "disallowanceAmount"]), ["financialYear", "supplier", "panNumber", "udyamNumber", "invoiceNumber", "invoiceDate", "appointedDay", "paymentDate", "principalAmount", "paidLateAmount", "unpaidDelayedAmount", "disallowanceAmount", "status", "remarks"]],
    ["Schedule III Disclosure", schedules.scheduleIIIDisclosure, ["disclosureItem", "amount", "sourceSchedule", "notes"]],
    ["MCA MSME Form-1 Data", schedules.mcaMsmeForm1Data, ["halfYear", "supplierName", "panNumber", "paidWithinTredsCount", "paidWithinTredsAmount", "paidWithinOtherCount", "paidWithinOtherAmount", "paidAfter45Count", "paidAfter45Amount", "outstanding45OrLessCount", "outstanding45OrLessAmount", "outstandingMoreThan45Count", "outstandingMoreThan45Amount", "reasonForDelay", "validationStatus"]],
    ["Assumptions & Notes", schedules.assumptionsAndNotes, ["area", "assumption", "impact", "userActionRequired"]],
  ];
  for (const [name, rows, headers] of sheetSpecs) {
    const sheet = sheetFromRows(rows, headers);
    sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
    sheet["!cols"] = Array.from({ length: range.e.c - range.s.c + 1 }, () => ({ wch: 22 }));
    XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
  }
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

function buildEvidenceBundle(report) {
  const audit = vendorRepository.getAuditTrail();
  const rulePack = loadRulePack();
  const usedRuleIds = new Set((report.report || []).flatMap((row) => row.appliedRules || []));
  const activeRulePack = {
    ...rulePack,
    rules: (rulePack.rules || []).filter((rule) => usedRuleIds.has(rule.id)),
  };
  const legalSources = loadLegalSourceManifest();
  return buildSimpleZip([
    { name: "report.csv", content: toCsv(report) },
    { name: "report.xml", content: toXml(report) },
    { name: "legal-source-manifest.json", content: JSON.stringify(legalSources, null, 2) },
    { name: "active-rule-pack.json", content: JSON.stringify(activeRulePack, null, 2) },
    { name: "excluded-vendors.csv", content: toExcludedCsv(report) },
    { name: "audit-trail.csv", content: vendorRepository.toAuditCsv(audit) },
    { name: "import-summary.json", content: JSON.stringify({ importRunId: report.importRunId, fiscalYear: report.fiscalYear, summary: report.summary }, null, 2) },
    { name: "verification-summary.json", content: JSON.stringify(report.summary, null, 2) },
    { name: "evidence-metadata.csv", content: toEvidenceMetadataCsv(report) },
    { name: "tally-reconciliation.csv", content: toTallyReconciliationCsv(report) },
  ]);
}

module.exports = { createMSMEReport, getReport, listReports, toCsv, toXml, toPdfBuffer, toWorkbookBuffer, toExcludedCsv, toTallyReconciliationCsv, buildEvidenceBundle, buildSimpleZip, calculateReportRows, calculateExcludedRows, buildReportSchedules };
