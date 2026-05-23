const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const XLSX = require("xlsx");

process.env.DATABASE_PATH = "backend/data/test-msme-guard.sqlite";
process.env.DISABLE_BACKEND_AUTH = "true";

const { normalizeVendorName } = require("../utils/normalizeVendorName");
const { validateUdyamNumber } = require("../services/udyamVerifier.service");
const env = require("../config/env");
const {
  parseLedgerCollection,
  parseLedgerVouchers,
  parseVoucherCollection,
  computeFIFOAging,
  tallyHealth,
  fetchCreditors,
  fetchAllCreditorLedgerVouchers,
  buildPeriodBatches,
  buildLedgerCollectionXML,
  buildLedgerVouchersXML,
  buildVoucherObjectCollectionXML,
  parseCompanyNames,
  normalizeCompanyName,
  parseTallyProcessList,
  companyContextStatus,
} = require("../services/tally.service");
const { createMSMEReport, calculateExcludedRows, calculateReportRows, buildEvidenceBundle, toCsv, toTallyReconciliationCsv } = require("../services/report.service");
const { buildPayableAgingFromVouchers, enrichCreditorsWithVoucherAging } = require("../services/payableAging.service");
const { evaluateVendor, loadRulePack } = require("../services/msmeRuleEngine.service");
const { calculateMSMEInterest } = require("../services/interestCalculator.service");
const vendorRepository = require("../repositories/vendorRepository");
const purchaseInvoiceRepository = require("../repositories/purchaseInvoiceRepository");
const importRepository = require("../repositories/importRepository");
const reportRepository = require("../repositories/reportRepository");
const tallyImportService = require("../services/tallyImport.service");
const mcaMsme1Service = require("../services/mcaMsme1.service");
const db = require("../config/database");

function withMockTally(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => (error ? closeReject(error) : closeResolve()))),
      });
    });
    server.on("error", reject);
  });
}

async function runWithTallyPort(port, fn, options = {}) {
  const oldPort = env.tallyPort;
  const oldHost = env.tallyHost;
  const oldCompany = env.tallyCompanyName;
  const oldProcessCompany = process.env.TALLY_COMPANY_NAME;
  env.tallyPort = port;
  env.tallyHost = "localhost";
  env.tallyCompanyName = options.companyName === undefined ? "Test Company" : options.companyName;
  if (env.tallyCompanyName) process.env.TALLY_COMPANY_NAME = env.tallyCompanyName;
  else delete process.env.TALLY_COMPANY_NAME;
  try {
    return await fn();
  } finally {
    env.tallyPort = oldPort;
    env.tallyHost = oldHost;
    env.tallyCompanyName = oldCompany;
    if (oldProcessCompany == null) delete process.env.TALLY_COMPANY_NAME;
    else process.env.TALLY_COMPANY_NAME = oldProcessCompany;
  }
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

function sendXml(res, xml, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "text/xml" });
  res.end(xml);
}

function voucherXml({ ledgerName = "Acme Supplier", date = "20250501", number = "1", amount = "-1000.00", bill = "BILL-1" } = {}) {
  return `<VOUCHER VCHTYPE="Purchase"><DATE>${date}</DATE><VOUCHERNUMBER>${number}</VOUCHERNUMBER><PARTYLEDGERNAME>${ledgerName}</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledgerName}</LEDGERNAME><AMOUNT>${amount}</AMOUNT><BILLALLOCATIONS.LIST><NAME>${bill}</NAME><AMOUNT>${amount}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>`;
}

test("normalizes common legal suffixes and special characters", () => {
  assert.equal(normalizeVendorName("  Acme Pvt. Ltd. "), "ACME");
  assert.equal(normalizeVendorName("Bright-Star LLP"), "BRIGHT STAR");
  assert.equal(normalizeVendorName("A&B Private Limited"), "A AND B");
});

test("validates Udyam number format", () => {
  assert.equal(validateUdyamNumber("UDYAM-DL-01-1234567"), true);
  assert.equal(validateUdyamNumber("UDYAM-DL-1-1234567"), false);
  assert.equal(validateUdyamNumber("UDYAM-XX-00-0000000"), false);
  assert.equal(validateUdyamNumber("ABC"), false);
});

test("detects standard Sundry Creditors ledgers from all-ledger export", () => {
  const xml = `<ENVELOPE><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><CLOSINGBALANCE>1000.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 1);
  assert.equal(creditors[0].name, "Acme Supplier");
  assert.equal(creditors[0].outstandingAmount, 1000);
  assert.equal(creditors[0].closingBalance, -1000);
  assert.equal(creditors[0].closingBalanceType, "credit");
  assert.ok(creditors[0].detectionReasons.includes("creditor_parent_or_ancestor"));
});

test("detects Sundry Creditors ledgers even when List of Accounts omits balances", () => {
  const xml = `<ENVELOPE><LEDGER NAME="Balance Missing Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 1);
  assert.equal(creditors[0].name, "Balance Missing Supplier");
  assert.equal(creditors[0].outstandingAmount, 0);
  assert.ok(creditors[0].detectionReasons.includes("balance_unavailable_parent_match"));
});

test("detects custom creditor subgroups through group hierarchy", () => {
  const ledgerXml = `<ENVELOPE><LEDGER NAME="EV Vendor"><PARENT>EV Trade Vendors</PARENT><CLOSINGBALANCE>2500.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`;
  const groupXml = `<ENVELOPE><GROUP NAME="EV Trade Vendors"><PARENT>Sundry Creditors</PARENT></GROUP></ENVELOPE>`;
  const creditors = parseLedgerCollection(ledgerXml, "Sundry Creditors", groupXml);
  assert.equal(creditors.length, 1);
  assert.equal(creditors[0].name, "EV Vendor");
  assert.equal(creditors[0].outstandingAmount, 2500);
  assert.deepEqual(creditors[0].groupHierarchy, ["EV Trade Vendors", "Sundry Creditors"]);
});

test("excludes non-Sundry ledgers even when bill-wise or payable-like", () => {
  const xml = `<ENVELOPE>
    <LEDGER NAME="Purchase"><PARENT>Purchase Accounts</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="Purchase Import"><PARENT>Purchase Accounts</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="Prepaid Expenditure"><PARENT>Current Assets</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="SALARY To Employee"><PARENT>Current Liabilities</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="INPUT IGST"><PARENT>Duties & Taxes</PARENT><ISBILLWISEON>Yes</ISBILLWISEON><CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="Real Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>500.00 Cr</CLOSINGBALANCE></LEDGER>
  </ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.deepEqual(creditors.map((creditor) => creditor.name), ["Real Supplier"]);
});

test("excludes generic payable groups unless they are under Sundry Creditors", () => {
  const ledgerXml = `<ENVELOPE>
    <LEDGER NAME="Generic Payable"><PARENT>Trade Payables</PARENT><CLOSINGBALANCE>900.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="Child Payable"><PARENT>Trade Vendors</PARENT><CLOSINGBALANCE>800.00 Cr</CLOSINGBALANCE></LEDGER>
  </ENVELOPE>`;
  const groupXml = `<ENVELOPE><GROUP NAME="Trade Vendors"><PARENT>Sundry Creditors</PARENT></GROUP></ENVELOPE>`;
  const creditors = parseLedgerCollection(ledgerXml, "Sundry Creditors", groupXml);
  assert.deepEqual(creditors.map((creditor) => creditor.name), ["Child Payable"]);
});

test("excludes rows with missing group lineage", () => {
  const xml = `<ENVELOPE><LEDGER NAME="No Parent Supplier"><CLOSINGBALANCE>900.00 Cr</CLOSINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 0);
});

test("detects creditor parents with trailing spaces and mixed case", () => {
  const xml = `<ENVELOPE><LEDGER NAME="Messy Supplier"><PARENT>  sUnDrY   cReDiToRs  </PARENT><CLOSINGBALANCE>750.00 Cr</CLOSINGBALANCE></LEDGER></ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 1);
  assert.equal(creditors[0].outstandingAmount, 750);
});

test("excludes creditor ledgers with debit closing balance from outstanding creditors", () => {
  const xml = `<ENVELOPE>
    <LEDGER NAME="Credit Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>200.00 Dr</OPENINGBALANCE><CLOSINGBALANCE>1000.00 Cr</CLOSINGBALANCE></LEDGER>
    <LEDGER NAME="Debit Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>500.00 Cr</OPENINGBALANCE><CLOSINGBALANCE>250.00 Dr</CLOSINGBALANCE></LEDGER>
  </ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.deepEqual(creditors.map((creditor) => creditor.name), ["Credit Supplier"]);
  assert.equal(creditors[0].outstandingAmount, 1000);
  assert.equal(creditors[0].openingBalance, 200);
  assert.equal(creditors[0].openingBalanceType, "debit");
  assert.equal(creditors[0].closingBalance, -1000);
  assert.equal(creditors[0].closingBalanceType, "credit");
});

test("parses parenthesized and marker balances with debit credit types", () => {
  const xml = `<ENVELOPE>
    <LEDGER NAME="Paren Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>(125.50)</OPENINGBALANCE><CLOSINGBALANCE>250.25 Cr</CLOSINGBALANCE></LEDGER>
  </ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 1);
  assert.equal(creditors[0].openingBalance, 125.5);
  assert.equal(creditors[0].openingBalanceType, "debit");
  assert.equal(creditors[0].closingBalance, -250.25);
  assert.equal(creditors[0].outstandingAmount, 250.25);
});

test("detects ledger alias names when Tally omits NAME attribute", () => {
  const xml = `<ENVELOPE><LEDGER><NAME.LIST><NAME>Alias Supplier</NAME></NAME.LIST><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>400.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 1);
  assert.equal(creditors[0].name, "Alias Supplier");
});

test("returns empty creditor collection for non-creditor ledgers", () => {
  const xml = `<ENVELOPE><LEDGER NAME="Sales Account"><PARENT>Sales Accounts</PARENT><CLOSINGBALANCE>0.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`;
  const creditors = parseLedgerCollection(xml);
  assert.equal(creditors.length, 0);
});

test("parses ledger voucher rows with debit and credit columns", () => {
  const xml = `<ENVELOPE><VOUCHER VCHTYPE="Journal">
    <DATE>20250531</DATE>
    <VOUCHERNUMBER>417558218</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Accounting Charges</LEDGERNAME><AMOUNT>36000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Agreema Associates</LEDGERNAME><AMOUNT>-36000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER><VOUCHER VCHTYPE="Payment">
    <DATE>20251007</DATE>
    <VOUCHERNUMBER>1367</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Agreema Associates</LEDGERNAME><AMOUNT>100000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Axis Bank</LEDGERNAME><AMOUNT>-100000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER></ENVELOPE>`;
  const rows = parseLedgerVouchers(xml, "AGREEMA ASSOCIATES");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].credit, 36000);
  assert.equal(rows[0].particulars, "Accounting Charges");
  assert.equal(rows[1].debit, 100000);
  assert.equal(rows[1].particulars, "Axis Bank");
});

