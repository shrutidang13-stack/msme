const fs = require("fs");
const path = require("path");
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
const { isSundryCreditorRow } = require("../utils/sundryCreditor");

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
      return {
        vendorName: vendor.party,
        normalizedVendorName: vendor.normalizedVendorName,
        udyamNumber: vendor.vendorMaster.udyamNumber,
        enterpriseName: vendor.vendorMaster.enterpriseName,
        enterpriseType: vendor.vendorMaster.enterpriseType,
        panNumber: vendor.panNumber || vendor.vendorMaster?.panNumber || "",
        outstandingAmount: Number(vendor.ledgerOutstandingAmount ?? vendor.outstandingAmount ?? 0),
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
        interest: ruleResult.interest,
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

function createMSMEReport({ importRunId, fiscalYear, asOnDate, actor, bankRatePercent }) {
  const run = importRepository.getRun(importRunId);
  if (!run) throw new Error("Import run not found");
  if (run.status !== "completed") throw new Error("Import run is not completed");
  if (fiscalYear && fiscalYear !== run.fiscalYear) {
    throw new Error(`Import run fiscal year mismatch. Requested ${fiscalYear}, but run belongs to ${run.fiscalYear}.`);
  }

  const vouchers = importRepository.getAllLedgerVouchers(importRunId);
  const creditors = enrichCreditorsWithVoucherAging(
    enrichCreditors(importRepository.getCreditors(importRunId)),
    vouchers,
    asOnDate || run.asOn
  );
  const stats = buildVerificationSummary(creditors);

  const requestedBankRatePercent = bankRatePercent == null || bankRatePercent === "" ? NaN : Number(bankRatePercent);
  const effectiveBankRatePercent = Number.isFinite(requestedBankRatePercent) && requestedBankRatePercent >= 0
    ? requestedBankRatePercent
    : getConfiguredBankRatePercent();
  const annualInterestRate = getDefaultAnnualInterestRate(effectiveBankRatePercent);
  const taxBasis = taxBasisForFiscalYear(run.fiscalYear);
  const report = calculateReportRows(creditors, {
    fiscalYear: run.fiscalYear,
    bankRatePercent: effectiveBankRatePercent,
    annualInterestRate,
  });
  const excluded = calculateExcludedRows(creditors);
  const rulePack = loadRulePack();
  const activeCreditors = creditors.filter((row) => !isZeroActivity(row));
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
    selectedFinancialYear: run.fiscalYear,
    applicableAct: taxBasis.applicableAct,
    applicableSection: taxBasis.applicableSection,
    actualPaymentRuleId: taxBasis.actualPaymentRuleId,
    bankRatePercent: effectiveBankRatePercent,
    annualInterestRatePercent: Math.round(annualInterestRate * 10000) / 100,
    interestRateSource: "config",
    asOnDate: asOnDate || run.asOn,
    voucherSource: run.summary?.voucherSource || "",
    fallbackUsed: Boolean(run.summary?.fallbackUsed),
    creditorsImported: run.summary?.creditorsImported ?? creditors.length,
    importedCreditors: creditors.length,
    activeCreditorLedgers: activeCreditors.length,
    nonZeroOutstandingCreditors: nonZeroOutstandingCreditors.length,
    zeroOutstandingNotRequired: zeroOutstandingNotRequired.length,
    vouchersParsed: run.summary?.vouchersParsed ?? vouchers.length,
    vouchersPersisted: run.summary?.vouchersPersisted ?? vouchers.length,
    importedOutstanding: Math.round(creditors.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0) * 100) / 100,
    verifiedMSMEOutstanding: Math.round(creditors.filter(isReportableMSME).reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0) * 100) / 100,
    reportVendors: report.length,
    reportableMSME: report.length,
    excludedFromReport: excluded.length,
    excludedByReason,
    totalOutstanding: Math.round(report.reduce((sum, row) => sum + row.outstandingAmount, 0) * 100) / 100,
    totalDisallowed: Math.round(report.reduce((sum, row) => sum + row.disallowed, 0) * 100) / 100,
    totalTaxImpact: Math.round(report.reduce((sum, row) => sum + row.taxImpact, 0) * 100) / 100,
    totalInterest: Math.round(report.reduce((sum, row) => sum + row.interest, 0) * 100) / 100,
  };

  return reportRepository.createReport({
    importRunId,
    fiscalYear: run.fiscalYear,
    summary,
    report: { included: report, excluded },
    actor,
  });
}

function getReport(id) {
  return reportRepository.getReport(id);
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

module.exports = { createMSMEReport, getReport, listReports, toCsv, toXml, toExcludedCsv, toTallyReconciliationCsv, buildEvidenceBundle, calculateReportRows, calculateExcludedRows };
