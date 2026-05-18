const importRepository = require("../repositories/importRepository");
const reportRepository = require("../repositories/reportRepository");
const vendorRepository = require("../repositories/vendorRepository");
const { buildVerificationSummary, enrichCreditors } = require("./tallyImport.service");
const { evaluateVendor, loadRulePack } = require("./msmeRuleEngine.service");
const { enrichCreditorsWithVoucherAging } = require("./payableAging.service");
const { validateUdyamNumber } = require("./udyamVerifier.service");

function isReportableMSME(vendor) {
  return Boolean(
    vendor.vendorMaster?.isMSME &&
    ["verified", "approved"].includes(vendor.vendorMaster?.udyamStatus) &&
    validateUdyamNumber(vendor.vendorMaster?.udyamNumber)
  );
}

function calculateReportRows(creditors) {
  const rulePack = loadRulePack();
  return creditors
    .filter((vendor) => {
      return isReportableMSME(vendor) && evaluateVendor(vendor, { rulePack }).eligible;
    })
    .map((vendor) => {
      const ruleResult = evaluateVendor(vendor, { rulePack });
      return {
        vendorName: vendor.party,
        normalizedVendorName: vendor.normalizedVendorName,
        udyamNumber: vendor.vendorMaster.udyamNumber,
        enterpriseName: vendor.vendorMaster.enterpriseName,
        enterpriseType: vendor.vendorMaster.enterpriseType,
        outstandingAmount: vendor.outstandingAmount,
        daysOutstanding: vendor.daysOutstanding,
        allowedPaymentDays: ruleResult.allowedPaymentDays,
        delayDays: ruleResult.delayDays,
        bucket: vendor.bucket,
        oldestInvoiceDate: vendor.oldestInvoiceDate,
        isDelayed: ruleResult.isDelayed,
        disallowed: ruleResult.disallowed,
        interest: ruleResult.interest,
        interestRate: ruleResult.interestRate,
        taxImpact: ruleResult.taxImpact,
        appliedRules: ruleResult.appliedRules,
        findings: ruleResult.findings,
        legalBasis: ruleResult.legalBasis,
      };
    });
}

function exclusionReason(vendor) {
  const master = vendor.vendorMaster;
  if (!master) return "not verified";
  if (master.udyamStatus === "manual_fallback_required") return "Udyam manual review required";
  if (master.udyamStatus === "pending_manual_review") return "Udyam proof pending review";
  if (master.udyamStatus === "rejected") return "Udyam proof pending/rejected";
  if (!["verified", "approved"].includes(master.udyamStatus)) return "not verified";
  if (!master.isMSME) return "not verified";
  if (!validateUdyamNumber(master.udyamNumber)) return "invalid Udyam number";
  return "";
}

function calculateExcludedRows(creditors) {
  return creditors
    .map((vendor) => ({ vendor, reason: exclusionReason(vendor) }))
    .filter((row) => row.reason)
    .map(({ vendor, reason }) => ({
      vendorName: vendor.party,
      normalizedVendorName: vendor.normalizedVendorName,
      udyamNumber: vendor.vendorMaster?.udyamNumber || "",
      udyamStatus: vendor.vendorMaster?.udyamStatus || "not_started",
      outstandingAmount: vendor.outstandingAmount,
      daysOutstanding: vendor.daysOutstanding,
      reason,
    }));
}

function createMSMEReport({ importRunId, fiscalYear, actor }) {
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
    run.asOn
  );
  const stats = buildVerificationSummary(creditors);

  const report = calculateReportRows(creditors);
  const excluded = calculateExcludedRows(creditors);
  const rulePack = loadRulePack();
  const summary = {
    ...stats,
    rulePackVersion: rulePack.version,
    selectedFinancialYear: run.fiscalYear,
    voucherSource: run.summary?.voucherSource || "",
    fallbackUsed: Boolean(run.summary?.fallbackUsed),
    creditorsImported: run.summary?.creditorsImported ?? creditors.length,
    vouchersParsed: run.summary?.vouchersParsed ?? vouchers.length,
    vouchersPersisted: run.summary?.vouchersPersisted ?? vouchers.length,
    reportVendors: report.length,
    excludedFromReport: excluded.length,
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
  csv += "\nVendor Name,Udyam No,Enterprise Name,Enterprise Type,Outstanding Amount,Days Outstanding,Allowed Days,Delay Days,Bucket,Delayed?,Disallowed Amount,Tax Impact @25%,Interest,Applied Rules,Findings\n";
  for (const row of report.report) {
    csv += `"${row.vendorName}","${row.udyamNumber}","${row.enterpriseName}","${row.enterpriseType}","${row.outstandingAmount.toFixed(2)}","${row.daysOutstanding ?? "N/A"}","${row.allowedPaymentDays}","${row.delayDays}","${row.bucket}","${row.isDelayed ? "YES" : "NO"}","${row.disallowed.toFixed(2)}","${row.taxImpact.toFixed(2)}","${row.interest.toFixed(2)}","${(row.appliedRules || []).join(" | ")}","${(row.findings || []).join(" | ")}"\n`;
  }
  if (report.excluded?.length) {
    csv += "\nExcluded Vendors\n";
    csv += "Vendor Name,Udyam No,Udyam Status,Outstanding Amount,Reason\n";
    for (const row of report.excluded) {
      csv += `"${row.vendorName}","${row.udyamNumber}","${row.udyamStatus}","${row.outstandingAmount.toFixed(2)}","${row.reason}"\n`;
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
      <UdyamNumber>${escapeXml(row.udyamNumber)}</UdyamNumber>
      <EnterpriseName>${escapeXml(row.enterpriseName)}</EnterpriseName>
      <EnterpriseType>${escapeXml(row.enterpriseType)}</EnterpriseType>
      <OutstandingAmount>${escapeXml(row.outstandingAmount)}</OutstandingAmount>
      <DaysOutstanding>${escapeXml(row.daysOutstanding)}</DaysOutstanding>
      <AllowedPaymentDays>${escapeXml(row.allowedPaymentDays)}</AllowedPaymentDays>
      <DelayDays>${escapeXml(row.delayDays)}</DelayDays>
      <Delayed>${row.isDelayed ? "YES" : "NO"}</Delayed>
      <DisallowedAmount>${escapeXml(row.disallowed)}</DisallowedAmount>
      <TaxImpact>${escapeXml(row.taxImpact)}</TaxImpact>
      <Interest>${escapeXml(row.interest)}</Interest>
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
      <UdyamNumber>${escapeXml(row.udyamNumber)}</UdyamNumber>
      <UdyamStatus>${escapeXml(row.udyamStatus)}</UdyamStatus>
      <Reason>${escapeXml(row.reason)}</Reason>
    </ExcludedVendor>`).join("\n")}
  </ExcludedVendors>
</MSMEGuardReport>`;
}

module.exports = { createMSMEReport, getReport, listReports, toCsv, toXml, calculateReportRows, calculateExcludedRows };