test("parses lightweight voucher collection rows with bill references", () => {
  const xml = `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", number: "V-1", amount: "-1200.00", bill: "AGST-1" })}</ENVELOPE>`;
  const rows = parseVoucherCollection(xml, ["Acme Supplier"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ledgerName, "Acme Supplier");
  assert.equal(rows[0].credit, 1200);
  assert.equal(rows[0].billReference, "AGST-1");
  assert.equal(rows[0].pendingAmount, 1200);
});

test("parses Day Book voucher rows when creditor amount is only in bill allocations", () => {
  const xml = `<ENVELOPE><VOUCHER VCHTYPE="Purchase">
    <DATE>20250502</DATE>
    <VOUCHERNUMBER>PB-1</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Acme Supplier</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Acme Supplier</LEDGERNAME>
      <BILLALLOCATIONS.LIST><NAME>INV-77</NAME><AMOUNT>-1400.00</AMOUNT></BILLALLOCATIONS.LIST>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER></ENVELOPE>`;
  const rows = parseVoucherCollection(xml, ["Acme Supplier"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2025-05-02");
  assert.equal(rows[0].voucherNumber, "PB-1");
  assert.equal(rows[0].voucherType, "Purchase");
  assert.equal(rows[0].ledgerName, "Acme Supplier");
  assert.equal(rows[0].credit, 1400);
  assert.equal(rows[0].billReference, "INV-77");
});

test("parses Day Book voucher rows from party ledger when Tally omits creditor ledger entry", () => {
  const xml = `<ENVELOPE><VOUCHER VCHTYPE="Journal">
    <DATE>20250503</DATE>
    <VOUCHERNUMBER>J-1</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Acme Supplier</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Purchase Expenses</LEDGERNAME>
      <AMOUNT>900.00</AMOUNT>
      <BILLALLOCATIONS.LIST><NAME>INV-88</NAME><AMOUNT>-900.00</AMOUNT></BILLALLOCATIONS.LIST>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER></ENVELOPE>`;
  const rows = parseVoucherCollection(xml, ["Acme Supplier"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ledgerName, "Acme Supplier");
  assert.equal(rows[0].voucherType, "Journal");
  assert.equal(rows[0].credit, 900);
  assert.equal(rows[0].billReference, "INV-88");
});

test("computes FIFO aging from purchases and payments", () => {
  const aging = computeFIFOAging(
    [{ party: "Acme", date: "2026-01-01", amount: 1000 }],
    [{ party: "Acme", date: "2026-01-10", amount: 200 }],
    "2026-03-01"
  );
  assert.equal(aging.Acme.daysOutstanding, 59);
  assert.equal(aging.Acme.bucket, "46-60 days");
});

test("builds financial-year voucher batches by quarter", () => {
  const batches = buildPeriodBatches("20250401", "20260331", 3);
  assert.deepEqual(batches.map((batch) => batch.label), ["Apr-Jun", "Jul-Sep", "Oct-Dec", "Jan-Mar"]);
  assert.equal(batches[0].from, "20250401");
  assert.equal(batches[3].to, "20260331");
});

test("export builders inject explicit SVCURRENTCOMPANY", () => {
  for (const xml of [
    buildLedgerCollectionXML("Acme & Sons"),
    buildLedgerVouchersXML("20250401", "20260331", "Supplier One", "Acme & Sons"),
  ]) {
    assert.match(xml, /<SVEXPORTFORMAT>\$\$SysName:XML<\/SVEXPORTFORMAT>/);
    assert.match(xml, /<SVCURRENTCOMPANY>Acme &amp; Sons<\/SVCURRENTCOMPANY>/);
  }
});

test("voucher collection export includes a Tally-side date filter", () => {
  const xml = buildVoucherObjectCollectionXML("20250401", "20250630", "Acme & Sons");
  assert.match(xml, /<SVCURRENTCOMPANY>Acme &amp; Sons<\/SVCURRENTCOMPANY>/);
  assert.match(xml, /<SVFROMDATE>20250401<\/SVFROMDATE>/);
  assert.match(xml, /<SVTODATE>20250630<\/SVTODATE>/);
  assert.match(xml, /<FILTERS>MSMEVoucherDateFilter<\/FILTERS>/);
  assert.match(xml, /\$Date &gt;= \$\$Date:"1-Apr-2025"/);
  assert.match(xml, /\$Date &lt;= \$\$Date:"30-Jun-2025"/);
});

test("parses company name from loaded company collection XML", () => {
  const names = parseCompanyNames(`<ENVELOPE><COMPANY NAME="Loaded Company"></COMPANY></ENVELOPE>`);
  assert.deepEqual(names, ["Loaded Company"]);
});

test("normalizes company names without changing the exact XML injection value", () => {
  assert.equal(
    normalizeCompanyName("  NXTMOBILITY   ENERGY PRIVATE LIMITED - (from 1-Apr-2023)  "),
    "NXTMOBILITY ENERGY PRIVATE LIMITED - (FROM 1-APR-2023)"
  );
  const xml = buildLedgerCollectionXML("  NXTMOBILITY   ENERGY PRIVATE LIMITED - (from 1-Apr-2023)  ");
  assert.match(xml, /<SVCURRENTCOMPANY>NXTMOBILITY   ENERGY PRIVATE LIMITED - \(from 1-Apr-2023\)<\/SVCURRENTCOMPANY>/);
});

test("Tally health returns explicit error when company context cannot be detected", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    await readRequestBody(req);
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth(), { companyName: "" });
    assert.equal(health.xmlPostWorking, false);
    assert.equal(health.companyDetected, false);
    assert.equal(health.error, "Tally XML export requires active company context.");
  } finally {
    await mock.close();
  }
});

test("Tally health selects first loaded company when multiple are loaded", async () => {
  const requests = [];
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    const body = await readRequestBody(req);
    requests.push(body);
    if (body.includes("Loaded Companies")) {
      return sendXml(res, `<ENVELOPE><COMPANY NAME="Alpha Traders"></COMPANY><COMPANY NAME="Beta Traders"></COMPANY></ENVELOPE>`);
    }
    assert.match(body, /<SVCURRENTCOMPANY>Alpha Traders<\/SVCURRENTCOMPANY>/);
    sendXml(res, `<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth(), { companyName: "" });
    assert.equal(health.xmlPostWorking, true);
    assert.equal(health.companyName, "Alpha Traders");
    assert.deepEqual(health.companyNames, ["Alpha Traders", "Beta Traders"]);
    assert.equal(health.companyDetectionMethod, "loaded_company_collection");
    assert.equal(requests.some((body) => body.includes("Loaded Companies")), true);
    assert.equal(requests.some((body) => body.includes("Gateway of Tally")), false);
  } finally {
    await mock.close();
  }
});

test("explicit request company override beats TALLY_COMPANY_NAME", async () => {
  const requests = [];
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    const body = await readRequestBody(req);
    requests.push(body);
    sendXml(res, `<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth({ companyName: "Explicit Co" }), { companyName: "Env Co" });
    assert.equal(health.xmlPostWorking, true);
    assert.equal(health.companyName, "Explicit Co");
    assert.equal(health.companyDetectionMethod, "request_override");
    assert.equal(requests.every((body) => body.includes("<SVCURRENTCOMPANY>Explicit Co</SVCURRENTCOMPANY>")), true);
  } finally {
    await mock.close();
  }
});

test("TALLY_COMPANY_NAME env override is injected into health export", async () => {
  const requests = [];
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    const body = await readRequestBody(req);
    requests.push(body);
    sendXml(res, `<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth(), { companyName: "Override Co" });
    assert.equal(health.xmlPostWorking, true);
    assert.equal(health.companyName, "Override Co");
    assert.equal(health.companyDetectionMethod, "env_override");
    assert.equal(requests.every((body) => body.includes("<SVCURRENTCOMPANY>Override Co</SVCURRENTCOMPANY>")), true);
  } finally {
    await mock.close();
  }
});

test("company context diagnostics reports configured suffix company as working", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    const body = await readRequestBody(req);
    assert.match(body, /<SVCURRENTCOMPANY>NXTMOBILITY ENERGY PRIVATE LIMITED - \(from 1-Apr-2023\)<\/SVCURRENTCOMPANY>/);
    sendXml(res, `<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const diagnostics = await runWithTallyPort(
      mock.port,
      () => companyContextStatus(),
      { companyName: "NXTMOBILITY ENERGY PRIVATE LIMITED - (from 1-Apr-2023)" }
    );
    assert.equal(diagnostics.companyContextWorking, true);
    assert.equal(diagnostics.configuredCompany, "NXTMOBILITY ENERGY PRIVATE LIMITED - (from 1-Apr-2023)");
    assert.equal(diagnostics.normalizedCompany, "NXTMOBILITY ENERGY PRIVATE LIMITED - (FROM 1-APR-2023)");
  } finally {
    await mock.close();
  }
});

test("Tally health does not mark XML POST working when LINEERROR exists", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    await readRequestBody(req);
    sendXml(res, "<ENVELOPE><LINEERROR>Could not find Company ''</LINEERROR></ENVELOPE>");
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.xmlPostWorking, false);
    assert.match(health.errors.join(" "), /Could not find Company/);
  } finally {
    await mock.close();
  }
});

test("Tally health retries variants when SVCurrentCompany cannot be set", async () => {
  const attempts = [];
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    const body = await readRequestBody(req);
    attempts.push(body.match(/<SVCURRENTCOMPANY>([^<]+)<\/SVCURRENTCOMPANY>/)?.[1] || "");
    if (attempts.length === 1) {
      return sendXml(res, "<ENVELOPE><LINEERROR>Could not set 'SVCurrentCompany'</LINEERROR></ENVELOPE>");
    }
    sendXml(res, `<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth(), { companyName: " Retry   Company " });
    assert.equal(health.xmlPostWorking, true);
    assert.deepEqual(attempts, ["Retry   Company", "Retry Company"]);
  } finally {
    await mock.close();
  }
});

test("parses multiple TallyPrime process diagnostics", () => {
  const output = [
    "Image Name                     PID Session Name        Session#    Mem Usage",
    "========================= ======== ================ =========== ============",
    "TallyPrime.exe                1112 Console                    1     80,000 K",
    "TallyPrime.exe                2211 Console                    1     82,000 K",
  ].join("\n");
  const processes = parseTallyProcessList(output);
  assert.equal(processes.length, 2);
  assert.deepEqual(processes.map((item) => item.pid), ["1112", "2211"]);
});

test("Tally health accepts TallyPrime server running ping response and standard List of Accounts export", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    assert.match(body, /<REPORTNAME>List of Accounts<\/REPORTNAME>/);
    assert.doesNotMatch(body, /<TYPE>System<\/TYPE>|<TYPE>Collection<\/TYPE>|MSME/);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.reachable, true);
    assert.equal(health.portOpen, true);
    assert.equal(health.serverRunning, true);
    assert.equal(health.xmlPostWorking, true);
    assert.equal(health.companyDetected, true);
    assert.equal(health.companyName, "Test Company");
    assert.equal(health.companyDetectionMethod, "env_override");
    assert.match(health.rawPingResponse, /TallyPrime Server is Running/);
  } finally {
    await mock.close();
  }
});

test("Tally health does not send unsupported Current Company system request", async () => {
  const requests = [];
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    const body = await readRequestBody(req);
    requests.push(body);
    sendXml(res, `<ENVELOPE><LEDGER NAME="Demo Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.xmlPostWorking, true);
    assert.equal(requests.some((body) => body.includes("<TYPE>System</TYPE>")), false);
    assert.equal(requests.every((body) => body.includes("List of Accounts")), true);
    assert.equal(requests.every((body) => body.includes("<SVCURRENTCOMPANY>Test Company</SVCURRENTCOMPANY>")), true);
  } finally {
    await mock.close();
  }
});

