import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import VendorVerificationTable from "./components/VendorVerificationTable";
import {
  createMSMEReport,
  downloadReportFile,
  downloadUrl,
  fetchLedgerVouchers,
  fetchTallyHealth,
  importFromTally,
  importUdyamRowsLive,
  markZeroOutstandingNotRequired,
  reportEvidenceBundleUrl,
  reportTallyReconciliationUrl,
} from "./services/api";
import { useVendorVerification } from "./hooks/useVendorVerification";

const FY_CONFIG = {
  "2025-26": {
    label: "FY 2025-26",
    act: "Income Tax Act, 1961",
    section: "Section 43B(h)",
    fromDate: "20250401",
    toDate: "20260331",
  },
  "2026-27": {
    label: "FY 2026-27",
    act: "Income Tax Act, 2025",
    section: "Section 37(2)(g)",
    fromDate: "20260401",
    toDate: "20270331",
  },
};

const VOUCHER_PROGRESS_LABELS = ["Apr-Jun", "Jul-Sep", "Oct-Dec", "Jan-Mar"];
const VOUCHER_PAGE_SIZE = 250;
const UDYAM_IMPORT_HEADERS = ["Vendor Name", "Udyam Number", "Payment Terms"];

function activeVoucherFilter(value, allLabel) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === allLabel.toLowerCase() || normalized === "all" ? "" : value;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function canonicalUdyamHeader(header) {
  const normalized = String(header || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    vendorname: "vendorName",
    vendor: "vendorName",
    name: "vendorName",
    party: "vendorName",
    suppliername: "vendorName",
    udyamnumber: "udyamNumber",
    udhyamnumber: "udyamNumber",
    udyam: "udyamNumber",
    udhyam: "udyamNumber",
    udyamno: "udyamNumber",
    udhyamno: "udyamNumber",
    udyamregistrationnumber: "udyamNumber",
    udhyamregistrationnumber: "udyamNumber",
    paymentterms: "paymentTerms",
    paymentterm: "paymentTerms",
    agreedpaymentdays: "paymentTerms",
    allowedpaymentdays: "paymentTerms",
    enterprisetype: "enterpriseType",
    enterprisename: "enterpriseName",
    evidenceurl: "evidenceUrl",
    proofurl: "evidenceUrl",
    notes: "notes",
    remarks: "notes",
  };
  return aliases[normalized] || String(header || "").trim();
}

function normalizePaymentTerms(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "45";
  const match = raw.match(/^(\d+)(?:\s*days?)?$/);
  const days = match ? Number(match[1]) : 0;
  return days === 15 || days === 45 ? String(days) : "";
}

function normalizeUdyamRows(rawRows) {
  return rawRows
    .map((row) => {
      const normalized = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [canonicalUdyamHeader(key), String(value ?? "").trim()]));
      return { ...normalized, paymentTerms: normalizePaymentTerms(normalized.paymentTerms) };
    })
    .filter((row) => Object.values(row).some(Boolean));
}

function parseUdyamCsvRows(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(canonicalUdyamHeader);
  return normalizeUdyamRows(lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  }));
}

function validateUdyamImportRows(rows) {
  const total = rows.length;
  const withVendorName = rows.filter((row) => row.vendorName).length;
  const withUdyamNumber = rows.filter((row) => row.udyamNumber).length;
  const withPaymentTerms = rows.filter((row) => row.paymentTerms).length;
  const validLooking = rows.filter((row) => row.vendorName && /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/i.test(row.udyamNumber || "")).length;
  return {
    total,
    withVendorName,
    withUdyamNumber,
    withPaymentTerms,
    validLooking,
    missingVendorName: total - withVendorName,
    missingUdyamNumber: total - withUdyamNumber,
    missingPaymentTerms: total - withPaymentTerms,
  };
}

