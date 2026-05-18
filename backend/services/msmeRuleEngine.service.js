const fs = require("fs");
const path = require("path");

const RULE_PACK_PATH = path.resolve(process.cwd(), "docs/legal/rules/msme-compliance-rules.json");
const DEFAULT_ALLOWED_DAYS = 45;
const DEFAULT_ANNUAL_INTEREST_RATE = 0.195;

function loadRulePack() {
  return JSON.parse(fs.readFileSync(RULE_PACK_PATH, "utf8"));
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
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
  return DEFAULT_ALLOWED_DAYS;
}

function compoundMonthlyInterest(principal, delayDays, annualRate = DEFAULT_ANNUAL_INTEREST_RATE) {
  if (!principal || !delayDays || delayDays <= 0) return 0;
  const monthlyRate = annualRate / 12;
  const months = delayDays / 30;
  return roundMoney(principal * (Math.pow(1 + monthlyRate, months) - 1));
}

function evaluateVendor(vendor, options = {}) {
  const rulePack = options.rulePack || loadRulePack();
  const master = vendor.vendorMaster;
  const eligible = isVerifiedMSME(master);
  const daysOutstanding = Number(vendor.daysOutstanding || 0);
  const outstandingAmount = Number(vendor.outstandingAmount || 0);
  const maxDays = allowedPaymentDays(vendor);
  const delayDays = eligible ? Math.max(daysOutstanding - maxDays, 0) : 0;
  const isDelayed = delayDays > 0;
  const annualInterestRate = Number(options.annualInterestRate || DEFAULT_ANNUAL_INTEREST_RATE);
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
      "ITA-ACTUAL-PAYMENT-037"
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
  DEFAULT_ANNUAL_INTEREST_RATE,
  loadRulePack,
  isVerifiedMSME,
  evaluateVendor,
  compoundMonthlyInterest,
};