test("Tally health reports Unknown Request from standard export as XML failure", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    await readRequestBody(req);
    sendXml(res, "<RESPONSE>Unknown Request, cannot be processed</RESPONSE>");
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.xmlPostWorking, false);
    assert.match(health.errors.join(" "), /Unknown Request/);
  } finally {
    await mock.close();
  }
});

test("Tally health rejects CMPINFO-only empty collection response", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") return sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
    await readRequestBody(req);
    sendXml(res, "<ENVELOPE><BODY><DESC><CMPINFO><LEDGER>0</LEDGER><VOUCHER>0</VOUCHER></CMPINFO></DESC><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>");
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.xmlPostWorking, false);
    assert.match(health.errors.join(" "), /only metadata/);
  } finally {
    await mock.close();
  }
});

test("Tally health reports connection refused as port unreachable", async () => {
  const mock = await withMockTally((req, res) => res.end("unused"));
  const port = mock.port;
  await mock.close();
  const health = await runWithTallyPort(port, () => tallyHealth());
  assert.equal(health.reachable, false);
  assert.equal(health.portOpen, false);
  assert.equal(health.serverRunning, false);
  assert.match(health.message, /port 9000 is unreachable/i);
});

test("Tally health reports XML POST failure after successful GET", async () => {
  const mock = await withMockTally((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<RESPONSE>Tally Server is Running</RESPONSE>");
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("export failed");
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.reachable, true);
    assert.equal(health.portOpen, true);
    assert.equal(health.serverRunning, true);
    assert.equal(health.xmlPostWorking, false);
    assert.equal(health.error, "Tally server is reachable, but XML export request failed.");
    assert.doesNotMatch(health.message, /port.*unreachable/i);
  } finally {
    await mock.close();
  }
});

test("Tally health accepts valid XML export response", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<RESPONSE>Tally Server is Running</RESPONSE>");
      return;
    }
    await readRequestBody(req);
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(`<ENVELOPE><BODY><DATA><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>100.00</CLOSINGBALANCE></LEDGER></DATA></BODY></ENVELOPE>`);
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.xmlPostWorking, true);
    assert.equal(health.companyDetected, true);
    assert.equal(health.companyName, "Test Company");
    assert.equal(health.message, "Tally server is running");
    assert.equal(health.error, null);
  } finally {
    await mock.close();
  }
});

test("Tally health fails when List of Accounts returns empty collection metadata", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    await readRequestBody(req);
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end("<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>");
  });
  try {
    const health = await runWithTallyPort(mock.port, () => tallyHealth());
    assert.equal(health.reachable, true);
    assert.equal(health.serverRunning, true);
    assert.equal(health.xmlPostWorking, false);
    assert.equal(health.companyDetected, true);
    assert.equal(health.companyName, "Test Company");
    assert.equal(health.error, "Tally server is reachable, but XML export request failed.");
  } finally {
    await mock.close();
  }
});

test("Tally import does not fail when health message is Tally server is running", async () => {
  const seen = { creditorsExport: 0 };
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      seen.creditorsExport += 1;
      sendXml(res, `<ENVELOPE><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1000.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("Day Book")) {
      sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", number: "1" })}</ENVELOPE>`);
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2025-26",
        fromDate: "20250401",
        toDate: "20260331",
        actor: "unit-test",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.creditors.length, 1);
    assert.equal(result.importRun.status, "completed");
    assert.equal(seen.creditorsExport >= 2, true);
  } finally {
    await mock.close();
  }
});

test("Tally import health success continues to creditor fetch", async () => {
  let listOfAccountsRequests = 0;
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>Tally Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      listOfAccountsRequests += 1;
      sendXml(res, `<ENVELOPE><LEDGER NAME="Next Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>2500.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("Day Book") || body.includes("Ledger Vouchers")) {
      sendXml(res, "<ENVELOPE></ENVELOPE>");
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2025-26",
        fromDate: "20250401",
        toDate: "20260331",
        actor: "unit-test",
      })
    );
    assert.equal(listOfAccountsRequests >= 2, true);
  } finally {
    await mock.close();
  }
});

test("Tally import fails when XML POST health test fails", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    sendXml(res, "export failed", 500);
  });
  try {
    await assert.rejects(
      () => runWithTallyPort(mock.port, () =>
        tallyImportService.importFromTally({
          fiscalYear: "2025-26",
          fromDate: "20250401",
          toDate: "20260331",
          actor: "unit-test",
        })
      ),
      /Tally server is reachable, but XML export request failed/
    );
  } finally {
    await mock.close();
  }
});

test("Tally import rejects selected financial year date mismatch", async () => {
  await assert.rejects(
    () => tallyImportService.importFromTally({
      fiscalYear: "2026-27",
      fromDate: "20250401",
      toDate: "20260331",
      actor: "unit-test",
    }),
    /Selected financial year 2026-27 requires 20260401 to 20270331/
  );
});

test("Tally import uses creditor export success as company fallback", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Fallback Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>500.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("Day Book")) {
      sendXml(res, "<ENVELOPE></ENVELOPE>");
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2025-26",
        fromDate: "20250401",
        toDate: "20260331",
        actor: "unit-test",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.importRun.companyName, "Test Company");
    assert.equal(result.creditors.length, 1);
  } finally {
    await mock.close();
  }
});

test("Tally import ignores Group Summary failure when List of Accounts succeeded", async () => {
  let groupSummaryRequests = 0;
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Health Supplier"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>1.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("Group Summary")) {
      groupSummaryRequests += 1;
      sendXml(res, "<ENVELOPE><LINEERROR>Report export failed</LINEERROR></ENVELOPE>");
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2025-26",
        fromDate: "20250401",
        toDate: "20260331",
        actor: "unit-test",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.importRun.status, "completed");
    assert.equal(result.creditors.length, 1);
    assert.equal(groupSummaryRequests, 0);
  } finally {
    await mock.close();
  }
});

test("Tally import persists voucher rows and retrieves them for review", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("MSME Ledger Master Collection")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>100.00 Dr</OPENINGBALANCE><CLOSINGBALANCE>1400.00 Cr</CLOSINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("MSME Voucher Collection")) {
      sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", date: "20250502", number: "PB-77", amount: "-1400.00", bill: "INV-77" })}</ENVELOPE>`);
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2025-26",
        fromDate: "20250401",
        toDate: "20260331",
        actor: "unit-test",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.ledgerVoucherSummary.totalRows, 1);
    assert.equal(result.ledgerVoucherSummary.persistedRows, 1);

    const review = tallyImportService.getLedgerVouchers(result.importRun.id, {
      ledgerName: "All ledgers",
      voucherType: "All voucher types",
      limit: 10,
    });
    assert.equal(review.ledgerVouchers.total, 1);
    assert.equal(review.ledgerVouchers.rows.length, 1);
    assert.equal(review.ledgerVouchers.rows[0].importRunId, result.importRun.id);
    assert.equal(review.ledgerVouchers.rows[0].fiscalYear, "2025-26");
    assert.equal(review.ledgerVouchers.rows[0].companyName, "Test Company");
    assert.equal(review.ledgerVouchers.rows[0].vendorName, "Acme Supplier");
    assert.equal(review.ledgerVouchers.rows[0].date, "2025-05-02");
    assert.equal(review.ledgerVouchers.rows[0].voucherNumber, "PB-77");
    assert.equal(review.ledgerVouchers.rows[0].voucherType, "Purchase");
    assert.equal(review.ledgerVouchers.rows[0].credit, 1400);
    assert.equal(review.ledgerVouchers.rows[0].billReference, "INV-77");
    assert.equal(review.ledgerVouchers.rows[0].voucherSource, "Voucher Collection");
    assert.equal(result.importRun.summary.selectedFinancialYear, "2025-26");
    assert.equal(result.importRun.summary.voucherSource, "Voucher Collection");
    assert.equal(result.importRun.summary.fallbackUsed, false);
    assert.equal(result.importRun.summary.creditorsImported, 1);
    assert.equal(result.importRun.summary.vouchersParsed, 1);
    assert.equal(result.importRun.summary.vouchersPersisted, 1);
  } finally {
    await mock.close();
  }
});

test("Tally import fetches complete creditor ledger entries date-wise for review", async () => {
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(
        res,
        `<ENVELOPE>
          <LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
          <LEDGER NAME="Beta Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
        </ENVELOPE>`
      );
      return;
    }
    if (body.includes("MSME Ledger Master Collection")) {
      sendXml(
        res,
        `<ENVELOPE>
          <LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>50.00 Dr</OPENINGBALANCE><CLOSINGBALANCE>700.00 Cr</CLOSINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
          <LEDGER NAME="Beta Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>25.00 Cr</OPENINGBALANCE><CLOSINGBALANCE>300.00 Cr</CLOSINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
        </ENVELOPE>`
      );
      return;
    }
    if (body.includes("MSME Voucher Collection")) {
      const from = body.match(/<SVFROMDATE>([^<]+)<\/SVFROMDATE>/)?.[1] || "";
      if (from === "20250401") {
        sendXml(
          res,
          `<ENVELOPE>
            ${voucherXml({ ledgerName: "Acme Supplier", date: "20250401", number: "ACME-APR", amount: "-100.00", bill: "ACME-B1" })}
            ${voucherXml({ ledgerName: "Acme Supplier", date: "20250510", number: "ACME-MAY", amount: "-200.00", bill: "ACME-B2" })}
            ${voucherXml({ ledgerName: "Beta Supplier", date: "20250615", number: "BETA-JUN", amount: "-300.00", bill: "BETA-B1" })}
            ${voucherXml({ ledgerName: "Retail Customer", date: "20250620", number: "SALE-JUN", amount: "-999.00", bill: "SALE-B1" })}
          </ENVELOPE>`
        );
        return;
      }
      if (from === "20250701") {
        sendXml(
          res,
          `<ENVELOPE>
            ${voucherXml({ ledgerName: "Acme Supplier", date: "20250702", number: "ACME-JUL", amount: "-400.00", bill: "ACME-B3" })}
          </ENVELOPE>`
        );
        return;
      }
      sendXml(res, "<ENVELOPE></ENVELOPE>");
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2025-26",
        fromDate: "20250401",
        toDate: "20260331",
        actor: "unit-test",
      })
    );

    assert.equal(result.success, true);
    assert.equal(result.ledgerVoucherSummary.totalRows, 4);
    assert.equal(result.ledgerVoucherSummary.persistedRows, 4);

    const allRows = tallyImportService.getLedgerVouchers(result.importRun.id, { limit: 20 }).ledgerVouchers.rows;
    assert.deepEqual(
      allRows.map((row) => `${row.date}|${row.ledgerName}|${row.voucherNumber}`),
      [
        "2025-04-01|Acme Supplier|ACME-APR",
        "2025-05-10|Acme Supplier|ACME-MAY",
        "2025-06-15|Beta Supplier|BETA-JUN",
        "2025-07-02|Acme Supplier|ACME-JUL",
      ]
    );
    assert.equal(allRows.some((row) => row.ledgerName === "Retail Customer"), false);

    const acmeRows = tallyImportService.getLedgerVouchers(result.importRun.id, {
      ledgerName: "Acme Supplier",
      fromDate: "2025-05-01",
      toDate: "2025-07-31",
      limit: 20,
    }).ledgerVouchers.rows;
    assert.deepEqual(acmeRows.map((row) => row.voucherNumber), ["ACME-MAY", "ACME-JUL"]);
    assert.deepEqual(acmeRows.map((row) => row.billReference), ["ACME-B2", "ACME-B3"]);

    const mayToJuneRows = tallyImportService.getLedgerVouchers(result.importRun.id, {
      fromDate: "2025-05-01",
      toDate: "2025-06-30",
      limit: 20,
    }).ledgerVouchers.rows;
    assert.deepEqual(mayToJuneRows.map((row) => row.voucherNumber), ["ACME-MAY", "BETA-JUN"]);
  } finally {
    await mock.close();
  }
});