function downloadUdyamTemplate() {
  const sheet = XLSX.utils.aoa_to_sheet([
    UDYAM_IMPORT_HEADERS,
    ["Acme Supplier", "UDYAM-DL-01-1234567", "45 days"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Udyam Import");
  XLSX.writeFile(workbook, "Udyam_Import_Template.xlsx");
}

export default function TallyImport() {
  const [vendors, setVendors] = useState([]);
  const [selectedFY, setSelectedFY] = useState(getCurrentFinancialYear());
  const [asOnDate, setAsOnDate] = useState(defaultAsOnDate(getCurrentFinancialYear()));
  const [importRun, setImportRun] = useState(null);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [tallyHealth, setTallyHealth] = useState(null);
  const [companyName, setCompanyName] = useState("");
  const [importStatus, setImportStatus] = useState("Waiting to connect to Tally");
  const [ledgerVouchers, setLedgerVouchers] = useState([]);
  const [ledgerVoucherTotal, setLedgerVoucherTotal] = useState(0);
  const [voucherPage, setVoucherPage] = useState(1);
  const [importWarnings, setImportWarnings] = useState([]);
  const [voucherFilters, setVoucherFilters] = useState({ search: "", ledgerName: "", voucherType: "" });
  const [udyamCsv, setUdyamCsv] = useState("");
  const [udyamRows, setUdyamRows] = useState([]);
  const [udyamFileName, setUdyamFileName] = useState("");
  const [udyamActivity, setUdyamActivity] = useState([]);
  const [udyamImporting, setUdyamImporting] = useState(false);
  const [notice, setNotice] = useState("");

  const {
    drafts,
    updateDraft,
    verifyingRows,
    mergeMasterIntoVendors,
    saveManualStatus,
    verifyVendor,
    bulkVerify,
    statsFor,
  } = useVendorVerification();

  const fyConfig = FY_CONFIG[selectedFY];
  const creditorVendors = useMemo(() => vendors.filter((vendor) => vendor.isSundryCreditor), [vendors]);
  const verificationStats = statsFor(creditorVendors);
  const workflowStats = useMemo(() => buildWorkflowStats(creditorVendors), [creditorVendors]);
  const actionableVendors = useMemo(() => creditorVendors.filter(isActionableVendor), [creditorVendors]);
  const uniqueLedgers = useMemo(
    () => Array.from(new Set(creditorVendors.map((row) => row.name).filter(Boolean))).sort(),
    [creditorVendors]
  );

  const pendingVendors = useMemo(
    () =>
      creditorVendors.filter((vendor) => {
        const status = vendor.vendorMaster?.verificationStatus;
        const udyamStatus = vendor.vendorMaster?.udyamStatus;
        return !status || ["pending", "failed", "manual_fallback_required", "pending_manual_review", "rejected", "invalid_format", "not_verified"].includes(udyamStatus || status);
      }),
    [creditorVendors]
  );

  const resetAll = () => {
    setVendors([]);
    setImportRun(null);
    setReport(null);
    setLedgerVouchers([]);
    setLedgerVoucherTotal(0);
    setVoucherPage(1);
    setImportWarnings([]);
    setNotice("");
    setStep(1);
    setError("");
    setImportStatus("Waiting to connect to Tally");
  };

  const patchVendorMaster = (vendorName, vendorMaster) => {
    setVendors((prev) => prev.map((vendor) => (vendor.name === vendorName ? { ...vendor, vendorMaster } : vendor)));
  };

  const loadVoucherPage = async (runId, page = 1, filters = voucherFilters) => {
    if (!runId) return;
    const activeLedger = activeVoucherFilter(filters.ledgerName, "All ledgers");
    const activeType = activeVoucherFilter(filters.voucherType, "All voucher types");
    const offset = (page - 1) * VOUCHER_PAGE_SIZE;
    const voucherResponse = await fetchLedgerVouchers(runId, {
      limit: VOUCHER_PAGE_SIZE,
      offset,
      fiscalYear: importRun?.fiscalYear || selectedFY,
      ...(activeLedger ? { ledgerName: activeLedger } : {}),
      ...(activeType ? { voucherType: activeType } : {}),
      ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    });
    const voucherRows = voucherResponse.ledgerVouchers?.rows || voucherResponse.rows || [];
    const voucherTotal = voucherResponse.ledgerVouchers?.total ?? voucherResponse.total ?? voucherRows.length;
    setLedgerVouchers(voucherRows);
    setLedgerVoucherTotal(voucherTotal);
    setVoucherPage(page);
  };

  const updateVoucherFilters = async (updater) => {
    const nextFilters = typeof updater === "function" ? updater(voucherFilters) : updater;
    setVoucherFilters(nextFilters);
    if (importRun?.id) {
      setLoading(true);
      setError("");
      try {
        await loadVoucherPage(importRun.id, 1, nextFilters);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
  };

  const changeVoucherPage = async (page) => {
    if (!importRun?.id || page < 1) return;
    setLoading(true);
    setError("");
    try {
      await loadVoucherPage(importRun.id, page, voucherFilters);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const explainTallyHealth = (health) => {
    if (!health) return "Unable to read Tally health.";
    if (health.serverRunning && health.xmlPostWorking && health.companyDetected) {
      return health.companyName ? `Tally server is running (${health.companyName})` : "Tally server is running";
    }
    if (health.serverRunning && health.xmlPostWorking && health.companyDetected === false) return "Tally server is running; company name not confirmed yet";
    if (health.serverRunning && !health.xmlPostWorking) return "Tally is reachable but XML export failed";
    if (health.reachable || health.serverRunning) return "Tally server is running";
    const details = [health.message, ...(health.errors || [])]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .filter((value) => !String(value).startsWith("Tally timeout after"));
    return details.join(" ");
  };

  const tallyHealthError = (health) => {
    if (!health) return "Unable to read Tally health.";
    if (health.reachable === false) return health.error || health.message || "TallyPrime is not open or port 9000 is unreachable";
    if (health.portOpen === false) return "TallyPrime is not open or port 9000 is unreachable";
    if (health.serverRunning === false) return health.error || health.message || "Tally server is not running";
    if (health.error === "Tally XML export requires active company context.") return "Tally company context could not be established.";
    if (health.xmlPostWorking === false) return "Tally is reachable but XML export failed";
    return null;
  };

  const tallyHealthTone = (health) => {
    if (!health) return "text-gray-600";
    if (health.serverRunning && health.xmlPostWorking && health.companyDetected) return "text-green-700";
    if (health.serverRunning) return "text-yellow-800";
    return "text-red-700";
  };

  const handleImport = async () => {
    setLoading(true);
    setError("");
    setReport(null);
    let progressTimer = null;
    try {
      setImportStatus("Checking Tally connection...");
      const health = await fetchTallyHealth(companyName.trim());
      setTallyHealth(health);
      if (!companyName.trim() && health.companyName) setCompanyName(health.companyName);
      if (health.serverRunning) setImportStatus("Tally server is running");
      if (health.serverRunning && health.xmlPostWorking === false) setImportStatus("Tally is reachable but XML export failed");
      if (health.serverRunning && health.xmlPostWorking && health.companyDetected === false) setImportStatus("Company name not confirmed; trying creditor export...");
      const healthError = tallyHealthError(health);
      if (healthError) throw new Error(healthError);
      setImportStatus("Fetching Sundry Creditors and ledger vouchers from Tally...");
      let progressIndex = 0;
      setImportStatus(`Fetching vouchers ${VOUCHER_PROGRESS_LABELS[progressIndex]}...`);
      progressIndex += 1;
      progressTimer = window.setInterval(() => {
        setImportStatus(`Fetching vouchers ${VOUCHER_PROGRESS_LABELS[progressIndex % VOUCHER_PROGRESS_LABELS.length]}...`);
        progressIndex += 1;
      }, 2500);
      const data = await importFromTally({
        fiscalYear: selectedFY,
        fromDate: fyConfig.fromDate,
        toDate: fyConfig.toDate,
        asOn: asOnDate,
        companyName: companyName.trim() || health.companyName || "",
      });
      if (progressTimer) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }
      if (data.importRun?.companyName) {
        setTallyHealth((prev) => prev ? { ...prev, companyDetected: true, companyName: data.importRun.companyName } : prev);
      }
      setImportRun(data.importRun);
      setImportWarnings([
        ...(data.warnings || []).map((warning) => warning.message || String(warning)),
        ...(data.ignoredNonSundryCount ? [`Ignored ${data.ignoredNonSundryCount} non-creditor ledgers: ${(data.ignoredNonSundrySamples || []).slice(0, 5).join(", ")}`] : []),
        ...(data.importRun?.summary?.fallbackUsed ? [`Voucher source: ${data.importRun.summary.voucherSource}. Fallback was used and logged for audit.`] : []),
      ].filter(Boolean));
      setVendors(mergeMasterIntoVendors(data.creditors));
      setImportStatus("Loading imported voucher rows...");
      const voucherResponse = await fetchLedgerVouchers(data.importRun.id, {
        limit: VOUCHER_PAGE_SIZE,
        offset: 0,
        fiscalYear: data.importRun.fiscalYear || selectedFY,
      });
      setLedgerVouchers(voucherResponse.ledgerVouchers?.rows || voucherResponse.rows || []);
      setLedgerVoucherTotal(voucherResponse.ledgerVouchers?.total ?? voucherResponse.total ?? 0);
      setVoucherPage(1);
      setImportStatus("Import complete");
      setStep(2);
    } catch (err) {
      if (progressTimer) window.clearInterval(progressTimer);
      setImportStatus(err.message?.includes("0 creditor ledgers detected") ? "0 creditor ledgers detected" : "Import failed");
      const message = err.message === "Tally XML export requires active company context."
        ? "Tally company context could not be established."
        : err.message;
      setError(`Could not import from Tally: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (vendor) => {
    setError("");
    try {
      const updated = await saveManualStatus(vendor, drafts[vendor.name] || {});
      patchVendorMaster(vendor.name, updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleVerify = async (vendor) => {
    setError("");
    try {
      const updated = await verifyVendor(vendor, drafts[vendor.name] || {});
      patchVendorMaster(vendor.name, updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkVerify = async (rows) => {
    setError("");
    try {
      await bulkVerify(rows, patchVendorMaster);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleMarkNotRequired = async () => {
    if (!importRun?.id) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await markZeroOutstandingNotRequired(importRun.id);
      setVendors(mergeMasterIntoVendors(response.creditors || []));
      setNotice(`${response.summary?.marked || 0} zero-outstanding creditors marked as not required.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const udyamImportStats = useMemo(() => validateUdyamImportRows(udyamRows), [udyamRows]);

  const handleUdyamFile = async (file) => {
    setError("");
    setNotice("");
    setUdyamFileName(file?.name || "");
    if (!file) {
      setUdyamRows([]);
      return;
    }
    try {
      const extension = file.name.split(".").pop().toLowerCase();
      let rows = [];
      if (extension === "csv") {
        rows = parseUdyamCsvRows(await file.text());
      } else {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = normalizeUdyamRows(XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      }
      const stats = validateUdyamImportRows(rows);
      if (!stats.total) throw new Error("No importable rows found. Use Vendor Name and Udyam Number headers. Payment Terms is optional and defaults to 45 days.");
      if (stats.withVendorName !== stats.total || stats.withUdyamNumber !== stats.total) {
        throw new Error("Every Excel row must include Vendor Name and Udyam Number. Payment Terms is optional and defaults to 45 days.");
      }
      setUdyamRows(rows);
      setUdyamCsv("");
      setNotice(`${rows.length} Udyam rows loaded from ${file.name}.`);
    } catch (err) {
      setUdyamRows([]);
      setError(err.message);
    }
  };

  const handleUdyamImport = async () => {
    setError("");
    setNotice("");
    setUdyamActivity([]);
    setUdyamImporting(true);
    try {
      const rows = udyamRows.length ? udyamRows : parseUdyamCsvRows(udyamCsv);
      const stats = validateUdyamImportRows(rows);
      if (!rows.length) throw new Error("Upload Excel/CSV or paste CSV with headers: Vendor Name,Udyam Number. Payment Terms is optional.");
      if (stats.withVendorName !== stats.total || stats.withUdyamNumber !== stats.total) {
        throw new Error("Every import row must include Vendor Name and Udyam Number. Payment Terms is optional and defaults to 45 days.");
      }
      const response = await importUdyamRowsLive(rows, { autoVerify: true, sourceFileName: udyamFileName }, (event) => {
        setUdyamActivity((prev) => [...prev.slice(-199), event]);
      });
      const summary = response.summary || {};
      setNotice(`Udyam import complete: ${summary.verified || 0} verified, ${summary.manualReview || 0} manual review, ${summary.unmatched || 0} unmatched, ${summary.failed || 0} failed.`);
      const vendorByName = new Map((summary.results || []).filter((row) => row.vendor?.normalizedVendorName).map((row) => [row.vendor.normalizedVendorName, row.vendor]));
      setVendors((prev) => prev.map((vendor) => {
        const normalized = vendor.normalizedVendorName || vendor.vendorMaster?.normalizedVendorName;
        const updated = vendorByName.get(normalized);
        return updated ? { ...vendor, vendorMaster: updated } : vendor;
      }));
    } catch (err) {
      setError(err.message);
      setUdyamActivity((prev) => [...prev, { type: "stream_error", status: "failed", message: err.message, timestamp: new Date().toISOString() }]);
    } finally {
      setUdyamImporting(false);
    }
  };

  const generateReport = async () => {
    if (!importRun?.id) {
      setError("Import from Tally before generating a report.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await createMSMEReport(importRun.id, selectedFY, asOnDate);
      setReport(response.report);
      setStep(4);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-gray-800">Tally Import and MSME Compliance</h2>
        <p className="text-gray-500 text-sm mt-1">Backend-persisted import, mandatory Udyam verification, auditable report generation.</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 mb-4 text-sm font-semibold">{error}</div>}
      {notice && <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 mb-4 text-sm font-semibold">{notice}</div>}
      {importWarnings.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-xl p-3 mb-4 text-sm font-semibold">
          {importWarnings.slice(0, 3).map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}

      <div className="rounded-2xl p-4 mb-4 border border-blue-200 bg-blue-50">
        <div className="flex items-center gap-4 flex-wrap">
          <p className="font-bold text-blue-700">Financial Year:</p>
          {Object.keys(FY_CONFIG).map((fy) => (
            <button
              key={fy}
              onClick={() => {
                setSelectedFY(fy);
                setAsOnDate(defaultAsOnDate(fy));
                resetAll();
              }}
              className={`px-4 py-2 rounded-lg font-semibold text-sm border-2 ${
                selectedFY === fy ? "bg-blue-700 text-white border-blue-700" : "bg-white text-gray-600 border-gray-200"
              }`}>
              {FY_CONFIG[fy].label}
            </button>
          ))}
        </div>
        <p className="text-sm mt-2 font-semibold text-blue-700">
          Applicable: {fyConfig.section} of {fyConfig.act}
        </p>
        <label className="block text-sm mt-3 font-semibold text-blue-700 max-w-xs">
          As-on date
          <input
            type="date"
            value={asOnDate}
            min={toDateInput(fyConfig.fromDate)}
            max={toDateInput(fyConfig.toDate)}
            onChange={(event) => setAsOnDate(event.target.value)}
            className="mt-1 w-full border border-blue-200 rounded-lg px-3 py-2 text-sm text-gray-800 font-normal"
          />
        </label>
        {importRun && (
          <p className="text-xs mt-1 text-blue-700">
            Import run: {importRun.id} | {importRun.companyName || "Company name unavailable"}
          </p>
        )}
        {tallyHealth && (
          <p className={`text-xs mt-1 font-semibold ${tallyHealthTone(tallyHealth)}`}>
            Tally: {explainTallyHealth(tallyHealth)}
          </p>
        )}
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {["Import", "Verify", "Review", "Report"].map((label, index) => (
          <div
            key={label}
            className={`px-3 py-2 rounded-lg text-sm font-semibold ${
              step > index + 1 ? "bg-green-100 text-green-700" : step === index + 1 ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-400"
            }`}>
            {step > index + 1 ? "OK" : index + 1} {label}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="bg-white rounded-2xl p-8 shadow max-w-2xl">
          <h3 className="text-xl font-bold text-gray-800 mb-2">Import Creditors From TallyPrime</h3>
          <p className="text-sm text-gray-600 mb-4">
            Press the import button after TallyPrime is open, XML server is enabled, and the target company is loaded. MSME Guard will fetch all Sundry Creditors and ledger voucher rows for the selected financial year.
          </p>
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-4 text-sm font-semibold text-gray-700">
            {loading ? importStatus : importStatus}
          </div>
          <label className="block text-sm font-semibold text-gray-700 mb-4">
            Tally company name
            <input
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder={tallyHealth?.companyName || "Auto-detect from Tally"}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
              list="tally-company-options"
            />
            <datalist id="tally-company-options">
              {(tallyHealth?.companyNames || []).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <button onClick={handleImport} disabled={loading} className="bg-green-600 text-white px-6 py-3 rounded-lg font-semibold disabled:opacity-50">
            {loading ? "Fetching..." : "Start Tally Import"}
          </button>
        </div>
      )}

      {step === 2 && (
        <>
          <LedgerVoucherPanel
            rows={ledgerVouchers}
            total={ledgerVoucherTotal}
            page={voucherPage}
            pageSize={VOUCHER_PAGE_SIZE}
            uniqueLedgers={uniqueLedgers}
            filters={voucherFilters}
            setFilters={updateVoucherFilters}
            onPageChange={changeVoucherPage}
            onRefresh={handleImport}
            loading={loading}
          />
          <SummaryCards stats={verificationStats} />
          <ReadinessSummary stats={workflowStats} onMarkNotRequired={handleMarkNotRequired} loading={loading} />
          <CreditorLedgerSummary vendors={creditorVendors} />
          <UdyamImportPanel
            csvText={udyamCsv}
            setCsvText={(value) => {
              setUdyamCsv(value);
              if (value) {
                setUdyamRows([]);
                setUdyamFileName("");
              }
            }}
            onImport={handleUdyamImport}
            onFile={handleUdyamFile}
            onTemplate={downloadUdyamTemplate}
            rows={udyamRows}
            fileName={udyamFileName}
            stats={udyamImportStats}
            activity={udyamActivity}
            importing={udyamImporting}
          />
          <VendorVerificationTable
            vendors={actionableVendors}
            drafts={drafts}
            updateDraft={updateDraft}
            verifyingRows={verifyingRows}
            onVerify={handleVerify}
            onSave={handleSave}
            onBulkVerify={handleBulkVerify}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={resetAll} className="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-semibold">Back</button>
            <button onClick={() => setStep(3)} className="bg-green-600 text-white px-6 py-2 rounded-lg font-semibold text-sm">Review Results</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <LedgerVoucherPanel
            rows={ledgerVouchers}
            total={ledgerVoucherTotal}
            page={voucherPage}
            pageSize={VOUCHER_PAGE_SIZE}
            uniqueLedgers={uniqueLedgers}
            filters={voucherFilters}
            setFilters={updateVoucherFilters}
            onPageChange={changeVoucherPage}
            onRefresh={handleImport}
            loading={loading}
          />
          <div className="bg-white rounded-2xl p-6 shadow">
            <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
              <div>
                <h3 className="text-xl font-bold text-gray-800">Review Report Readiness</h3>
                <p className="text-sm text-gray-500">Only backend-verified MSME vendors will be included.</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setStep(2)} className="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-semibold">Back</button>
                <button
                  onClick={generateReport}
                  disabled={loading}
                  className="bg-green-600 text-white px-6 py-3 rounded-lg font-semibold disabled:opacity-50">
                  {loading ? "Generating..." : "Generate Backend Report"}
                </button>
              </div>
            </div>
            {pendingVendors.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 mb-4 text-sm text-yellow-800 font-semibold">
                {pendingVendors.length} vendors will be excluded from the verified report and listed with reasons.
              </div>
            )}
          <SummaryCards stats={verificationStats} />
            <ReadinessSummary stats={workflowStats} onMarkNotRequired={handleMarkNotRequired} loading={loading} />
            <CreditorLedgerSummary vendors={creditorVendors} />
            <VendorReviewTable vendors={creditorVendors} />
          </div>
        </>
      )}

      {step === 4 && report && (
        <div className="bg-white rounded-2xl p-6 shadow">
          <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
            <div>
              <h3 className="text-xl font-bold text-gray-800">Compliance Report</h3>
              <p className="text-sm text-gray-500">Report snapshot: {report.id}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => downloadReportFile(report.id, "csv")} className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">Download CSV</button>
              <button onClick={() => downloadReportFile(report.id, "xml")} className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">Download XML</button>
              <button onClick={() => downloadUrl(reportEvidenceBundleUrl(report.id), `MSME_Evidence_Bundle_${report.id}.zip`)} className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-semibold">Evidence Bundle</button>
              <button onClick={() => downloadUrl(reportTallyReconciliationUrl(report.id), `MSME_Tally_Reconciliation_${report.id}.csv`)} className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold">Reconciliation</button>
            </div>
          </div>
          <ReportMetrics summary={report.summary} />
          <ReportTable rows={report.report} />
        </div>
      )}
    </div>
  );
}

function getCurrentFinancialYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const startYear = month >= 3 ? year : year - 1;
  const key = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  return FY_CONFIG[key] ? key : "2025-26";
}

function LedgerVoucherPanel({ rows, total, page, pageSize, uniqueLedgers, filters, setFilters, onPageChange, onRefresh, loading }) {
  const voucherTypes = ["Journal", "Payment", "Purchase"];
  const totalPages = Math.max(Math.ceil((total || 0) / pageSize), 1);
  const firstRow = total ? (page - 1) * pageSize + 1 : 0;
  const lastRow = total ? Math.min((page - 1) * pageSize + rows.length, total) : 0;
  const update = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  return (
    <div className="bg-white rounded-2xl p-5 shadow mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-800">Tally Ledger Vouchers</h3>
          <p className="text-xs text-gray-500">
            Showing {firstRow.toLocaleString("en-IN")}-{lastRow.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")} imported voucher rows.
          </p>
        </div>
        <button onClick={onRefresh} disabled={loading} className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
          {loading ? "Refreshing..." : "Refresh from Tally"}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <input
          value={filters.search}
          onChange={(event) => update("search", event.target.value)}
          placeholder="Search ledger, particulars, voucher no."
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
        <select value={filters.ledgerName} onChange={(event) => update("ledgerName", event.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="">All ledgers</option>
          {uniqueLedgers.map((ledger) => <option key={ledger} value={ledger}>{ledger}</option>)}
        </select>
        <select value={filters.voucherType} onChange={(event) => update("voucherType", event.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="">All voucher types</option>
          {voucherTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </div>
      <div className="max-h-80 overflow-auto border border-gray-100 rounded-xl">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50">
            <tr>
              <th className="text-left p-2">Date</th>
              <th className="text-left p-2">Ledger</th>
              <th className="text-left p-2">Particulars</th>
              <th className="text-left p-2">Bill Ref</th>
              <th className="text-left p-2">Vch Type</th>
              <th className="text-left p-2">Vch No.</th>
              <th className="text-right p-2">Debit</th>
              <th className="text-right p-2">Credit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-2 whitespace-nowrap text-xs">{formatDisplayDate(row.date)}</td>
                <td className="p-2 text-xs font-semibold">{row.ledgerName}</td>
                <td className="p-2 text-xs">{row.particulars || "-"}</td>
                <td className="p-2 text-xs">{row.billReference || "-"}</td>
                <td className="p-2 text-xs">{row.voucherType || "-"}</td>
                <td className="p-2 text-xs">{row.voucherNumber || "-"}</td>
                <td className="p-2 text-right text-xs">{row.debit ? row.debit.toLocaleString("en-IN") : ""}</td>
                <td className="p-2 text-right text-xs">{row.credit ? row.credit.toLocaleString("en-IN") : ""}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td className="p-4 text-center text-gray-500 text-sm" colSpan="8">No ledger voucher rows found for the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap mt-3">
        <p className="text-xs text-gray-500">Page {page.toLocaleString("en-IN")} of {totalPages.toLocaleString("en-IN")}</p>
        <div className="flex gap-2">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={loading || page <= 1}
            className="bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50">
            Previous
          </button>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={loading || page >= totalPages}
            className="bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function toDateInput(tallyDate) {
  const value = String(tallyDate || "");
  if (!/^\d{8}$/.test(value)) return "";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function defaultAsOnDate(fy) {
  const config = FY_CONFIG[fy] || FY_CONFIG["2025-26"];
  const today = new Date().toISOString().slice(0, 10);
  const fyEnd = toDateInput(config.toDate);
  return today > fyEnd ? fyEnd : today;
}

function isActionableVendor(vendor) {
  const actionStatus = vendor.vendorMaster?.actionStatus || "pending_action";
  if (actionStatus === "not_required_zero_outstanding" || actionStatus === "non_msme" || actionStatus === "verified_msme") return false;
  return Number(vendor.voucherCount || 0) > 0 || Math.abs(Number(vendor.outstandingAmount || 0)) > 0 || actionStatus === "manual_review" || actionStatus === "failed";
}

function buildWorkflowStats(vendors) {
  const importedCreditors = vendors.length;
  const activeCreditorLedgers = vendors.filter((vendor) => Number(vendor.voucherCount || 0) > 0).length;
  const nonZeroOutstandingCreditors = vendors.filter((vendor) => Math.abs(Number(vendor.outstandingAmount || 0)) > 0).length;
  const pendingActionable = vendors.filter(isActionableVendor).length;
  const markedNotRequired = vendors.filter((vendor) => vendor.vendorMaster?.actionStatus === "not_required_zero_outstanding").length;
  const verifiedMSME = vendors.filter((vendor) => vendor.vendorMaster?.isMSME && ["verified", "approved"].includes(vendor.vendorMaster?.udyamStatus)).length;
  const nonMSME = vendors.filter((vendor) => vendor.vendorMaster?.verificationStatus === "not_msme").length;
  const excluded = vendors.filter((vendor) => vendor.vendorMaster?.excludedReason || !vendor.vendorMaster || !vendor.vendorMaster?.isMSME).length;
  return { importedCreditors, activeCreditorLedgers, nonZeroOutstandingCreditors, pendingActionable, markedNotRequired, verifiedMSME, nonMSME, excluded };
}

function ReadinessSummary({ stats, onMarkNotRequired, loading }) {
  const cards = [
    { label: "Imported Creditors", value: stats.importedCreditors, color: "bg-blue-100 text-blue-700" },
    { label: "With Voucher Rows", value: stats.activeCreditorLedgers, color: "bg-cyan-100 text-cyan-700" },
    { label: "Non-Zero Outstanding", value: stats.nonZeroOutstandingCreditors, color: "bg-yellow-100 text-yellow-700" },
    { label: "Pending Action", value: stats.pendingActionable, color: "bg-orange-100 text-orange-700" },
    { label: "Not Required", value: stats.markedNotRequired, color: "bg-gray-100 text-gray-700" },
    { label: "Verified MSME", value: stats.verifiedMSME, color: "bg-green-100 text-green-700" },
  ];
  return (
    <div className="bg-white rounded-2xl p-5 shadow mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-800">Readiness Summary</h3>
          <p className="text-xs text-gray-500 mt-1">Action queue is narrowed to creditors with current FY activity, outstanding balance, or manual review work.</p>
        </div>
        <button
          onClick={onMarkNotRequired}
          disabled={loading}
          className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
          Mark zero outstanding as not required
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {cards.map((card) => <Metric key={card.label} {...card} />)}
      </div>
    </div>
  );
}

function UdyamImportPanel({ csvText, setCsvText, onImport, onFile, onTemplate, rows, fileName, stats, activity, importing }) {
  const previewRows = rows.slice(0, 5);
  return (
    <div className="bg-white rounded-lg p-5 shadow mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-lg font-bold text-gray-800">Udyam Excel / CSV Import</h3>
          <p className="text-xs text-gray-500 mt-1">Vendor Name and Udyam Number are mandatory. Payment Terms is optional and defaults to 45 days.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={onTemplate} className="bg-gray-100 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold">Template</button>
          <button onClick={onImport} disabled={importing} className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
            {importing ? "Verifying..." : "Import and Verify"}
          </button>
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <label className="block border border-gray-200 rounded-lg p-3">
          <span className="block text-xs font-semibold text-gray-700 mb-2">Upload Excel or CSV</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(event) => onFile(event.target.files?.[0] || null)}
            className="block w-full text-sm"
          />
          <span className="block text-xs text-gray-500 mt-2">{fileName || "No file selected"}</span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <MiniStat label="Rows" value={stats.total} />
          <MiniStat label="Valid Format" value={stats.validLooking} />
          <MiniStat label="Missing Vendor" value={stats.missingVendorName} />
          <MiniStat label="Missing Udyam" value={stats.missingUdyamNumber} />
          <MiniStat label="Defaulted Terms" value={stats.missingPaymentTerms} />
        </div>
      </div>
      {previewRows.length > 0 && (
        <div className="overflow-auto border border-gray-100 rounded-lg mb-3">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">Vendor</th>
                <th className="text-left p-2">Udyam</th>
                <th className="text-left p-2">Payment Terms</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, index) => (
                <tr key={`${row.vendorName}-${index}`} className="border-t">
                  <td className="p-2">{row.vendorName}</td>
                  <td className="p-2">{row.udyamNumber}</td>
                  <td className="p-2">{row.paymentTerms ? `${row.paymentTerms} days` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <textarea
        value={csvText}
        onChange={(event) => setCsvText(event.target.value)}
        rows={4}
        className="w-full border border-gray-200 rounded-lg p-3 text-xs font-mono"
        placeholder={'Vendor Name,Udyam Number\nAcme Supplier,UDYAM-DL-01-1234567'}
      />
      <div className="mt-3 border border-gray-100 rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-3 py-2 flex items-center justify-between">
          <span className="text-xs font-bold text-gray-700">Live Udyam Verification Activity</span>
          <span className="text-[11px] text-gray-500">{importing ? "Running" : "Idle"}</span>
        </div>
        <div className="max-h-44 overflow-auto bg-white">
          {activity.length === 0 ? (
            <p className="p-3 text-xs text-gray-400">Activity will appear here during Import and Verify.</p>
          ) : activity.map((event, index) => (
            <div key={`${event.timestamp || ""}-${index}`} className="px-3 py-2 border-t text-xs">
              <span className="font-mono text-gray-500">{event.type}</span>
              {event.vendorName && <span className="ml-2 font-semibold text-gray-800">{event.vendorName}</span>}
              <span className={event.type?.includes("failed") || event.type === "stream_error" ? "ml-2 text-red-700" : "ml-2 text-gray-600"}>
                {event.message || event.status || ""}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <p className="text-lg font-bold text-gray-800">{Number(value || 0).toLocaleString("en-IN")}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function formatDisplayDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN");
}

function SummaryCards({ stats }) {
  const cards = [
    { label: "Total Vendors", value: stats.total, color: "bg-blue-100 text-blue-700" },
    { label: "Verified MSME", value: stats.verifiedMSME, color: "bg-green-100 text-green-700" },
    { label: "Pending", value: stats.pendingVerification, color: "bg-yellow-100 text-yellow-700" },
    { label: "Non-MSME", value: stats.nonMSME, color: "bg-gray-100 text-gray-700" },
    { label: "Failed/Fallback", value: stats.failedVerification, color: "bg-red-100 text-red-700" },
  ];
  return <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">{cards.map((card) => <Metric key={card.label} {...card} />)}</div>;
}

function CreditorLedgerSummary({ vendors }) {
  const activeVendors = vendors.filter((vendor) => vendor.voucherCount > 0 || vendor.outstandingAmount > 0);
  const zeroActivityCount = vendors.length - activeVendors.length;
  const totalOpening = vendors.reduce((sum, vendor) => sum + Number(vendor.openingBalance || 0), 0);
  const totalClosing = vendors.reduce((sum, vendor) => sum + Number(vendor.closingBalance || 0), 0);
  const totalOutstanding = vendors.reduce((sum, vendor) => sum + Number(vendor.ledgerOutstandingAmount ?? vendor.outstandingAmount ?? 0), 0);

  return (
    <div className="bg-white rounded-2xl p-6 shadow mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Complete Creditor Ledger Summary</h3>
          <p className="text-sm text-gray-500 mt-1">
            Ledger closing credit is used as payable outstanding. Voucher aging is shown separately for delay and evidence.
          </p>
        </div>
        <div className="text-right text-xs text-gray-500">
          <p>{vendors.length.toLocaleString("en-IN")} creditor ledgers</p>
          <p>{zeroActivityCount.toLocaleString("en-IN")} with zero FY voucher activity/outstanding</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <Metric label="Opening Balance" value={`Rs ${Math.abs(totalOpening).toLocaleString("en-IN")}`} color="bg-blue-100 text-blue-700" />
        <Metric label="Ledger Payable Outstanding" value={`Rs ${totalOutstanding.toLocaleString("en-IN")}`} color="bg-yellow-100 text-yellow-700" />
        <Metric label="Closing Balance" value={`Rs ${Math.abs(totalClosing).toLocaleString("en-IN")}`} color="bg-green-100 text-green-700" />
      </div>
      <div className="max-h-72 overflow-auto border border-gray-100 rounded-xl">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50">
            <tr>
              <th className="text-left p-2">Creditor Ledger</th>
              <th className="text-left p-2">PAN Card</th>
              <th className="text-right p-2">Opening</th>
              <th className="text-right p-2">Voucher Rows</th>
              <th className="text-right p-2">Ledger Payable Outstanding</th>
              <th className="text-right p-2">Voucher-only Outstanding</th>
              <th className="text-right p-2">Closing</th>
              <th className="text-right p-2">Days</th>
              <th className="text-left p-2">Balance Source</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((vendor) => (
              <tr key={vendor.name} className="border-t">
                <td className="p-2 text-xs font-semibold">{vendor.name}</td>
                <td className="p-2 text-xs font-mono">{vendor.panNumber || vendor.vendorMaster?.panNumber || <span className="text-gray-400 font-sans">Not available</span>}</td>
                <td className="p-2 text-right text-xs">{formatLedgerBalance(vendor.openingBalance, vendor.openingBalanceRaw)}</td>
                <td className="p-2 text-right text-xs">{Number(vendor.voucherCount || 0).toLocaleString("en-IN")}</td>
                <td className="p-2 text-right text-xs font-semibold text-gray-800">{formatPayableAmount(vendor.ledgerOutstandingAmount ?? vendor.outstandingAmount)}</td>
                <td className="p-2 text-right text-xs">{formatPayableAmount(vendor.voucherOutstandingAmount || 0)}</td>
                <td className="p-2 text-right text-xs">{formatLedgerBalance(vendor.closingBalance, vendor.closingBalanceRaw)}</td>
                <td className="p-2 text-right text-xs">{vendor.daysOutstanding ?? "N/A"}</td>
                <td className="p-2 text-left text-xs">
                  {vendor.outstandingMismatch ? (
                    <span className="text-orange-700 font-semibold">Ledger used; voucher mismatch</span>
                  ) : (
                    <span className="text-green-700">Ledger closing credit</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metric({ label, value, color }) {
  return <div className={`p-4 rounded-2xl ${color} text-center`}><p className="text-xl font-bold">{value}</p><p className="text-xs mt-1">{label}</p></div>;
}

function formatMoney(value) {
  const number = Number(value || 0);
  if (!number) return "0";
  const formatted = Math.abs(number).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return number < 0 ? `${formatted} Cr` : `${formatted} Dr`;
}

function formatPayableAmount(value) {
  const number = Number(value || 0);
  if (!number) return "0";
  return `${Math.abs(number).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
}

function formatLedgerBalance(value, raw) {
  if (!raw && !Number(value || 0)) return "Unavailable";
  return formatMoney(value);
}

function ReportMetrics({ summary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <Metric label="Report Vendors" value={summary.reportVendors || 0} color="bg-green-100 text-green-700" />
      <Metric label="Disallowed" value={`Rs ${(summary.totalDisallowed || 0).toLocaleString("en-IN")}`} color="bg-red-100 text-red-700" />
      <Metric label="Tax Impact" value={`Rs ${(summary.totalTaxImpact || 0).toLocaleString("en-IN")}`} color="bg-orange-100 text-orange-700" />
      <Metric label="Interest" value={`Rs ${(summary.totalInterest || 0).toLocaleString("en-IN")}`} color="bg-yellow-100 text-yellow-700" />
    </div>
  );
}

function VendorReviewTable({ vendors }) {
  return (
    <div className="max-h-96 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-50"><tr><th className="text-left p-2">Vendor</th><th className="text-left p-2">Status</th><th className="text-left p-2">Type</th><th className="text-right p-2">Outstanding</th><th className="text-right p-2">Days</th></tr></thead>
        <tbody>
          {vendors.map((vendor) => (
            <tr key={vendor.name} className="border-t">
              <td className="p-2 font-semibold text-xs">{vendor.name}</td>
              <td className="p-2 text-xs">{vendor.vendorMaster?.udyamStatus || vendor.vendorMaster?.verificationStatus || "pending"}</td>
              <td className="p-2 text-xs">{vendor.vendorMaster?.enterpriseType || "-"}</td>
              <td className="p-2 text-right text-xs">{vendor.outstandingAmount.toLocaleString("en-IN")}</td>
              <td className="p-2 text-right text-xs">{vendor.daysOutstanding ?? "N/A"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportTable({ rows }) {
  return (
    <div className="max-h-96 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-50"><tr><th className="text-left p-2">Vendor</th><th className="text-left p-2">Udyam</th><th className="text-left p-2">Type</th><th className="text-right p-2">Disallowed</th><th className="text-right p-2">Interest</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.vendorName} className="border-t">
              <td className="p-2 font-semibold text-xs">{row.vendorName}</td>
              <td className="p-2 text-xs">{row.udyamNumber}</td>
              <td className="p-2 text-xs">{row.enterpriseType}</td>
              <td className="p-2 text-right text-xs">{row.disallowed.toLocaleString("en-IN")}</td>
              <td className="p-2 text-right text-xs">{row.interest.toLocaleString("en-IN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
