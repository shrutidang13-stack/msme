const {
  compactMoney,
  getReportOrThrow,
  reportRows,
  totalDelayedPrincipal,
  totalInterest,
} = require("./complianceData.service");
const { buildPaymentRecommendations } = require("./paymentRecommendation.service");

const DISCLAIMER = "This explanation is generated from computed report data and should be reviewed by a professional before filing.";

function vendorLine(row) {
  return `${row.vendorName}: Udyam ${row.udyamNumber || "not available"}, ${compactMoney(row.ledgerOutstandingAmount ?? row.outstandingAmount)} outstanding, ${compactMoney(row.disallowed || row.principalDisallowance43Bh)} disallowance, ${compactMoney(row.interest || row.interestDisallowanceSection23)} interest.`;
}

function explanationFor(report, type = "client", filters = {}) {
  const rows = reportRows(report);
  const selectedVendor = filters.vendorName
    ? rows.find((row) => String(row.vendorName || "").toLowerCase().includes(String(filters.vendorName).toLowerCase()))
    : null;
  const targetRows = selectedVendor ? [selectedVendor] : rows.slice(0, 5);
  const recommendations = buildPaymentRecommendations(report).recommendations.slice(0, 5);
  const heading = {
    client: "Client Explanation",
    auditor: "Auditor Explanation",
    tax_impact: "Tax Impact Explanation",
    mca_impact: "MCA Filing Impact Explanation",
  }[type] || "Compliance Explanation";

  const lines = [
    heading,
    "",
    `Report ${report.id} covers FY ${report.fiscalYear} with ${rows.length} reportable MSME vendor(s).`,
    `Delayed principal exposure is ${compactMoney(totalDelayedPrincipal(report))}. MSMED Section 16 interest exposure is ${compactMoney(totalInterest(report))}.`,
    "",
    "Why vendors are included:",
    ...(targetRows.length ? targetRows.map(vendorLine) : ["No reportable MSME vendors are available in this report."]),
    "",
    "Why delay/interest/disallowance appears:",
    "The report uses computed invoice or ledger-aging data. Where the statutory payment period is exceeded, delayed principal is flagged for Section 43B(h) / actual-payment disallowance and interest is computed with monthly rests at the configured MSME rate.",
    "",
    "MCA MSME-1 impact:",
    `${report.schedules?.mcaMsmeForm1Data?.length || 0} MCA MSME-1 row(s) are available from the report schedules. Vendors with outstanding or paid-late exposure may need MCA reporting based on the selected half-year.`,
    "",
    "Suggested corrective action:",
    ...(recommendations.length
      ? recommendations.map((row) => `${row.priorityRank}. ${row.vendorName} - ${row.priority}: ${row.recommendedAction}`)
      : ["No payment recommendation rows are available."]),
    "",
    DISCLAIMER,
  ];
  return {
    reportId: report.id,
    explanationType: type,
    outputText: lines.join("\n"),
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}

function explain(input = {}) {
  return explanationFor(getReportOrThrow(input.reportId), input.explanationType || input.type || "client", input);
}

module.exports = { explain, explanationFor, DISCLAIMER };