test("Tally import persists primary Voucher Collection source without fallback warning", async () => {
  const seen = { dayBook: 0, collection: 0 };
  const mock = await withMockTally(async (req, res) => {
    if (req.method === "GET") {
      sendXml(res, "<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      return;
    }
    const body = await readRequestBody(req);
    if (body.includes("MSME Voucher Collection")) {
      seen.collection += 1;
      sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", date: "20260401", number: "COLL-IMPORT-1", amount: "-700.00", bill: "COLL-BILL" })}</ENVELOPE>`);
      return;
    }
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("MSME Ledger Master Collection")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Acme Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>0.00</OPENINGBALANCE><CLOSINGBALANCE>700.00 Cr</CLOSINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></ENVELOPE>`);
      return;
    }
    if (body.includes("Day Book")) {
      seen.dayBook += 1;
      sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Retail Customer", date: "20260401", number: "SALE-1", amount: "-700.00", bill: "SALE-BILL" })}</ENVELOPE>`);
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      tallyImportService.importFromTally({
        fiscalYear: "2026-27",
        fromDate: "20260401",
        toDate: "20270331",
        actor: "unit-test",
      })
    );
    assert.equal(result.success, true);
    assert.equal(seen.dayBook <= 1, true);
    assert.equal(seen.collection >= 4, true);
    assert.equal(result.importRun.summary.selectedFinancialYear, "2026-27");
    assert.equal(result.importRun.summary.voucherSource, "Voucher Collection");
    assert.equal(result.importRun.summary.fallbackUsed, false);
    assert.equal(result.importRun.summary.creditorsImported, 1);
    assert.equal(result.importRun.summary.vouchersParsed, 1);
    assert.equal(result.importRun.summary.vouchersPersisted, 1);
    assert.equal(result.warnings.length, 0);

    const review = tallyImportService.getLedgerVouchers(result.importRun.id, { fiscalYear: "2026-27", limit: 10 });
    assert.equal(review.ledgerVouchers.total, 1);
    assert.equal(review.ledgerVouchers.rows[0].voucherSource, "Voucher Collection");
    assert.equal(review.ledgerVouchers.rows[0].voucherNumber, "COLL-IMPORT-1");
  } finally {
    await mock.close();
  }
});

test("voucher retrieval is scoped to the requested importRunId", () => {
  const firstRunId = importRepository.createRun({
    fiscalYear: "2025-26",
    fromDate: "20250401",
    toDate: "20260331",
    asOn: "2026-03-31",
    companyName: "Test Company",
    actor: "unit-test",
  });
  const secondRunId = importRepository.createRun({
    fiscalYear: "2026-27",
    fromDate: "20260401",
    toDate: "20270331",
    asOn: "2027-03-31",
    companyName: "Test Company",
    actor: "unit-test",
  });

  importRepository.completeRun(firstRunId, {
    summary: { fiscalYear: "2025-26", companyName: "Test Company" },
    creditors: [],
    ledgerVouchers: [{
      ledgerName: "First Supplier",
      normalizedLedgerName: "FIRST SUPPLIER",
      date: "2025-05-01",
      particulars: "Purchases",
      voucherType: "Purchase",
      voucherNumber: "FIRST-1",
      credit: 100,
      amount: 100,
      billReference: "FIRST-BILL",
    }],
  });
  importRepository.completeRun(secondRunId, {
    summary: { fiscalYear: "2026-27", companyName: "Test Company" },
    creditors: [],
    ledgerVouchers: [{
      ledgerName: "Second Supplier",
      normalizedLedgerName: "SECOND SUPPLIER",
      date: "2026-05-01",
      particulars: "Purchases",
      voucherType: "Purchase",
      voucherNumber: "SECOND-1",
      credit: 200,
      amount: 200,
      billReference: "SECOND-BILL",
    }],
  });

  const firstRows = tallyImportService.getLedgerVouchers(firstRunId, { limit: 10 }).ledgerVouchers.rows;
  const secondRows = tallyImportService.getLedgerVouchers(secondRunId, { limit: 10 }).ledgerVouchers.rows;
  assert.deepEqual(firstRows.map((row) => row.voucherNumber), ["FIRST-1"]);
  assert.deepEqual(secondRows.map((row) => row.voucherNumber), ["SECOND-1"]);
  assert.equal(firstRows[0].importRunId, firstRunId);
  assert.equal(secondRows[0].importRunId, secondRunId);
  assert.throws(
    () => tallyImportService.getLedgerVouchers(firstRunId, { fiscalYear: "2026-27", limit: 10 }),
    /Import run fiscal year mismatch/
  );
  assert.throws(
    () => createMSMEReport({ importRunId: firstRunId, fiscalYear: "2026-27", actor: "unit-test" }),
    /Import run fiscal year mismatch/
  );
});

test("voucher persistence skips duplicate vouchers within an import run", () => {
  const runId = importRepository.createRun({
    fiscalYear: "2026-27",
    fromDate: "20260401",
    toDate: "20270331",
    asOn: "2027-03-31",
    companyName: "Test Company",
    actor: "unit-test",
  });
  const voucher = {
    ledgerName: "Duplicate Supplier",
    normalizedLedgerName: "DUPLICATE SUPPLIER",
    date: "2026-04-01",
    particulars: "Purchases",
    voucherType: "Purchase",
    voucherNumber: "DUP-1",
    credit: 500,
    amount: 500,
    billReference: "DUP-BILL",
    voucherSource: "Voucher Collection",
  };

  importRepository.completeRun(runId, {
    summary: {
      fiscalYear: "2026-27",
      companyName: "Test Company",
      voucherSource: "Voucher Collection",
      fallbackUsed: true,
      vouchersParsed: 2,
    },
    creditors: [],
    ledgerVouchers: [voucher, { ...voucher }],
  });

  const rows = importRepository.getAllLedgerVouchers(runId);
  const run = importRepository.getRun(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].voucherSource, "Voucher Collection");
  assert.equal(run.summary.vouchersPersisted, 1);
  assert.equal(run.summary.duplicateVouchersSkipped, 1);
});

test("MSME report uses persisted vouchers for payable aging", () => {
  vendorRepository.upsertVendorStatus(
    {
      vendorName: "Report Aging Supplier",
      isMSME: true,
      verificationStatus: "verified",
      udyamStatus: "verified",
      udyamNumber: "UDYAM-DL-01-1234567",
      enterpriseType: "Small",
      enterpriseName: "Report Aging Supplier",
    },
    "unit-test",
    "unit_test"
  );
  const runId = importRepository.createRun({
    fiscalYear: "2026-27",
    fromDate: "20260401",
    toDate: "20270331",
    asOn: "2026-06-01",
    companyName: "Test Company",
    actor: "unit-test",
  });
  importRepository.completeRun(runId, {
    summary: {
      selectedFinancialYear: "2026-27",
      fiscalYear: "2026-27",
      companyName: "Test Company",
      voucherSource: "Voucher Collection",
      fallbackUsed: true,
      creditorsImported: 1,
      vouchersParsed: 2,
    },
    creditors: [{ party: "Report Aging Supplier", normalizedVendorName: "REPORT AGING SUPPLIER", parent: "Sundry Creditors", groupHierarchy: ["Sundry Creditors"], outstandingAmount: 999 }],
    ledgerVouchers: [
      {
        ledgerName: "Report Aging Supplier",
        normalizedLedgerName: "REPORT AGING SUPPLIER",
        date: "2026-04-01",
        voucherType: "Purchase",
        voucherNumber: "PINV-REPORT",
        credit: 1000,
        amount: 1000,
        billReference: "REPORT-BILL",
        voucherSource: "Voucher Collection",
      },
      {
        ledgerName: "Report Aging Supplier",
        normalizedLedgerName: "REPORT AGING SUPPLIER",
        date: "2026-04-15",
        voucherType: "Payment",
        voucherNumber: "PAY-REPORT",
        debit: 400,
        amount: 400,
        billReference: "REPORT-BILL",
        voucherSource: "Voucher Collection",
      },
    ],
  });

  const report = createMSMEReport({ importRunId: runId, fiscalYear: "2026-27", actor: "unit-test" });
  assert.equal(report.summary.selectedFinancialYear, "2026-27");
  assert.equal(report.summary.applicableAct, "Income Tax Act, 2025");
  assert.equal(report.summary.applicableSection, "Section 37(2)(g)");
  assert.equal(report.summary.actualPaymentRuleId, "ITA-2025-ACTUAL-PAYMENT-037");
  assert.equal(report.summary.bankRatePercent, 5.5);
  assert.equal(report.summary.annualInterestRatePercent, 16.5);
  assert.equal(report.summary.interestRateSource, "config");
  assert.equal(report.summary.voucherSource, "Voucher Collection");
  assert.equal(report.summary.fallbackUsed, true);
  assert.equal(report.summary.vouchersPersisted, 2);
  assert.equal(report.report.length, 1);
  assert.equal(report.report[0].vendorName, "Report Aging Supplier");
  assert.equal(report.report[0].outstandingAmount, 999);
  assert.equal(report.report[0].daysOutstanding, 61);
  assert.equal(report.report[0].delayDays, 16);
  assert.equal(report.report[0].disallowed, 999);
  assert.equal(report.report[0].appliedRules.includes("ITA-ACTUAL-PAYMENT-037"), false);
  assert.equal(report.report[0].appliedRules.includes("ITA-2025-ACTUAL-PAYMENT-037"), true);
  const bundle = buildEvidenceBundle(report);
  assert.equal(bundle.subarray(0, 4).toString("hex"), "504b0304");
  assert.match(bundle.toString("latin1"), /legal-source-manifest\.json/);
  assert.match(toCsv(report), /Legal Source Files/);
  assert.match(toTallyReconciliationCsv(report), /Report Aging Supplier/);
});

