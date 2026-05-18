import { useMemo, useState } from "react";
import VendorVerificationTable from "./components/VendorVerificationTable";
import { createMSMEReport, downloadReportFile, fetchLedgerVouchers, fetchTallyHealth, importFromTally } from "./services/api";
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
    act: "Income Tax Act, 1961",
    section: "Section 43B(h)",
    fromDate: "20260401",
    toDate: "20270331",
  },
};

const VOUCHER_PROGRESS_LABELS = ["Apr-Jun", "Jul-Sep", "Oct-Dec", "Jan-Mar"];

function activeVoucherFilter(value, allLabel) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === allLabel.toLowerCase() || normalized === "all" ? "" : value;
}

export default function TallyImport() {
  const [vendors, setVendors] = useState([]);
  const [selectedFY, setSelectedFY] = useState(getCurrentFinancialYear());
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
  const [importWarnings, setImportWarnings] = useState([]);
  const [voucherFilters, setVoucherFilters] = useState({ search: "", ledgerName: "", voucherType: "" });

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
  const verificationStats = statsFor(vendors);
  const uniqueLedgers = useMemo(
    () => Array.from(new Set(ledgerVouchers.map((row) => row.ledgerName).filter(Boolean))).sort(),
    [ledgerVouchers]
  );
  const filteredLedgerVouchers = useMemo(() => {
    const search = voucherFilters.search.trim().toLowerCase();
    const ledger = activeVoucherFilter(voucherFilters.ledgerName, "All ledgers");
    const type = activeVoucherFilter(voucherFilters.voucherType, "All voucher types");
    return ledgerVouchers.filter((row) => {
      if (ledger && row.ledgerName !== ledger) return false;
      if (type && row.voucherType !== type) return false;
      if (!search) return true;
      return [row.ledgerName, row.particulars, row.voucherNumber, row.voucherType].some((value) =>
        String(value || "").toLowerCase().includes(search)
      );
    });
  }, [ledgerVouchers, voucherFilters]);

  const pendingVendors = useMemo(
    () =>
      vendors.filter((vendor) => {
        const status = vendor.vendorMaster?.verificationStatus;
        const udyamStatus = vendor.vendorMaster?.udyamStatus;
        return !status || ["pending", "failed", "manual_fallback_required", "pending_manual_review", "rejected", "invalid_format", "not_verified"].includes(udyamStatus || status);
      }),
    [vendors]
  );

  const resetAll = () => {
    setVendors([]);
    setImportRun(null);
    setReport(null);
    setLedgerVouchers([]);
    setLedgerVoucherTotal(0);
    setImportWarnings([]);
    setStep(1);
    setError("");
    setImportStatus("Waiting to connect to Tally");
  };

  const patchVendorMaster = (vendorName, vendorMaster) => {
    setVendors((prev) => prev.map((vendor) => (vendor.name === vendorName ? { ...vendor, vendorMaster } : vendor)));
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
        ...(data.importRun?.summary?.fallbackUsed ? [`Voucher source: ${data.importRun.summary.voucherSource}. Fallback was used and logged for audit.`] : []),
      ].filter(Boolean));
      setVendors(mergeMasterIntoVendors(data.creditors));
      setImportStatus("Loading imported voucher rows...");
      const voucherResponse = await fetchLedgerVouchers(data.importRun.id, { limit: 1000, fiscalYear: data.importRun.fiscalYear || selectedFY });
      const voucherRows = voucherResponse.ledgerVouchers?.rows || voucherResponse.rows || [];
      const voucherTotal = voucherResponse.ledgerVouchers?.total ?? voucherResponse.total ?? voucherRows.length;
      setLedgerVouchers(voucherRows);
      setLedgerVoucherTotal(voucherTotal);
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

  const generateReport = async () => {
    if (!importRun?.id) {
      setError("Import from Tally before generating a report.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await createMSMEReport(importRun.id, selectedFY);
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
            rows={filteredLedgerVouchers}
            total={ledgerVoucherTotal}
            loaded={ledgerVouchers.length}
            uniqueLedgers={uniqueLedgers}
            filters={voucherFilters}
            setFilters={setVoucherFilters}
            onRefresh={handleImport}
            loading={loading}
          />
          <SummaryCards stats={verificationStats} />
          <VendorVerificationTable
            vendors={vendors}
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
            rows={filteredLedgerVouchers}
            total={ledgerVoucherTotal}
            loaded={ledgerVouchers.length}
            uniqueLedgers={uniqueLedgers}
            filters={voucherFilters}
            setFilters={setVoucherFilters}
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
            <VendorReviewTable vendors={vendors} />
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

function LedgerVoucherPanel({ rows, total, loaded, uniqueLedgers, filters, setFilters, onRefresh, loading }) {
  const voucherTypes = useMemo(() => Array.from(new Set(rows.map((row) => row.voucherType).filter(Boolean))).sort(), [rows]);
  const update = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  return (
    <div className="bg-white rounded-2xl p-5 shadow mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-800">Tally Ledger Vouchers</h3>
          <p className="text-xs text-gray-500">
            Showing {rows.length.toLocaleString("en-IN")} rows. Loaded {loaded.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")} imported rows.
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
            {rows.slice(0, 300).map((row) => (
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
      {rows.length > 300 && <p className="text-xs text-gray-500 mt-2">Showing first 300 filtered rows to keep the screen fast. Use filters to narrow the ledger view.</p>}
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

function Metric({ label, value, color }) {
  return <div className={`p-4 rounded-2xl ${color} text-center`}><p className="text-xl font-bold">{value}</p><p className="text-xs mt-1">{label}</p></div>;
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
