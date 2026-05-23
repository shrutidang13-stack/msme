const {
  DEFAULT_ALLOWED_DAYS,
  getConfiguredBankRatePercent,
  getDefaultAnnualInterestRate,
  compoundMonthlyInterest,
} = require("./msmeRuleEngine.service");

function parseDate(value, fieldName) {
  const date = new Date(value || "");
  if (!value || Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.status = 400;
    throw error;
  }
  return date;
}

function daysBetween(fromDate, toDate) {
  return Math.max(Math.floor((toDate - fromDate) / 86400000), 0);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeAnnualRate(value) {
  if (value === "" || value == null) return getDefaultAnnualInterestRate();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    const error = new Error("annualInterestRate must be a non-negative number");
    error.status = 400;
    throw error;
  }
  return parsed > 1 ? parsed / 100 : parsed;
}

function calculateMSMEInterest(input = {}) {
  const principal = Number(input.principal);
  if (!Number.isFinite(principal) || principal <= 0) {
    const error = new Error("principal must be greater than 0");
    error.status = 400;
    throw error;
  }

  const invoiceDate = parseDate(input.invoiceDate, "invoiceDate");
  const asOnDate = parseDate(input.asOnDate || input.paymentDate, "asOnDate");
  const agreedDays = Number(input.agreedPaymentDays || 0);
  const allowedPaymentDays = agreedDays > 0 ? Math.min(agreedDays, DEFAULT_ALLOWED_DAYS) : DEFAULT_ALLOWED_DAYS;
  const daysOutstanding = daysBetween(invoiceDate, asOnDate);
  const delayDays = Math.max(daysOutstanding - allowedPaymentDays, 0);
  const annualInterestRate = normalizeAnnualRate(input.annualInterestRate);
  const bankRatePercent = getConfiguredBankRatePercent();
  const interest = compoundMonthlyInterest(principal, delayDays, annualInterestRate);

  return {
    vendorName: input.vendorName || "",
    principal: roundMoney(principal),
    invoiceDate: invoiceDate.toISOString().slice(0, 10),
    asOnDate: asOnDate.toISOString().slice(0, 10),
    daysOutstanding,
    allowedPaymentDays,
    delayDays,
    bankRatePercent,
    annualInterestRate,
    annualInterestRatePercent: roundMoney(annualInterestRate * 100),
    interest,
    totalPayable: roundMoney(principal + interest),
    isDelayed: delayDays > 0,
    legalNote: delayDays > 0
      ? "MSME delayed-payment interest is calculated with monthly rests after the allowed payment period."
      : "No MSME delayed-payment interest applies because the invoice is within the allowed payment period.",
  };
}

module.exports = {
  calculateMSMEInterest,
};