test("Tally creditor export returns diagnostics for empty creditor dataset", async () => {
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE><LEDGER NAME="Sales Account"><PARENT>Sales Accounts</PARENT><CLOSINGBALANCE>0.00</CLOSINGBALANCE></LEDGER></ENVELOPE>`);
      return;
    }
    assert.equal(body.includes("Group Summary"), false);
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    await assert.rejects(
      () => runWithTallyPort(mock.port, () =>
        fetchCreditors({
          from: "20250401",
          to: "20260331",
        })
      ),
      (error) => {
        assert.match(error.message, /0 creditor ledgers detected/);
        assert.deepEqual(error.diagnostics.creditorDiagnostics.sampleParentNames, ["Sales Accounts"]);
        return true;
      }
    );
  } finally {
    await mock.close();
  }
});

test("Tally creditor export uses ledger master balances and preserves opening debit credit detail", async () => {
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE>
        <LEDGER NAME="Credit Master Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
        <LEDGER NAME="Debit Master Supplier"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
      </ENVELOPE>`);
      return;
    }
    if (body.includes("MSME Ledger Master Collection")) {
      sendXml(res, `<ENVELOPE>
        <LEDGER NAME="Credit Master Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>150.00 Dr</OPENINGBALANCE><CLOSINGBALANCE>900.00 Cr</CLOSINGBALANCE><GSTIN>27ABCDE1234F1Z5</GSTIN></LEDGER>
        <LEDGER NAME="Debit Master Supplier"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>100.00 Cr</OPENINGBALANCE><CLOSINGBALANCE>50.00 Dr</CLOSINGBALANCE></LEDGER>
      </ENVELOPE>`);
      return;
    }
    if (body.includes("Day Book")) {
      sendXml(res, "<ENVELOPE></ENVELOPE>");
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchCreditors({
        from: "20250401",
        to: "20260331",
        asOn: "2026-03-31",
      })
    );
    assert.equal(result.creditors.length, 1);
    assert.equal(result.summary.tallySource, "ledger_master_collection");
    assert.equal(result.summary.creditorDiagnostics.filteredNonCreditBalanceCount, 0);
    assert.equal(result.creditors[0].party, "Credit Master Supplier");
    assert.equal(result.creditors[0].outstandingAmount, 900);
    assert.equal(result.creditors[0].openingBalance, 150);
    assert.equal(result.creditors[0].openingBalanceRaw, "150.00 Dr");
    assert.equal(result.creditors[0].openingBalanceType, "debit");
    assert.equal(result.creditors[0].closingBalance, -900);
    assert.equal(result.creditors[0].closingBalanceRaw, "900.00 Cr");
    assert.equal(result.creditors[0].closingBalanceType, "credit");
    assert.equal(result.creditors[0].gstin, "27ABCDE1234F1Z5");
  } finally {
    await mock.close();
  }
});

test("Tally creditor export treats unmarked Sundry Creditor master amounts as creditor polarity", async () => {
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (body.includes("List of Accounts")) {
      sendXml(res, `<ENVELOPE>
        <LEDGER NAME="Hindustan Power Green Vehicles Pvt Ltd"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
      </ENVELOPE>`);
      return;
    }
    if (body.includes("MSME Ledger Master Collection")) {
      sendXml(res, `<ENVELOPE>
        <LEDGER NAME="Hindustan Power Green Vehicles Pvt Ltd">
          <PARENT>Sundry Creditors</PARENT>
          <ISBILLWISEON>Yes</ISBILLWISEON>
          <INCOMETAXNUMBER>abcde1234f</INCOMETAXNUMBER>
          <OPENINGBALANCE>-1390800.00</OPENINGBALANCE>
          <CLOSINGBALANCE>572257.00</CLOSINGBALANCE>
        </LEDGER>
      </ENVELOPE>`);
      return;
    }
    if (body.includes("Day Book")) {
      sendXml(res, "<ENVELOPE></ENVELOPE>");
      return;
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchCreditors({
        from: "20250401",
        to: "20260331",
        asOn: "2026-03-31",
      })
    );
    assert.equal(result.creditors.length, 1);
    assert.equal(result.creditors[0].party, "Hindustan Power Green Vehicles Pvt Ltd");
    assert.equal(result.creditors[0].openingBalance, 1390800);
    assert.equal(result.creditors[0].openingBalanceType, "debit");
    assert.equal(result.creditors[0].closingBalance, -572257);
    assert.equal(result.creditors[0].closingBalanceType, "credit");
    assert.equal(result.creditors[0].outstandingAmount, 572257);
    assert.equal(result.creditors[0].panNumber, "ABCDE1234F");
  } finally {
    await mock.close();
  }
});

test("voucher export handles large batched datasets", async () => {
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (!body.includes("MSME Voucher Collection")) return sendXml(res, "<ENVELOPE></ENVELOPE>");
    const date = body.match(/<SVFROMDATE>(\d+)<\/SVFROMDATE>/)?.[1] || "20250501";
    const vouchers = Array.from({ length: 25 }, (_, index) =>
      voucherXml({ ledgerName: "Acme Supplier", date, number: `L-${date}-${index}`, amount: "-100.00", bill: `B-${index}` })
    ).join("");
    sendXml(res, `<ENVELOPE>${vouchers}</ENVELOPE>`);
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchAllCreditorLedgerVouchers({
        creditors: [{ party: "Acme Supplier" }],
        from: "20250401",
        to: "20260331",
      })
    );
    assert.equal(result.rows.length, 100);
    assert.equal(result.warnings.length, 0);
  } finally {
    await mock.close();
  }
});

test("voucher export tolerates slow Tally responses within 60s timeout", async () => {
  const oldTimeout = process.env.TALLY_VOUCHER_TIMEOUT_MS;
  process.env.TALLY_VOUCHER_TIMEOUT_MS = "1000";
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (!body.includes("MSME Voucher Collection")) return sendXml(res, "<ENVELOPE></ENVELOPE>");
    setTimeout(() => sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", number: "SLOW-1" })}</ENVELOPE>`), 150);
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchAllCreditorLedgerVouchers({
        creditors: [{ party: "Acme Supplier" }],
        from: "20250401",
        to: "20250630",
      })
    );
    assert.equal(result.rows.length, 1);
  } finally {
    if (oldTimeout == null) delete process.env.TALLY_VOUCHER_TIMEOUT_MS;
    else process.env.TALLY_VOUCHER_TIMEOUT_MS = oldTimeout;
    await mock.close();
  }
});

test("voucher export retries timed-out quarter month by month", async () => {
  const oldTimeout = process.env.TALLY_VOUCHER_TIMEOUT_MS;
  process.env.TALLY_VOUCHER_TIMEOUT_MS = "80";
  const seen = { monthly: 0 };
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (!body.includes("MSME Voucher Collection")) return sendXml(res, "<ENVELOPE></ENVELOPE>");
    const from = body.match(/<SVFROMDATE>(\d+)<\/SVFROMDATE>/)?.[1];
    const to = body.match(/<SVTODATE>(\d+)<\/SVTODATE>/)?.[1];
    if (from === "20250401" && to === "20250630") {
      setTimeout(() => sendXml(res, "<ENVELOPE></ENVELOPE>"), 200);
      return;
    }
    seen.monthly += 1;
    sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", date: from, number: `M-${from}` })}</ENVELOPE>`);
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchAllCreditorLedgerVouchers({
        creditors: [{ party: "Acme Supplier" }],
        from: "20250401",
        to: "20250630",
      })
    );
    assert.equal(seen.monthly, 3);
    assert.equal(result.rows.length, 3);
  } finally {
    if (oldTimeout == null) delete process.env.TALLY_VOUCHER_TIMEOUT_MS;
    else process.env.TALLY_VOUCHER_TIMEOUT_MS = oldTimeout;
    await mock.close();
  }
});

test("voucher export merges quarter batches", async () => {
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (!body.includes("MSME Voucher Collection")) return sendXml(res, "<ENVELOPE></ENVELOPE>");
    const from = body.match(/<SVFROMDATE>(\d+)<\/SVFROMDATE>/)?.[1] || "20250401";
    sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", date: from, number: `Q-${from}` })}</ENVELOPE>`);
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchAllCreditorLedgerVouchers({
        creditors: [{ party: "Acme Supplier" }],
        from: "20250401",
        to: "20260331",
      })
    );
    assert.equal(result.rows.length, 4);
    assert.deepEqual(result.rows.map((row) => row.voucherNumber), ["Q-20250401", "Q-20250701", "Q-20251001", "Q-20260101"]);
  } finally {
    await mock.close();
  }
});

test("voucher export uses filtered Voucher Collection as the primary path", async () => {
  const seen = { dayBook: 0, collection: 0 };
  const mock = await withMockTally(async (req, res) => {
    const body = await readRequestBody(req);
    if (body.includes("MSME Voucher Collection")) {
      seen.collection += 1;
      return sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Acme Supplier", date: "20260401", number: "COLL-1", amount: "-700.00", bill: "COLL-BILL" })}</ENVELOPE>`);
    }
    if (body.includes("Day Book")) {
      seen.dayBook += 1;
      return sendXml(res, `<ENVELOPE>${voucherXml({ ledgerName: "Retail Customer", date: "20260401", number: "SALE-1", amount: "-700.00", bill: "SALE-BILL" })}</ENVELOPE>`);
    }
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchAllCreditorLedgerVouchers({
        creditors: [{ party: "Acme Supplier" }],
        from: "20260401",
        to: "20260630",
      })
    );
    assert.equal(seen.dayBook, 0);
    assert.equal(seen.collection, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].voucherNumber, "COLL-1");
    assert.equal(result.rows[0].billReference, "COLL-BILL");
    assert.equal(result.rows[0].voucherSource, "Voucher Collection");
    assert.equal(result.voucherSource, "Voucher Collection");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.warnings.length, 0);
  } finally {
    await mock.close();
  }
});

test("voucher export accepts empty voucher batches", async () => {
  const mock = await withMockTally(async (req, res) => {
    await readRequestBody(req);
    sendXml(res, "<ENVELOPE></ENVELOPE>");
  });
  try {
    const result = await runWithTallyPort(mock.port, () =>
      fetchAllCreditorLedgerVouchers({
        creditors: [{ party: "Acme Supplier" }],
        from: "20250401",
        to: "20250630",
      })
    );
    assert.equal(result.rows.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.voucherSource, "Voucher Collection");
  } finally {
    await mock.close();
  }
});

test("payable aging matches invoice and full payment by bill reference", () => {
  const aging = buildPayableAgingFromVouchers([
    {
      ledgerName: "Aging Supplier",
      normalizedLedgerName: "AGING SUPPLIER",
      date: "2026-04-01",
      voucherType: "Purchase",
      voucherNumber: "PINV-1",
      billReference: "BILL-1",
      credit: 1000,
      amount: 1000,
    },
    {
      ledgerName: "Aging Supplier",
      normalizedLedgerName: "AGING SUPPLIER",
      date: "2026-04-20",
      voucherType: "Payment",
      voucherNumber: "PAY-1",
      billReference: "BILL-1",
      debit: 1000,
      amount: 1000,
    },
  ], "2026-06-01");

  assert.equal(aging.length, 1);
  assert.equal(aging[0].outstandingAmount, 0);
  assert.equal(aging[0].pendingInvoiceCount, 0);
  assert.equal(aging[0].invoiceCount, 1);
  assert.equal(aging[0].paymentCount, 1);
  assert.equal(aging[0].exposure43Bh, 0);
});

test("payable aging computes partial payment, pending amount, overdue days, and 43B(h) exposure", () => {
  const aging = buildPayableAgingFromVouchers([
    {
      ledgerName: "Partial Supplier",
      normalizedLedgerName: "PARTIAL SUPPLIER",
      date: "2026-04-01",
      voucherType: "Purchase",
      voucherNumber: "PINV-2",
      billReference: "BILL-2",
      credit: 1000,
      amount: 1000,
    },
    {
      ledgerName: "Partial Supplier",
      normalizedLedgerName: "PARTIAL SUPPLIER",
      date: "2026-04-15",
      voucherType: "Payment",
      voucherNumber: "PAY-2",
      billReference: "BILL-2",
      debit: 400,
      amount: 400,
    },
  ], "2026-06-01");

  assert.equal(aging.length, 1);
  assert.equal(aging[0].outstandingAmount, 600);
  assert.equal(aging[0].daysOutstanding, 61);
  assert.equal(aging[0].bucket, "61-90 days");
  assert.equal(aging[0].delayed, true);
  assert.equal(aging[0].exposure43Bh, 600);
  assert.equal(aging[0].invoices[0].paidAmount, 400);
  assert.equal(aging[0].invoices[0].pendingAmount, 600);
  assert.equal(aging[0].invoices[0].delayDays, 16);
});

