const { normalizeVendorName } = require("../utils/normalizeVendorName");

const DEFAULT_ALLOWED_DAYS = 45;

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
  const allowedDays = Number(options.allowedDays || DEFAULT_ALLOWED_DAYS);
  const asOnDate = asOn || new Date().toISOString().split("T")[0];
  const byVendor = new Map();

  const ensureVendor = (row) => {
    const normalizedVendorName = row.normalizedVendorName || row.normalizedLedgerName || normalizeVendorName(row.vendorName || row.ledgerName);
    if (!normalizedVendorName) return null;
    if (!byVendor.has(normalizedVendorName)) {
      byVendor.set(normalizedVendorName, {
        vendorName: row.vendorName || row.ledgerName,
        normalizedVendorName,
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
      vendor.invoices.push({
        voucherId: row.id || "",
        date: row.date,
        voucherNumber: row.voucherNumber || "",
        voucherType: row.voucherType || "",
        billReference,
        originalAmount: amount,
        pendingAmount: amount,
        paidAmount: 0,
        source: row.voucherSource || "Day Book",
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
          payment.unappliedAmount = roundMoney(payment.unappliedAmount - applied);
        }
      }

      for (const invoice of vendor.invoices) {
        if (payment.unappliedAmount <= 0) break;
        if (invoice.pendingAmount <= 0) continue;
        const applied = Math.min(invoice.pendingAmount, payment.unappliedAmount);
        invoice.pendingAmount = roundMoney(invoice.pendingAmount - applied);
        invoice.paidAmount = roundMoney(invoice.paidAmount + applied);
        payment.unappliedAmount = roundMoney(payment.unappliedAmount - applied);
      }
    }

    const pendingInvoices = vendor.invoices
      .filter((invoice) => invoice.pendingAmount > 0)
      .map((invoice) => {
        const daysOutstanding = daysBetween(invoice.date, asOnDate);
        const delayDays = Math.max((daysOutstanding || 0) - allowedDays, 0);
        return {
          ...invoice,
          daysOutstanding,
          delayDays,
          overdue: delayDays > 0,
          exposure43Bh: delayDays > 0 ? invoice.pendingAmount : 0,
        };
      });

    const oldest = pendingInvoices[0] || null;
    const outstandingAmount = roundMoney(pendingInvoices.reduce((sum, invoice) => sum + invoice.pendingAmount, 0));
    const exposure43Bh = roundMoney(pendingInvoices.reduce((sum, invoice) => sum + invoice.exposure43Bh, 0));
    summaries.push({
      vendorName: vendor.vendorName,
      normalizedVendorName: vendor.normalizedVendorName,
      outstandingAmount,
      daysOutstanding: oldest?.daysOutstanding ?? null,
      bucket: bucketForDays(oldest?.daysOutstanding),
      delayed: exposure43Bh > 0,
      oldestInvoiceDate: oldest?.date || "",
      pendingInvoiceCount: pendingInvoices.length,
      invoiceCount: vendor.invoices.length,
      paymentCount: vendor.payments.length,
      exposure43Bh,
      invoices: pendingInvoices,
    });
  }

  return summaries;
}

function enrichCreditorsWithVoucherAging(creditors = [], vouchers = [], asOn) {
  const agingRows = buildPayableAgingFromVouchers(vouchers, asOn);
  const agingByVendor = new Map(agingRows.map((row) => [row.normalizedVendorName, row]));
  return creditors.map((creditor) => {
    const normalizedVendorName = creditor.normalizedVendorName || normalizeVendorName(creditor.party || creditor.name);
    const aging = agingByVendor.get(normalizedVendorName);
    if (!aging) return { ...creditor, payableAging: null };
    return {
      ...creditor,
      outstandingAmount: aging.outstandingAmount,
      daysOutstanding: aging.daysOutstanding,
      bucket: aging.bucket,
      delayed: aging.delayed,
      disallowanceAmount: aging.exposure43Bh,
      oldestInvoiceDate: aging.oldestInvoiceDate,
      payableAging: aging,
    };
  });
}

module.exports = {
  buildPayableAgingFromVouchers,
  enrichCreditorsWithVoucherAging,
  bucketForDays,
};
