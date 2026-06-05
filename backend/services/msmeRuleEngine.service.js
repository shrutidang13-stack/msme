const fs = require("fs");
const path = require("path");
const env = require("../config/env");

const RULE_PACK_PATH = path.resolve(process.cwd(), "docs/legal/rules/msme-compliance-rules.json");
const DEFAULT_ALLOWED_DAYS = 45;
const DEFAULT_NO_AGREEMENT_DAYS = 15;
const DEFAULT_BANK_RATE_PERCENT = 5.5;
const DEFAULT_ANNUAL_INTEREST_RATE = 0.165;
const ACTUAL_PAYMENT_RULE_1961 = "ITA-ACTUAL-PAYMENT-037";
const ACTUAL_PAYMENT_RULE_2025 = "ITA-2025-ACTUAL-PAYMENT-037";

function loadRulePack() {
  return JSON.parse(fs.readFileSync(RULE_PACK_PATH, "utf8"));
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizePercent(value, fallback = DEFAULT_BANK_RATE_PERCENT) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getConfiguredBankRatePercent() {
  return normalizePercent(env.msmeBankRatePercent, DEFAULT_BANK_RATE_PERCENT);
}

function getDefaultAnnualInterestRate(bankRatePercent = getConfiguredBankRatePercent()) {
  return normalizePercent(bankRatePercent, DEFAULT_BANK_RATE_PERCENT) * 3 / 100;
}

function fiscalYearStart(fiscalYear) {
  const match = String(fiscalYear || "").match(/^(\d{4})-(\d{2})$/);
  return match ? Number(match[1]) : 2025;
}

function taxBasisForFiscalYear(fiscalYear = "2025-26") {
  if (fiscalYearStart(fiscalYear) >= 2026) {
    return {
      applicableAct: "Income Tax Act, 2025",
      applicableSection: "Section 37(2)(g)",
      actualPaymentRuleId: ACTUAL_PAYMENT_RULE_2025,
    };
  }
  return {
    applicableAct: "Income Tax Act, 1961",
    applicableSection: "Section 43B(h)",
    actualPaymentRuleId: ACTUAL_PAYMENT_RULE_1961,
  };
}

function isVerifiedMSME(vendorMaster) {
  return Boolean(
    vendorMaster?.isMSME &&
    ["verified", "approved"].includes(vendorMaster?.udyamStatus)
  );
}

function allowedPaymentDays(vendor = {}) {
  const agreedDays = Number(vendor.agreedPaymentDays || vendor.vendorMaster?.agreedPaymentDays || 0);
  if (agreedDays > 0) return Math.min(agreedDays, DEFAULT_ALLOWED_DAYS);
  return DEFAULT_NO_AGREEMENT_DAYS;
}

function compoundMonthlyInterest(principal, delayDays, annualRate = getDefaultAnnualInterestRate()) {
  if (!principal || !delayDays || delayDays <= 0) return 0;
  const monthlyRate = annualRate / 12;
  const months = delayDays / 30;
  return roundMoney(principal * (Math.pow(1 + monthlyRate, months) - 1));
}

function parseDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(dateValue, days) {
  const date = parseDate(dateValue);
  if (!date) return "";
  const next = new Date(date);
  next.setDate(next.getDate() + Number(days || 0));
  return next.toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (!from || !to) return 0;
  return Math.max(Math.floor((to - from) / 86400000), 0);
}

function booleanish(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["true", "yes", "y", "1"].includes(value.trim().toLowerCase());
  return false;
}

function resolveAppointedDay(input = {}) {
  const verificationFlags = [];
  const agreedPaymentDays = Number(input.agreedPaymentDays || input.agreementCreditDays || input.vendorMaster?.agreedPaymentDays || 0);
  const hasAgreementEvidence = Boolean(
    input.agreementEvidence ||
    input.agreementEvidenceLink ||
    input.agreement_evidence_link ||
    input.vendorMaster?.agreementEvidenceLink
  );
  const hasWrittenAgreement = booleanish(input.hasWrittenAgreement ?? input.writtenAgreement) || hasAgreementEvidence || agreedPaymentDays > 0;
  const allowedPaymentDays = hasWrittenAgreement
    ? Math.min(agreedPaymentDays > 0 ? agreedPaymentDays : DEFAULT_ALLOWED_DAYS, DEFAULT_ALLOWED_DAYS)
    : DEFAULT_NO_AGREEMENT_DAYS;

  if (hasWrittenAgreement && agreedPaymentDays <= 0) {
    verificationFlags.push("AGREEMENT_DAYS_MISSING_45_DAY_CAP_USED");
  }
  if (!hasWrittenAgreement) {
    verificationFlags.push("NO_WRITTEN_AGREEMENT_15_DAY_RULE");
  }
  if (hasWrittenAgreement && agreedPaymentDays > DEFAULT_ALLOWED_DAYS) {
    verificationFlags.push("AGREEMENT_DAYS_CAPPED_AT_45");
  }

  const invoiceDate = input.invoiceDate || input.date || "";
  let baseDate = "";
  let baseDateSource = "";
  if (input.acceptanceDate) {
    baseDate = input.acceptanceDate;
    baseDateSource = "acceptance_date";
  } else if (input.deemedAcceptanceDate) {
    baseDate = input.deemedAcceptanceDate;
    baseDateSource = "deemed_acceptance_date";
  } else if (invoiceDate) {
    baseDate = invoiceDate;
    baseDateSource = "invoice_date_fallback";
    verificationFlags.push("ACCEPTANCE_DATE_MISSING_INVOICE_DATE_USED");
  } else {
    baseDateSource = "missing";
    verificationFlags.push("INVOICE_OR_ACCEPTANCE_DATE_MISSING");
  }

  const appointedDay = baseDate ? addDays(baseDate, allowedPaymentDays) : "";
  const interestStartDate = appointedDay ? addDays(appointedDay, 1) : "";

  return {
    baseDate,
    baseDateSource,
    acceptanceDate: input.acceptanceDate || "",
    deemedAcceptanceDate: input.deemedAcceptanceDate || "",
    invoiceDate,
    hasWrittenAgreement,
    agreedPaymentDays: agreedPaymentDays || "",
    allowedPaymentDays,
    appointedDay,
    dueDate: appointedDay,
    interestStartDate,
    verificationRequired: verificationFlags.some((flag) => flag !== "NO_WRITTEN_AGREEMENT_15_DAY_RULE"),
    verificationFlags,
  };
}

function dueDateForInvoice(invoice = {}, vendor = {}) {
  return resolveAppointedDay({
    ...vendor,
    ...invoice,
    agreedPaymentDays: invoice.agreedPaymentDays || vendor.agreedPaymentDays || vendor.vendorMaster?.agreedPaymentDays,
    agreementEvidence: invoice.agreementEvidence || vendor.agreementEvidence || vendor.vendorMaster?.agreementEvidenceLink,
    hasWrittenAgreement: invoice.hasWrittenAgreement ?? vendor.hasWrittenAgreement ?? vendor.vendorMaster?.writtenAgreementDefault,
  });
}

function calculateInvoiceInterest(invoice = {}, vendor = {}, options = {}) {
  const bankRatePercent = normalizePercent(options.bankRatePercent, getConfiguredBankRatePercent());
  const annualInterestRate = Number(options.annualInterestRate ?? getDefaultAnnualInterestRate(bankRatePercent));
  const due = dueDateForInvoice(invoice, vendor);
  const principal = Number(invoice.interestPrincipal ?? invoice.unpaidAmount ?? invoice.pendingAmount ?? invoice.amount ?? invoice.originalAmount ?? 0);
  const relevantDate = invoice.paymentDate || options.asOnDate || invoice.asOnDate;
  const delayDays = due.appointedDay && relevantDate ? daysBetween(due.appointedDay, relevantDate) : 0;
  const interest = compoundMonthlyInterest(principal, delayDays, annualInterestRate);
  return {
    ...due,
    principal: roundMoney(principal),
    paymentDate: invoice.paymentDate || "",
    interestStartDate: due.interestStartDate,
    delayDays,
    bankRatePercent,
    annualInterestRate,
    annualInterestRatePercent: roundMoney(annualInterestRate * 100),
    interest,
    isDelayed: delayDays > 0,
    verificationRequired: due.verificationRequired,
    verificationFlags: due.verificationFlags,
  };
}

function evaluateVendor(vendor, options = {}) {
  const rulePack = options.rulePack || loadRulePack();
  const taxBasis = taxBasisForFiscalYear(options.fiscalYear);
  const master = vendor.vendorMaster;
  const eligible = isVerifiedMSME(master);
  const daysOutstanding = Number(vendor.daysOutstanding || 0);
  const outstandingAmount = Number(vendor.outstandingAmount || 0);
  const maxDays = allowedPaymentDays(vendor);
  const delayDays = eligible ? Math.max(daysOutstanding - maxDays, 0) : 0;
  const isDelayed = delayDays > 0;
  const bankRatePercent = normalizePercent(options.bankRatePercent, getConfiguredBankRatePercent());
  const annualInterestRate = Number(options.annualInterestRate ?? getDefaultAnnualInterestRate(bankRatePercent));
  const interest = compoundMonthlyInterest(outstandingAmount, delayDays, annualInterestRate);
  const disallowed = isDelayed ? roundMoney(outstandingAmount) : 0;
  const taxImpact = isDelayed ? roundMoney(outstandingAmount * Number(options.taxRate || 0.25)) : 0;

  const appliedRules = [];
  const findings = [];

  if (eligible) {
    appliedRules.push("MSME-ELIGIBILITY-001");
    findings.push("Vendor is verified/approved as MSME in Vendor Master.");
  }

  if (eligible && isDelayed) {
    appliedRules.push(
      "MSME-PAYMENT-DUE-015",
      "MSME-INTEREST-016",
      "MSME-DISCLOSURE-022",
      "MSME-INTEREST-NONDEDUCTIBLE-023",
      taxBasis.actualPaymentRuleId
    );
    findings.push(`Outstanding exceeds ${maxDays} day MSMED Act payment limit by ${delayDays} days.`);
    findings.push("Principal is flagged for actual-payment disallowance review.");
    findings.push("Interest is computed with monthly rests at the configured MSME rate.");
  } else if (eligible) {
    findings.push(`Outstanding is within the ${maxDays} day MSMED Act payment limit.`);
  }

  return {
    eligible,
    isDelayed,
    allowedPaymentDays: maxDays,
    daysOutstanding,
    delayDays,
    interestRate: annualInterestRate,
    bankRatePercent,
    annualInterestRatePercent: roundMoney(annualInterestRate * 100),
    interestRateSource: "config",
    applicableAct: taxBasis.applicableAct,
    applicableSection: taxBasis.applicableSection,
    actualPaymentRuleId: taxBasis.actualPaymentRuleId,
    interest,
    disallowed,
    taxImpact,
    appliedRules,
    findings,
    legalBasis: appliedRules.map((ruleId) => {
      const rule = rulePack.rules.find((item) => item.id === ruleId);
      return {
        ruleId,
        name: rule?.name || ruleId,
        sourceRefs: rule?.sourceRefs || [],
      };
    }),
  };
}

module.exports = {
  DEFAULT_ALLOWED_DAYS,
  DEFAULT_NO_AGREEMENT_DAYS,
  DEFAULT_BANK_RATE_PERCENT,
  DEFAULT_ANNUAL_INTEREST_RATE,
  ACTUAL_PAYMENT_RULE_1961,
  ACTUAL_PAYMENT_RULE_2025,
  loadRulePack,
  isVerifiedMSME,
  evaluateVendor,
  compoundMonthlyInterest,
  resolveAppointedDay,
  dueDateForInvoice,
  calculateInvoiceInterest,
  getConfiguredBankRatePercent,
  getDefaultAnnualInterestRate,
  taxBasisForFiscalYear,
};