test("payable aging keeps ledger outstanding amount and exposes voucher amount separately", () => {
  const creditors = [{
    party: "Ledger Source Supplier",
    normalizedVendorName: "LEDGER SOURCE SUPPLIER",
    outstandingAmount: 1000,
  }];
  const enriched = enrichCreditorsWithVoucherAging(creditors, [
    {
      ledgerName: "Ledger Source Supplier",
      normalizedLedgerName: "LEDGER SOURCE SUPPLIER",
      date: "2026-04-01",
      voucherType: "Purchase",
      voucherNumber: "PINV-LEDGER",
      billReference: "BILL-LEDGER",
      credit: 600,
      amount: 600,
    },
  ], "2026-06-01");

  assert.equal(enriched[0].outstandingAmount, 1000);
  assert.equal(enriched[0].ledgerOutstandingAmount, 1000);
  assert.equal(enriched[0].voucherOutstandingAmount, 600);
  assert.equal(enriched[0].outstandingMismatch, true);
  assert.equal(enriched[0].mismatchReason, "Ledger closing balance differs from voucher-only outstanding");
  assert.equal(enriched[0].payableAging.outstandingAmount, 600);
});

test("report includes only verified MSME vendors", () => {
  const rows = calculateReportRows([
    {
      party: "Verified MSME",
      normalizedVendorName: "VERIFIED",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 1000,
      ledgerOutstandingAmount: 1000,
      voucherOutstandingAmount: 1600,
      outstandingMismatch: true,
      mismatchReason: "Ledger closing balance differs from voucher-only outstanding",
      panNumber: "ABCDE1234F",
      daysOutstanding: 60,
      bucket: "46-60 days",
      vendorMaster: {
        isMSME: true,
        verificationStatus: "verified",
        udyamStatus: "verified",
        udyamNumber: "UDYAM-DL-01-1234567",
        enterpriseType: "Small",
      },
    },
    {
      party: "Pending Vendor",
      normalizedVendorName: "PENDING",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 2000,
      daysOutstanding: 90,
      bucket: "61-90 days",
      vendorMaster: { isMSME: true, verificationStatus: "manual_fallback_required", udyamStatus: "manual_fallback_required" },
    },
    {
      party: "Non MSME",
      normalizedVendorName: "NON",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 3000,
      daysOutstanding: 90,
      bucket: "61-90 days",
      vendorMaster: { isMSME: false, verificationStatus: "not_msme", udyamStatus: "not_started" },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendorName, "Verified MSME");
  assert.equal(rows[0].panNumber, "ABCDE1234F");
  assert.equal(rows[0].outstandingAmount, 1000);
  assert.equal(rows[0].ledgerOutstandingAmount, 1000);
  assert.equal(rows[0].voucherOutstandingAmount, 1600);
  assert.equal(rows[0].outstandingMismatch, true);
  assert.equal(rows[0].disallowed, 1000);
  assert.equal(rows[0].delayDays, 15);
  assert.equal(rows[0].appliedRules.includes("ITA-ACTUAL-PAYMENT-037"), true);
  assert.equal(rows[0].appliedRules.includes("ITA-2025-ACTUAL-PAYMENT-037"), false);
  assert.equal(rows[0].applicableAct, "Income Tax Act, 1961");
  assert.equal(rows[0].applicableSection, "Section 43B(h)");
  const csv = toCsv({
    id: "report-test",
    fiscalYear: "2025-26",
    createdAt: "2026-03-31T00:00:00.000Z",
    summary: {},
    report: rows,
    excluded: [],
  });
  assert.match(csv, /PAN Number/);
  assert.match(csv, /Ledger Payable Outstanding/);
  assert.match(csv, /Voucher-only Outstanding/);
  assert.match(csv, /ABCDE1234F/);
  assert.match(csv, /1600\.00/);
});

test("MCA MSME-1 preview maps report rows to utility buckets and validates PAN", () => {
  const runId = importRepository.createRun({
    fiscalYear: "2025-26",
    fromDate: "20250401",
    toDate: "20260331",
    asOn: "2026-03-31",
    companyName: "Test Company",
    status: "running",
    actor: "unit-test",
  });
  importRepository.completeRun(runId, {
    summary: { fiscalYear: "2025-26", companyName: "Test Company" },
    creditors: [],
    ledgerVouchers: [
      {
        vendorName: "Paid Late Supplier",
        normalizedVendorName: "PAID LATE SUPPLIER",
        ledgerName: "Paid Late Supplier",
        normalizedLedgerName: "PAID LATE SUPPLIER",
        date: "2025-04-01",
        voucherType: "Purchase",
        voucherNumber: "INV-LATE",
        credit: 1000,
        amount: 1000,
        billReference: "INV-LATE",
      },
      {
        vendorName: "Paid Late Supplier",
        normalizedVendorName: "PAID LATE SUPPLIER",
        ledgerName: "Paid Late Supplier",
        normalizedLedgerName: "PAID LATE SUPPLIER",
        date: "2025-06-01",
        voucherType: "Payment",
        voucherNumber: "PAY-LATE",
        debit: 1000,
        amount: 1000,
        billReference: "INV-LATE",
      },
    ],
  });
  const report = reportRepository.createReport({
    importRunId: runId,
    fiscalYear: "2025-26",
    summary: {},
    report: {
      included: [
        {
          vendorName: "Overdue Supplier",
          normalizedVendorName: "OVERDUE SUPPLIER",
          panNumber: "ABCDE1234F",
          udyamNumber: "UDYAM-DL-01-1234567",
          ledgerOutstandingAmount: 5000,
          outstandingAmount: 5000,
          daysOutstanding: 80,
        },
        {
          vendorName: "Current Supplier",
          normalizedVendorName: "CURRENT SUPPLIER",
          panNumber: "BCDEF1234G",
          udyamNumber: "UDYAM-DL-01-1234568",
          ledgerOutstandingAmount: 2000,
          outstandingAmount: 2000,
          daysOutstanding: 30,
        },
        {
          vendorName: "Paid Late Supplier",
          normalizedVendorName: "PAID LATE SUPPLIER",
          panNumber: "CDEFG1234H",
          udyamNumber: "UDYAM-DL-01-1234569",
          ledgerOutstandingAmount: 0,
          outstandingAmount: 0,
          voucherOutstandingAmount: 0,
          daysOutstanding: 0,
        },
        {
          vendorName: "Missing PAN Supplier",
          normalizedVendorName: "MISSING PAN SUPPLIER",
          panNumber: "",
          udyamNumber: "UDYAM-DL-01-1234570",
          ledgerOutstandingAmount: 1,
          outstandingAmount: 1,
          daysOutstanding: 50,
        },
      ],
      excluded: [],
    },
    actor: "unit-test",
  });

  const preview = mcaMsme1Service.buildPreview({ reportId: report.id, halfYear: "apr-sep" });
  const overdue = preview.rows.find((row) => row.vendorName === "Overdue Supplier");
  const current = preview.rows.find((row) => row.vendorName === "Current Supplier");
  const paidLate = preview.rows.find((row) => row.vendorName === "Paid Late Supplier");

  assert.equal(overdue.outstandingMoreThan45Count, 1);
  assert.equal(overdue.outstandingMoreThan45Amount, 5000);
  assert.equal(current.outstanding45OrLessCount, 1);
  assert.equal(current.outstanding45OrLessAmount, 2000);
  assert.equal(paidLate.paidAfter45Count, 1);
  assert.equal(paidLate.paidAfter45Amount, 1000);
  assert.equal(preview.validation.valid, false);
  assert.equal(preview.validation.errors.some((error) => error.code === "missing_pan"), true);
});

test("MCA MSME-1 generation preserves xlsm workbook structure and VBA", () => {
  const runId = importRepository.createRun({
    fiscalYear: "2025-26",
    fromDate: "20250401",
    toDate: "20260331",
    asOn: "2026-03-31",
    companyName: "Test Company",
    status: "running",
    actor: "unit-test",
  });
  importRepository.completeRun(runId, {
    summary: { fiscalYear: "2025-26", companyName: "Test Company" },
    creditors: [],
    ledgerVouchers: [],
  });
  const report = reportRepository.createReport({
    importRunId: runId,
    fiscalYear: "2025-26",
    summary: {},
    report: {
      included: [
        {
          vendorName: "Workbook Supplier",
          normalizedVendorName: "WORKBOOK SUPPLIER",
          panNumber: "ABCDE1234F",
          udyamNumber: "UDYAM-DL-01-1234567",
          ledgerOutstandingAmount: 572257,
          voucherOutstandingAmount: 1963057,
          outstandingMismatch: true,
          outstandingAmount: 572257,
          daysOutstanding: 364,
        },
      ],
      excluded: [],
    },
    actor: "unit-test",
  });

  const result = mcaMsme1Service.generate({ reportId: report.id, halfYear: "oct-mar", actor: "unit-test" });
  assert.equal(result.success, true);
  assert.equal(result.preview.rows[0].outstandingMoreThan45Amount, 572257);
  assert.equal(result.preview.validation.warnings.some((warning) => warning.code === "ledger_voucher_mismatch"), true);
  const workbook = XLSX.readFile(result.filing.generatedFilePath, { bookVBA: true });
  assert.deepEqual(workbook.SheetNames, ["MetaInfo", "MSME", "Instructions"]);
  assert.equal(Boolean(workbook.vbaraw), true);
  assert.equal(workbook.Sheets.MSME.A5.v, 1);
  assert.equal(workbook.Sheets.MSME.B5.v, "Workbook Supplier");
  assert.equal(workbook.Sheets.MSME.C5.v, "ABCDE1234F");
  assert.equal(workbook.Sheets.MSME.M5.v, 572257);
});

test("rule engine applies MSME 45-day and actual payment rules", () => {
  const result = evaluateVendor({
    party: "Rule Vendor",
    outstandingAmount: 10000,
    daysOutstanding: 75,
    vendorMaster: { isMSME: true, udyamStatus: "verified" },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.allowedPaymentDays, 45);
  assert.equal(result.delayDays, 30);
  assert.equal(result.disallowed, 10000);
  assert.equal(result.appliedRules.includes("MSME-PAYMENT-DUE-015"), true);
  assert.equal(result.appliedRules.includes("ITA-ACTUAL-PAYMENT-037"), true);
  assert.equal(result.appliedRules.includes("ITA-2025-ACTUAL-PAYMENT-037"), false);
  assert.equal(result.bankRatePercent, 5.5);
  assert.equal(result.annualInterestRatePercent, 16.5);
  assert.equal(result.applicableAct, "Income Tax Act, 1961");
  assert.equal(result.applicableSection, "Section 43B(h)");
  assert.ok(result.interest > 0);
});

test("rule engine switches actual-payment rule for FY 2026-27 onwards", () => {
  const result = evaluateVendor(
    {
      party: "FY Rule Vendor",
      outstandingAmount: 10000,
      daysOutstanding: 75,
      vendorMaster: { isMSME: true, udyamStatus: "verified" },
    },
    { fiscalYear: "2026-27" }
  );
  assert.equal(result.appliedRules.includes("ITA-ACTUAL-PAYMENT-037"), false);
  assert.equal(result.appliedRules.includes("ITA-2025-ACTUAL-PAYMENT-037"), true);
  assert.equal(result.actualPaymentRuleId, "ITA-2025-ACTUAL-PAYMENT-037");
  assert.equal(result.applicableAct, "Income Tax Act, 2025");
  assert.equal(result.applicableSection, "Section 37(2)(g)");
});

test("imported payment terms drive MSME allowed payment days", async () => {
  await vendorRepository.importUdyamRowsWithVerification(
    [
      { vendorName: "Terms Fifteen Supplier", udyamNumber: "UDYAM-KA-29-1234567", paymentTerms: "15 days" },
      { vendorName: "Terms Fortyfive Supplier", udyamNumber: "UDYAM-KA-29-1234568", paymentTerms: "45" },
    ],
    "unit-test",
    {
      verifyUdyamNumber: async (udyamNumber) => ({
        udyamNumber,
        verified: true,
        verificationStatus: "verified",
        enterpriseType: "Micro",
      }),
    }
  );
  const fifteen = evaluateVendor({
    party: "Terms Fifteen Supplier",
    outstandingAmount: 1000,
    daysOutstanding: 20,
    vendorMaster: vendorRepository.findByNormalizedName("TERMS FIFTEEN SUPPLIER"),
  });
  const fortyfive = evaluateVendor({
    party: "Terms Fortyfive Supplier",
    outstandingAmount: 1000,
    daysOutstanding: 20,
    vendorMaster: vendorRepository.findByNormalizedName("TERMS FORTYFIVE SUPPLIER"),
  });

  assert.equal(fifteen.allowedPaymentDays, 15);
  assert.equal(fifteen.delayDays, 5);
  assert.equal(fortyfive.allowedPaymentDays, 45);
  assert.equal(fortyfive.delayDays, 0);
});

test("MSME interest calculator returns zero interest when there is no delay", () => {
  const result = calculateMSMEInterest({
    principal: 10000,
    invoiceDate: "2026-04-01",
    asOnDate: "2026-04-30",
  });
  assert.equal(result.daysOutstanding, 29);
  assert.equal(result.allowedPaymentDays, 45);
  assert.equal(result.delayDays, 0);
  assert.equal(result.interest, 0);
  assert.equal(result.totalPayable, 10000);
  assert.equal(result.isDelayed, false);
});

test("MSME interest calculator compounds interest with monthly rests after 45 days", () => {
  const result = calculateMSMEInterest({
    principal: 10000,
    invoiceDate: "2026-04-01",
    asOnDate: "2026-06-15",
  });
  assert.equal(result.daysOutstanding, 75);
  assert.equal(result.delayDays, 30);
  assert.equal(result.bankRatePercent, 5.5);
  assert.equal(result.annualInterestRate, 0.165);
  assert.equal(result.annualInterestRatePercent, 16.5);
  assert.equal(result.interest, 137.5);
  assert.equal(result.totalPayable, 10137.5);
  assert.equal(result.isDelayed, true);
});

test("MSME interest calculator honors configured RBI bank rate", () => {
  const oldRate = env.msmeBankRatePercent;
  env.msmeBankRatePercent = 6.5;
  try {
    const result = calculateMSMEInterest({
      principal: 10000,
      invoiceDate: "2026-04-01",
      asOnDate: "2026-06-15",
    });
    assert.equal(result.bankRatePercent, 6.5);
    assert.equal(result.annualInterestRate, 0.195);
    assert.equal(result.annualInterestRatePercent, 19.5);
    assert.equal(result.interest, 162.5);
  } finally {
    env.msmeBankRatePercent = oldRate;
  }
});

test("MSME interest calculator caps agreed payment days at 45", () => {
  const result = calculateMSMEInterest({
    principal: 5000,
    invoiceDate: "2026-04-01",
    asOnDate: "2026-06-15",
    agreedPaymentDays: 90,
  });
  assert.equal(result.allowedPaymentDays, 45);
  assert.equal(result.delayDays, 30);
});

test("MSME interest calculator validates principal and dates", () => {
  assert.throws(
    () => calculateMSMEInterest({ principal: 0, invoiceDate: "2026-04-01", asOnDate: "2026-06-15" }),
    /principal must be greater than 0/
  );
  assert.throws(
    () => calculateMSMEInterest({ principal: 100, invoiceDate: "", asOnDate: "2026-06-15" }),
    /invoiceDate must be a valid date/
  );
});

test("rule pack exposes local legal sources", () => {
  const pack = loadRulePack();
  assert.equal(pack.rules.some((rule) => rule.id === "MSME-INTEREST-016"), true);
  assert.equal(pack.sources.some((source) => source.id === "ITA_1961"), true);
  assert.equal(pack.sources.some((source) => source.id === "ITA_2025"), true);
  assert.equal(pack.sources.some((source) => source.id === "IT_RULES_2026"), true);
});

test("approved proof vendor is included and rejected proof vendor is excluded", () => {
  const creditors = [
    {
      party: "Approved Vendor",
      normalizedVendorName: "APPROVED",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 500,
      daysOutstanding: 50,
      bucket: "46-60 days",
      vendorMaster: { isMSME: true, udyamStatus: "approved", udyamNumber: "UDYAM-DL-01-1234567", enterpriseType: "Micro" },
    },
    {
      party: "Rejected Vendor",
      normalizedVendorName: "REJECTED",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 700,
      daysOutstanding: 50,
      bucket: "46-60 days",
      vendorMaster: { isMSME: true, udyamStatus: "rejected", udyamNumber: "UDYAM-DL-01-7654321" },
    },
  ];
  const rows = calculateReportRows(creditors);
  const excluded = calculateExcludedRows(creditors);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendorName, "Approved Vendor");
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].reason, "manual_rejected");
});

