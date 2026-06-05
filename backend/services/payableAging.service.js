const { normalizeVendorName } = require("../utils/normalizeVendorName");
const {
  calculateInvoiceInterest,
  compoundMonthlyInterest,
  getDefaultAnnualInterestRate,
  getConfiguredBankRatePercent,
  resolveAppointedDay,
} = require("./msmeRuleEngine.service");

const DEFAULT_ALLOWED_DAYS = 45;
const DEFAULT_NO_AGREEMENT_DAYS = 15;

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

function addDays(value, days) {
  const date = parseDate(value);
  if (!date) return "";
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function bucketForDays(days) {
  if (days == null) return "Unknown";
  if (days <= 30) return "0-30 days";
  if (days <= 45) return "31-45 days";
  if (days <= 60) return "46-60 days";
  if (days <= 90) return "61-90 days";
  return "90+ days";
}

function normalizeRef(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
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

function buildPayableAgingFromVouchers(vouchers = [], asOn, options = {}) {
  const allowedDays = Number(options.allowedDays || DEFAULT_NO_AGREEMENT_DAYS);
  const asOnDate = asOn || new Date().toISOString().split("T")[0];
  const vendorTerms = options.vendorTerms || new Map();
  const bankRatePercent = Number(options.bankRatePercent ?? getConfiguredBankRatePercent());
  const annualInterestRate = Number(options.annualInterestRate ?? getDefaultAnnualInterestRate(bankRatePercent));
  const byVendor = new Map();

  const ensureVendor = (row) => {
    const normalizedVendorName = row.normalizedVendorName || row.normalizedLedgerName || normalizeVendorName(row.vendorName || row.ledgerName);
    if (!normalizedVendorName) return null;
    if (!byVendor.has(normalizedVendorName)) {
      byVendor.set(normalizedVendorName, {
        vendorName: row.vendorName || row.ledgerName,
        normalizedVendorName,
        agreedPaymentDays: Number(vendorTerms.get(normalizedVendorName) || 0),
        invoices: [],
        payments: [],
      });
    }
    return byVendor.get(normalizedVendorName);
  };

  for (const row of vouchers) {
    const vendor = ensureVendor(row);
    if (!vendor || !row.date) continue;
    const amount = voucherAmount(row);
    if (!amount) continue;
    const kind = voucherKind(row);
    const billReference = normalizeRef(row.billReference || row.voucherNumber);
    if (kind === "invoice") {
      const raw = row.raw || {};
      const rowAgreedDays = Number(row.agreedPaymentDays || raw.agreedPaymentDays || 0);
      const vendorAgreedDays = Number(vendor.agreedPaymentDays || 0);
      const rawHasAgreementFlag = Object.prototype.hasOwnProperty.call(raw, "hasWrittenAgreement");
      const explicitNoAgreement = rawHasAgreementFlag && raw.hasWrittenAgreement === false;
      const hasInvoiceAgreementEvidence = Boolean(
        row.hasWrittenAgreement === true ||
        raw.hasWrittenAgreement === true ||
        rowAgreedDays > 0 ||
        row.agreementEvidence ||
        raw.agreementEvidence
      );
      const hasWrittenAgreement = !explicitNoAgreement && Boolean(hasInvoiceAgreementEvidence || vendorAgreedDays > 0);
      const effectiveAgreedDays = hasWrittenAgreement
        ? (rowAgreedDays || vendorAgreedDays)
        : 0;
      const appointed = resolveAppointedDay({
        invoiceDate: row.invoiceDate || row.date,
        acceptanceDate: row.acceptanceDate || raw.acceptanceDate || "",
        deemedAcceptanceDate: row.deemedAcceptanceDate || raw.deemedAcceptanceDate || "",
        hasWrittenAgreement,
        agreedPaymentDays: effectiveAgreedDays,
        agreementEvidence: row.agreementEvidence || raw.agreementEvidence || "",
      });
      vendor.invoices.push({
        voucherId: row.id || "",
        date: row.date,
        invoiceDate: row.invoiceDate || row.date,
        acceptanceDate: appointed.baseDate,
        deemedAcceptanceDate: row.deemedAcceptanceDate || raw.deemedAcceptanceDate || "",
        acceptanceDateSource: appointed.baseDateSource,
        voucherNumber: row.voucherNumber || "",
        invoiceNumber: row.invoiceNumber || row.billReference || row.voucherNumber || "",
        voucherType: row.voucherType || "",
        billReference,
        originalAmount: amount,
        pendingAmount: amount,
        paidAmount: 0,
        paymentApplications: [],
        hasWrittenAgreement,
        agreementEvidence: row.agreementEvidence || raw.agreementEvidence || "",
        agreedPaymentDays: effectiveAgreedDays,
        allowedPaymentDays: appointed.allowedPaymentDays,
        appointedDay: appointed.appointedDay,
        interestStartDate: appointed.interestStartDate,
        verificationRequired: appointed.verificationRequired,
        verificationFlags: appointed.verificationFlags,
        source: row.voucherSource || "Day Book",
        evidenceReference: row.id || row.voucherNumber || billReference || "",
      });
    } else if (kind === "payment") {
      vendor.payments.push({
        voucherId: row.id || "",
        date: row.date,
        voucherNumber: row.voucherNumber || "",
        billReference,
        amount,
        unappliedAmount: amount,
        source: row.voucherSource || "Day Book",
      });
    }
  }

  const summaries = [];
  for (const vendor of byVendor.values()) {
    vendor.invoices.sort((a, b) => new Date(a.date) - new Date(b.date));
    vendor.payments.sort((a, b) => new Date(a.date) - new Date(b.date));

    for (const payment of vendor.payments) {
      if (payment.billReference) {
        for (const invoice of vendor.invoices) {
          if (payment.unappliedAmount <= 0) break;
          if (!invoice.billReference || invoice.billReference !== payment.billReference || invoice.pendingAmount <= 0) continue;
          const applied = Math.min(invoice.pendingAmount, payment.unappliedAmount);
          invoice.pendingAmount = roundMoney(invoice.pendingAmount - applied);
          invoice.paidAmount = roundMoney(invoice.paidAmount + applied);
          invoice.paymentApplications.push({
            paymentVoucherId: payment.voucherId,
            paymentVoucherNumber: payment.voucherNumber,
            paymentDate: payment.date,
            amount: applied,
          });
          payment.unappliedAmount = roundMoney(payment.unappliedAmount - applied);
        }
      }

      for (const invoice of vendor.invoices) {
        if (payment.unappliedAmount <= 0) break;
        if (invoice.pendingAmount <= 0) continue;
        const applied = Math.min(invoice.pendingAmount, payment.unappliedAmount);
        invoice.pendingAmount = roundMoney(invoice.pendingAmount - applied);
        invoice.paidAmount = roundMoney(invoice.paidAmount + applied);
        invoice.paymentApplications.push({
          paymentVoucherId: payment.voucherId,
          paymentVoucherNumber: payment.voucherNumber,
          paymentDate: payment.date,
          amount: applied,
        });
        payment.unappliedAmount = roundMoney(payment.unappliedAmount - applied);
      }
    }

    const invoiceLines = vendor.invoices.map((invoice) => {
      const lastPayment = invoice.paymentApplications
        .slice()
        .sort((a, b) => new Date(a.paymentDate) - new Date(b.paymentDate))
        .at(-1);
      const isPaid = invoice.pendingAmount <= 0.009;
      const paymentDate = isPaid ? lastPayment?.paymentDate || "" : "";
      const relevantDate = paymentDate || asOnDate;
      const due = calculateInvoiceInterest(
        {
        ...invoice,
        amount: isPaid ? invoice.originalAmount : invoice.pendingAmount,
        unpaidAmount: isPaid ? invoice.originalAmount : invoice.pendingAmount,
        interestPrincipal: isPaid ? invoice.originalAmount : invoice.pendingAmount,
        paymentDate,
        asOnDate,
      },
        {
          agreedPaymentDays: invoice.hasWrittenAgreement ? invoice.agreedPaymentDays : 0,
          vendorMaster: { agreedPaymentDays: invoice.hasWrittenAgreement ? invoice.agreedPaymentDays : 0 },
        },
        { asOnDate, bankRatePercent, annualInterestRate }
      );
      const daysOutstanding = daysBetween(invoice.invoiceDate || invoice.date, relevantDate);
      const delayDays = due.delayDays;
      const exposure43Bh = !isPaid && delayDays > 0 ? invoice.pendingAmount : 0;
      const paidLateAmount = isPaid && delayDays > 0 ? invoice.originalAmount : 0;
      return {
        ...invoice,
        daysOutstanding,
        allowedPaymentDays: due.allowedPaymentDays,
        appointedDay: due.appointedDay,
        dueDate: due.appointedDay,
        interestStartDate: due.interestStartDate,
        baseDateSource: invoice.acceptanceDateSource || due.baseDateSource,
        paymentDate,
        isPaid,
        status: isPaid ? "paid" : "unpaid",
        principalAmount: invoice.originalAmount,
        delayDays,
        overdue: delayDays > 0,
        paidLate: paidLateAmount > 0,
        unpaidDelayed: exposure43Bh > 0,
        exposure43Bh: roundMoney(exposure43Bh),
        paidLateAmount: roundMoney(paidLateAmount),
        interest: due.interest,
        bankRatePercent: due.bankRatePercent,
        annualInterestRatePercent: due.annualInterestRatePercent,
        verificationRequired: Boolean(invoice.verificationRequired || due.verificationRequired),
        verificationFlags: Array.from(new Set([...(invoice.verificationFlags || []), ...(due.verificationFlags || [])])),
      };
    });

    const pendingInvoices = invoiceLines.filter((invoice) => invoice.pendingAmount > 0);
    const paidLateInvoices = invoiceLines.filter((invoice) => invoice.paidLate);
    const delayedInvoices = invoiceLines.filter((invoice) => invoice.overdue);

    const oldest = pendingInvoices[0] || null;
    const outstandingAmount = roundMoney(pendingInvoices.reduce((sum, invoice) => sum + invoice.pendingAmount, 0));
    const exposure43Bh = roundMoney(pendingInvoices.reduce((sum, invoice) => sum + invoice.exposure43Bh, 0));
    const paidLateAmount = roundMoney(paidLateInvoices.reduce((sum, invoice) => sum + invoice.paidLateAmount, 0));
    const interest = roundMoney(delayedInvoices.reduce((sum, invoice) => sum + invoice.interest, 0));
    summaries.push({
      vendorName: vendor.vendorName,
      normalizedVendorName: vendor.normalizedVendorName,
      agreedPaymentDays: vendor.agreedPaymentDays,
      outstandingAmount,
      daysOutstanding: oldest?.daysOutstanding ?? null,
      bucket: bucketForDays(oldest?.daysOutstanding),
      delayed: exposure43Bh > 0 || paidLateAmount > 0,
      oldestInvoiceDate: oldest?.date || "",
      pendingInvoiceCount: pendingInvoices.length,
      paidLateInvoiceCount: paidLateInvoices.length,
      delayedInvoiceCount: delayedInvoices.length,
      invoiceCount: vendor.invoices.length,
      paymentCount: vendor.payments.length,
      exposure43Bh,
      paidLateAmount,
      interest,
      invoices: pendingInvoices,
      allInvoices: invoiceLines,
      paidLateInvoices,
      delayedInvoices,
    });
  }

  return summaries;
}

function enrichCreditorsWithVoucherAging(creditors = [], vouchers = [], asOn, options = {}) {
  const vendorTerms = new Map(creditors.map((creditor) => [
    creditor.normalizedVendorName || normalizeVendorName(creditor.party || creditor.name),
    Number(creditor.agreedPaymentDays || creditor.vendorMaster?.agreedPaymentDays || 0),
  ]));
  const agingRows = buildPayableAgingFromVouchers(vouchers, asOn, { ...options, vendorTerms });
  const agingByVendor = new Map(agingRows.map((row) => [row.normalizedVendorName, row]));
  return creditors.map((creditor) => {
    const normalizedVendorName = creditor.normalizedVendorName || normalizeVendorName(creditor.party || creditor.name);
    const aging = agingByVendor.get(normalizedVendorName);
    if (!aging) {
      return options.preferVoucherOutstanding
        ? { ...creditor, outstandingAmount: 0, ledgerOutstandingAmount: roundMoney(creditor.outstandingAmount), voucherOutstandingAmount: 0, voucherCount: 0, payableAging: null }
        : { ...creditor, payableAging: null };
    }
    const ledgerOutstandingAmount = roundMoney(creditor.outstandingAmount);
    const voucherOutstandingAmount = roundMoney(aging.outstandingAmount);
    const effectiveOutstandingAmount = options.preferVoucherOutstanding ? voucherOutstandingAmount : ledgerOutstandingAmount;
    const outstandingMismatch = Math.abs(ledgerOutstandingAmount - voucherOutstandingAmount) >= 0.01;
    const mismatchReason = outstandingMismatch
      ? "Ledger closing balance differs from voucher-only outstanding"
      : "";
    return {
      ...creditor,
      outstandingAmount: effectiveOutstandingAmount,
      ledgerOutstandingAmount,
      voucherOutstandingAmount,
      outstandingMismatch,
      mismatchReason,
      daysOutstanding: aging.daysOutstanding,
      bucket: aging.bucket,
      delayed: aging.delayed,
      disallowanceAmount: aging.exposure43Bh,
      oldestInvoiceDate: aging.oldestInvoiceDate,
      payableAging: {
        ...aging,
        ledgerOutstandingAmount,
        voucherOutstandingAmount,
        outstandingMismatch,
        mismatchReason,
      },
    };
  });
}

module.exports = {
  buildPayableAgingFromVouchers,
  enrichCreditorsWithVoucherAging,
  bucketForDays,
};