test("dummy Udyam number is excluded from MSME report", () => {
  const creditors = [
    {
      party: "Dummy Udyam Vendor",
      normalizedVendorName: "DUMMY UDYAM VENDOR",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 1000,
      daysOutstanding: 70,
      bucket: "61-90 days",
      vendorMaster: {
        isMSME: true,
        udyamStatus: "verified",
        verificationStatus: "verified",
        udyamNumber: "UDYAM-XX-00-0000000",
        enterpriseType: "Micro",
      },
    },
  ];
  const rows = calculateReportRows(creditors);
  const excluded = calculateExcludedRows(creditors);
  assert.equal(rows.length, 0);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].reason, "invalid_udyam");
});

test("manual fallback vendor is excluded with explicit reason", () => {
  const excluded = calculateExcludedRows([
    {
      party: "Fallback Vendor",
      normalizedVendorName: "FALLBACK",
      parent: "Sundry Creditors",
      groupHierarchy: ["Sundry Creditors"],
      outstandingAmount: 1000,
      daysOutstanding: 80,
      vendorMaster: { isMSME: true, udyamStatus: "manual_fallback_required" },
    },
  ]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].reason, "manual_review_required");
});

test("vendor master seeding preserves verified status and marks zero outstanding as not required", () => {
  vendorRepository.upsertVendorStatus(
    {
      vendorName: "Seed Preserved Supplier",
      isMSME: true,
      verificationStatus: "verified",
      udyamStatus: "verified",
      udyamNumber: "UDYAM-DL-01-1234567",
      enterpriseType: "Small",
    },
    "unit-test",
    "unit_test"
  );
  const runId = importRepository.createRun({
    fiscalYear: "2026-27",
    fromDate: "20260401",
    toDate: "20270331",
    asOn: "2026-06-01",
    companyName: "Test Company",
    actor: "unit-test",
  });
  importRepository.completeRun(runId, {
    summary: { selectedFinancialYear: "2026-27", fiscalYear: "2026-27", companyName: "Test Company", creditorsImported: 3 },
    creditors: [
      { party: "Seed Preserved Supplier", normalizedVendorName: "SEED PRESERVED SUPPLIER", parent: "Sundry Creditors", groupHierarchy: ["Sundry Creditors"], outstandingAmount: 100, voucherCount: 1 },
      { party: "Zero Seed Supplier", normalizedVendorName: "ZERO SEED SUPPLIER", parent: "Sundry Creditors", groupHierarchy: ["Sundry Creditors"], outstandingAmount: 0, voucherCount: 0 },
      { party: "Active Seed Supplier", normalizedVendorName: "ACTIVE SEED SUPPLIER", parent: "Sundry Creditors", groupHierarchy: ["Sundry Creditors"], outstandingAmount: 50, voucherCount: 1 },
    ],
    ledgerVouchers: [
      {
        ledgerName: "Active Seed Supplier",
        normalizedLedgerName: "ACTIVE SEED SUPPLIER",
        date: "2026-04-01",
        voucherType: "Purchase",
        voucherNumber: "SEED-1",
        credit: 50,
        amount: 50,
      },
    ],
  });
  const seed = vendorRepository.seedFromImport(runId, importRepository.getCreditors(runId), "unit-test");
  assert.equal(seed.total, 3);
  assert.equal(vendorRepository.findByNormalizedName("SEED PRESERVED SUPPLIER").udyamStatus, "verified");

  const marked = vendorRepository.markZeroOutstandingNotRequired({ importRunId: runId, actor: "unit-test" });
  assert.equal(marked.marked, 1);
  assert.equal(vendorRepository.findByNormalizedName("ZERO SEED SUPPLIER").actionStatus, "not_required_zero_outstanding");
  assert.equal(vendorRepository.findByNormalizedName("ACTIVE SEED SUPPLIER").actionStatus, "pending_action");
});

test("import repository and seeding hide historical non-Sundry creditor rows", () => {
  const runId = importRepository.createRun({
    fiscalYear: "2026-27",
    fromDate: "20260401",
    toDate: "20270331",
    asOn: "2026-06-01",
    companyName: "Test Company",
    actor: "unit-test",
  });
  importRepository.completeRun(runId, {
    summary: { selectedFinancialYear: "2026-27", fiscalYear: "2026-27", companyName: "Test Company", creditorsImported: 2 },
    creditors: [
      {
        party: "Good Sundry Supplier",
        normalizedVendorName: "GOOD SUNDRY SUPPLIER",
        parent: "Sundry Creditors",
        groupHierarchy: ["Sundry Creditors"],
        detectionReasons: ["creditor_parent_or_ancestor"],
        outstandingAmount: 100,
        voucherCount: 1,
      },
      {
        party: "Purchase",
        normalizedVendorName: "PURCHASE",
        parent: "Purchase Accounts",
        groupHierarchy: ["Purchase Accounts"],
        detectionReasons: ["bill_wise_enabled", "payable_balance"],
        outstandingAmount: 999,
        voucherCount: 1,
      },
    ],
    ledgerVouchers: [
      { ledgerName: "Good Sundry Supplier", normalizedLedgerName: "GOOD SUNDRY SUPPLIER", date: "2026-04-01", voucherType: "Purchase", voucherNumber: "GOOD-1", credit: 100, amount: 100 },
      { ledgerName: "Purchase", normalizedLedgerName: "PURCHASE", date: "2026-04-01", voucherType: "Purchase", voucherNumber: "BAD-1", credit: 999, amount: 999 },
    ],
  });

  const creditors = importRepository.getCreditors(runId);
  assert.deepEqual(creditors.map((creditor) => creditor.party), ["Good Sundry Supplier"]);
  assert.deepEqual(importRepository.getAllLedgerVouchers(runId).map((row) => row.ledgerName), ["Good Sundry Supplier"]);
  assert.deepEqual(importRepository.getIgnoredNonSundryCreditors(runId).map((row) => row.party), ["Purchase"]);
  const seed = vendorRepository.seedFromImport(runId, creditors, "unit-test");
  assert.equal(seed.total, 1);
  assert.equal(vendorRepository.findByNormalizedName("GOOD SUNDRY SUPPLIER").actionStatus, "pending_action");
  assert.equal(vendorRepository.findByNormalizedName("PURCHASE"), null);
});

test("import repository excludes historical rows with missing lineage", () => {
  const runId = importRepository.createRun({
    fiscalYear: "2026-27",
    fromDate: "20260401",
    toDate: "20270331",
    asOn: "2026-06-01",
    companyName: "Test Company",
    actor: "unit-test",
  });
  importRepository.completeRun(runId, {
    summary: { selectedFinancialYear: "2026-27", fiscalYear: "2026-27", companyName: "Test Company", creditorsImported: 1 },
    creditors: [
      {
        party: "Legacy Missing Parent",
        normalizedVendorName: "LEGACY MISSING PARENT",
        outstandingAmount: 999,
        voucherCount: 1,
      },
    ],
    ledgerVouchers: [
      { ledgerName: "Legacy Missing Parent", normalizedLedgerName: "LEGACY MISSING PARENT", date: "2026-04-01", voucherType: "Purchase", voucherNumber: "LEG-1", credit: 999, amount: 999 },
    ],
  });

  assert.equal(importRepository.getCreditors(runId).length, 0);
  assert.equal(importRepository.getAllLedgerVouchers(runId).length, 0);
  assert.deepEqual(importRepository.getIgnoredNonSundryCreditors(runId).map((row) => row.party), ["Legacy Missing Parent"]);
});

test("CSV Udyam import creates manual-review queue rows", () => {
  vendorRepository.upsertVendorStatus(
    { vendorName: "CSV Matched Supplier", isMSME: false, verificationStatus: "pending", udyamStatus: "not_started" },
    "unit-test",
    "unit_test"
  );
  const summary = vendorRepository.importUdyamRows(
    [
      {
        vendorName: "CSV Matched Supplier",
        udyamNumber: "UDYAM-DL-01-7654321",
        paymentTerms: "15 days",
        enterpriseType: "Micro",
        evidenceUrl: "https://example.test/proof",
        notes: "Proof received",
      },
      {
        vendorName: "CSV Unmatched Supplier",
        udyamNumber: "UDYAM-DL-01-7654322",
        paymentTerms: "45",
        enterpriseType: "Small",
      },
    ],
    "unit-test"
  );
  assert.equal(summary.matched, 1);
  assert.equal(summary.unmatched, 1);
  const matched = vendorRepository.findByNormalizedName("CSV MATCHED SUPPLIER");
  assert.equal(matched.actionStatus, "manual_review");
  assert.equal(matched.evidenceUrl, "https://example.test/proof");
  assert.equal(matched.agreedPaymentDays, 15);
  assert.equal(vendorRepository.getVerificationQueue().some((vendor) => vendor.vendorName === "CSV Matched Supplier"), true);
});

test("Excel Udyam import auto-verifies valid rows and updates vendor master", async () => {
  vendorRepository.upsertVendorStatus(
    { vendorName: "Excel Verified Supplier", isMSME: false, verificationStatus: "pending", udyamStatus: "not_started" },
    "unit-test",
    "unit_test"
  );
  const summary = await vendorRepository.importUdyamRowsWithVerification(
    [{ vendorName: "Excel Verified Supplier", udyamNumber: "UDYAM-DL-01-7654321", paymentTerms: "15 days" }],
    "unit-test",
    {
      sourceFileName: "udyam.xlsx",
      verifyUdyamNumber: async (udyamNumber) => ({
        udyamNumber,
        verified: true,
        verificationStatus: "verified",
        enterpriseName: "Excel Verified Enterprise",
        enterpriseType: "Small",
        registrationValidity: "Active",
        registrationDate: "2024-04-01",
        verifiedAt: "2026-05-21T00:00:00.000Z",
      }),
    }
  );

  assert.equal(summary.imported, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.failed, 0);
  const vendor = vendorRepository.findByNormalizedName("EXCEL VERIFIED SUPPLIER");
  assert.equal(vendor.udyamStatus, "verified");
  assert.equal(vendor.actionStatus, "verified_msme");
  assert.equal(vendor.udyamNumber, "UDYAM-DL-01-7654321");
  assert.equal(vendor.enterpriseName, "Excel Verified Enterprise");
  assert.equal(vendor.enterpriseType, "Small");
  assert.equal(vendor.agreedPaymentDays, 15);
});

test("Excel Udyam import accepts three-column template headers and Udhyam alias", async () => {
  const summary = await vendorRepository.importUdyamRowsWithVerification(
    [{ "Vendor Name": "Three Column Supplier", "Udhyam Number": "UDYAM-GJ-24-1234567", "Payment Terms": "45 days" }],
    "unit-test",
    {
      sourceFileName: "three-column-template.xlsx",
      verifyUdyamNumber: async (udyamNumber) => ({
        udyamNumber,
        verified: true,
        verificationStatus: "verified",
        enterpriseName: "Three Column Supplier",
        enterpriseType: "Micro",
      }),
    }
  );

  assert.equal(summary.imported, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.failed, 0);
  const vendor = vendorRepository.findByNormalizedName("THREE COLUMN SUPPLIER");
  assert.equal(vendor.udyamNumber, "UDYAM-GJ-24-1234567");
  assert.equal(vendor.udyamStatus, "verified");
  assert.equal(vendor.agreedPaymentDays, 45);
});

test("Excel Udyam import rejects missing mandatory values and invalid optional terms", async () => {
  const summary = await vendorRepository.importUdyamRowsWithVerification(
    [
      { vendorName: "", udyamNumber: "UDYAM-DL-01-7654321" },
      { vendorName: "Invalid Excel Supplier", udyamNumber: "ABC", paymentTerms: "45" },
      { vendorName: "Missing Udyam Supplier", udyamNumber: "", paymentTerms: "15" },
      { vendorName: "Invalid Terms Supplier", udyamNumber: "UDYAM-DL-01-7654323", paymentTerms: "30" },
    ],
    "unit-test",
    {
      verifyUdyamNumber: async () => {
        throw new Error("Verifier should not run for invalid rows");
      },
    }
  );

  assert.equal(summary.imported, 4);
  assert.equal(summary.failed, 4);
  assert.equal(summary.verified, 0);
  assert.equal(summary.results[0].reason, "vendorName is required");
  assert.equal(summary.results[1].reason, "invalid_udyam_format");
  assert.equal(summary.results[2].reason, "udyamNumber is required");
  assert.equal(summary.results[3].reason, "paymentTerms must be 15 or 45 days when provided");
  const invalid = vendorRepository.findByNormalizedName("INVALID EXCEL SUPPLIER");
  assert.equal(invalid.udyamStatus, "invalid_format");
  assert.equal(invalid.actionStatus, "failed");
});

test("Excel Udyam import defaults missing payment terms to 45 days", async () => {
  const summary = await vendorRepository.importUdyamRowsWithVerification(
    [{ "Vendor Name": "Two Column Supplier", "Udyam Number": "UDYAM-DL-07-1234567" }],
    "unit-test",
    {
      sourceFileName: "two-column-template.xlsx",
      verifyUdyamNumber: async (udyamNumber) => ({
        udyamNumber,
        verified: true,
        verificationStatus: "verified",
        enterpriseName: "Two Column Supplier",
        enterpriseType: "Micro",
      }),
    }
  );

  assert.equal(summary.imported, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.failed, 0);
  const vendor = vendorRepository.findByNormalizedName("TWO COLUMN SUPPLIER");
  assert.equal(vendor.udyamStatus, "verified");
  assert.equal(vendor.agreedPaymentDays, 45);
});

test("Excel Udyam import preserves valid number when portal needs manual review", async () => {
  const summary = await vendorRepository.importUdyamRowsWithVerification(
    [{ vendorName: "Captcha Excel Supplier", udyamNumber: "UDYAM-MH-27-1234567", paymentTerms: "45", notes: "Imported by CA" }],
    "unit-test",
    {
      sourceFileName: "captcha.xlsx",
      verifyUdyamNumber: async (udyamNumber) => ({
        udyamNumber,
        verified: false,
        verificationStatus: "manual_fallback_required",
        error: "Udyam portal requires captcha/manual verification.",
      }),
    }
  );

  assert.equal(summary.imported, 1);
  assert.equal(summary.manualReview, 1);
  assert.equal(summary.unmatched, 1);
  const vendor = vendorRepository.findByNormalizedName("CAPTCHA EXCEL SUPPLIER");
  assert.equal(vendor.udyamNumber, "UDYAM-MH-27-1234567");
  assert.equal(vendor.udyamStatus, "manual_fallback_required");
  assert.equal(vendor.actionStatus, "manual_review");
  assert.equal(vendor.agreedPaymentDays, 45);
  assert.match(vendor.udyamRemarks, /captcha/i);
});

test("Udyam import verification emits live activity events", async () => {
  const events = [];
  const summary = await vendorRepository.importUdyamRowsWithVerification(
    [{ vendorName: "Live Log Supplier", udyamNumber: "UDYAM-TN-33-1234567", paymentTerms: "15" }],
    "unit-test",
    {
      onEvent: (event) => events.push(event),
      verifyUdyamNumber: async (udyamNumber) => ({
        udyamNumber,
        verified: true,
        verificationStatus: "verified",
        enterpriseType: "Small",
      }),
    }
  );

  assert.equal(summary.verified, 1);
  assert.equal(events.some((event) => event.type === "import_started"), true);
  assert.equal(events.some((event) => event.type === "row_started"), true);
  assert.equal(events.some((event) => event.type === "portal_result_verified"), true);
  assert.equal(events.some((event) => event.type === "import_completed"), true);
});

test("vendor repository writes audit log on status save", () => {
  const vendor = vendorRepository.upsertVendorStatus(
    { vendorName: "Audit Vendor", isMSME: false, verificationStatus: "not_msme" },
    "tester@example.com",
    "unit_test"
  );
  const audit = vendorRepository.getAuditTrail();
  assert.equal(vendor.verificationStatus, "not_msme");
  assert.equal(audit.some((entry) => entry.vendorId === vendor.id && entry.changedBy === "tester@example.com"), true);
});

test("purchase invoice repository stores invoice intake records", () => {
  const vendor = vendorRepository.upsertVendorStatus(
    { vendorName: "Invoice Vendor", isMSME: false, verificationStatus: "pending", udyamStatus: "not_started" },
    "tester@example.com",
    "unit_test"
  );
  const invoice = purchaseInvoiceRepository.createInvoice(
    {
      vendorId: vendor.id,
      vendorName: "Invoice Vendor Pvt Ltd",
      invoiceNumber: "PI-001",
      invoiceDate: "2026-04-01",
      invoiceAmount: 1200,
      outstandingAmount: 900,
      source: "manual",
      udyamNumber: "UDYAM-DL-01-1234567",
      udyamStatus: "not_started",
    },
    "tester@example.com"
  );
  assert.equal(invoice.normalizedVendorName, "INVOICE VENDOR");
  assert.equal(invoice.outstandingAmount, 900);
  assert.equal(purchaseInvoiceRepository.listInvoices({ query: "PI-001" }).length, 1);
});

test.after(() => {
  db.close();
  const file = path.resolve(process.cwd(), process.env.DATABASE_PATH);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${file}${suffix}`);
    } catch {
      // ignored
    }
  }
});

