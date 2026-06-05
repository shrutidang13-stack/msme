import { useEffect, useMemo, useState } from "react";
import {
  downloadUrl,
  fetchMcaMsme1Filings,
  fetchReports,
  generateMcaMsme1,
  generateMcaMsme1Xml,
  mcaMsme1DownloadUrl,
  mcaMsme1XmlDownloadUrl,
  previewMcaMsme1,
  recordMcaMsme1Srn,
  startMcaMsme1Upload,
  uploadMcaMsme1Excel,
} from "./services/api";

const HALF_YEARS = [
  ["oct-mar", "October-March"],
  ["apr-sep", "April-September"],
];

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortDate(value) {
  return value ? new Date(value).toLocaleString("en-IN") : "";
}

export default function MCAMSME1Filing() {
  const [reports, setReports] = useState([]);
  const [filings, setFilings] = useState([]);
  const [reportId, setReportId] = useState("");
  const [halfYear, setHalfYear] = useState("oct-mar");
  const [preview, setPreview] = useState(null);
  const [selectedFiling, setSelectedFiling] = useState(null);
  const [mcaUserId, setMcaUserId] = useState("");
  const [companyDetails, setCompanyDetails] = useState({ cin: "", companyName: "" });
  const [uploadedRows, setUploadedRows] = useState([]);
  const [xmlGeneration, setXmlGeneration] = useState(null);
  const [srn, setSrn] = useState("");
  const [loading, setLoading] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedReport = useMemo(() => reports.find((report) => report.id === reportId), [reports, reportId]);
  const blockingErrors = preview?.validation?.errors || [];
  const warnings = preview?.validation?.warnings || [];
  const canGenerate = preview && blockingErrors.length === 0 && !loading;

  const loadBase = async () => {
    const [reportData, filingData] = await Promise.all([fetchReports(), fetchMcaMsme1Filings()]);
    setReports(reportData.reports || []);
    setFilings(filingData.filings || []);
    setReportId((current) => current || reportData.reports?.[0]?.id || "");
  };

  useEffect(() => {
    loadBase().catch((err) => setError(err.message));
  }, []);

  const runPreview = async () => {
    if (!reportId) return;
    setLoading("preview");
    setError("");
    setMessage("");
    try {
      const response = await previewMcaMsme1({ reportId, halfYear });
      setPreview(response.preview);
      setMessage(`Preview ready: ${response.preview.eligibleRowCount} MCA supplier rows.`);
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally {
      setLoading("");
    }
  };

  const generateUtility = async () => {
    if (!reportId) return;
    setLoading("generate");
    setError("");
    setMessage("");
    try {
      const response = await generateMcaMsme1({ reportId, halfYear });
      setPreview(response.preview);
      setSelectedFiling(response.filing);
      await loadBase();
      if (response.generated) {
        setMessage("MCA MSME-1 utility generated. Download the .xlsm and upload it on MCA V3.");
      } else {
        setMessage("Generation blocked. Fix validation errors, especially missing PAN, then generate again.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  };

  const downloadFiling = async (filing) => {
    if (!filing?.id) return;
    setError("");
    try {
      await downloadUrl(mcaMsme1DownloadUrl(filing.id), `MCA_MSME1_${filing.fiscalYear}_${filing.halfYear}.xlsm`);
    } catch (err) {
      setError(err.message);
    }
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop());
    reader.onerror = () => reject(reader.error || new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });

  const uploadExcel = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !reportId) return;
    setLoading("upload-excel");
    setError("");
    setMessage("");
    try {
      const contentBase64 = await fileToBase64(file);
      const response = await uploadMcaMsme1Excel({
        reportId,
        fileName: file.name,
        contentBase64,
        companyDetails,
        fiscalYear: selectedReport?.fiscalYear,
        halfYear,
      });
      setSelectedFiling(response.filing);
      setUploadedRows(response.rows || []);
      await loadBase();
      setMessage(response.validation?.valid ? "Uploaded MCA Excel validated." : "Uploaded MCA Excel has validation errors.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
      event.target.value = "";
    }
  };

  const generateXml = async () => {
    if (!selectedFiling?.id) return;
    setLoading("xml");
    setError("");
    setMessage("");
    try {
      const response = await generateMcaMsme1Xml({ filingId: selectedFiling.id, companyDetails });
      setXmlGeneration(response);
      if (response.generated) {
        setMessage("MCA MSME-1 XML generated and ready to download.");
        await loadBase();
      } else {
        setMessage("XML generation blocked. Fix validation errors first.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  };

  const downloadXml = async () => {
    if (!xmlGeneration?.generationId) return;
    await downloadUrl(mcaMsme1XmlDownloadUrl(xmlGeneration.generationId), `MCA_MSME1_${selectedFiling?.fiscalYear}_${selectedFiling?.halfYear}.xml`);
  };

  const beginUpload = async () => {
    if (!selectedFiling?.id) return;
    setLoading("upload");
    setError("");
    try {
      const response = await startMcaMsme1Upload(selectedFiling.id, mcaUserId);
      setSelectedFiling(response.filing);
      await loadBase();
      setMessage(response.message);
      window.open(response.uploadUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  };

  const saveSrn = async () => {
    if (!selectedFiling?.id || !srn.trim()) return;
    setLoading("srn");
    setError("");
    try {
      const response = await recordMcaMsme1Srn(selectedFiling.id, srn.trim());
      setSelectedFiling(response.filing);
      setSrn("");
      await loadBase();
      setMessage("SRN recorded and filing marked submitted.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">MCA MSME-1 Filing</h2>
        <p className="text-sm text-gray-500 mt-1">Generate the MCA V3 MSME-1 macro utility from verified MSME report rows and corrected ledger outstanding.</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm font-semibold">{error}</div>}
      {message && <div className="bg-blue-50 border border-blue-200 text-blue-700 rounded-lg p-3 mb-4 text-sm font-semibold">{message}</div>}

      <div className="grid xl:grid-cols-[1fr_0.85fr] gap-5">
        <section className="bg-white rounded-lg p-5 shadow">
          <div className="grid md:grid-cols-[1.2fr_0.7fr] gap-4">
            <label className="block">
              <span className="block text-xs font-semibold text-gray-700 mb-1">Completed Report</span>
              <select value={reportId} onChange={(event) => { setReportId(event.target.value); setPreview(null); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Select report</option>
                {reports.map((report) => (
                  <option key={report.id} value={report.id}>
                    {report.fiscalYear} | {shortDate(report.createdAt)} | import {report.importRunId}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-700 mb-1">Half-Year</span>
              <select value={halfYear} onChange={(event) => { setHalfYear(event.target.value); setPreview(null); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                {HALF_YEARS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mt-4">
            <label className="block">
              <span className="block text-xs font-semibold text-gray-700 mb-1">Company CIN</span>
              <input value={companyDetails.cin} onChange={(event) => setCompanyDetails((prev) => ({ ...prev, cin: event.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Required for XML" />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-700 mb-1">Company Name</span>
              <input value={companyDetails.companyName} onChange={(event) => setCompanyDetails((prev) => ({ ...prev, companyName: event.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Required for XML" />
            </label>
          </div>

          <div className="flex flex-wrap gap-2 mt-5">
            <button onClick={runPreview} disabled={!reportId || Boolean(loading)} className="bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
              {loading === "preview" ? "Preparing..." : "Preview MCA Rows"}
            </button>
            <button onClick={generateUtility} disabled={!canGenerate} className="bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
              {loading === "generate" ? "Generating..." : "Generate .xlsm"}
            </button>
            {selectedFiling?.downloadUrl && (
              <button onClick={() => downloadFiling(selectedFiling)} className="bg-gray-900 text-white px-5 py-2 rounded-lg text-sm font-semibold">Download .xlsm</button>
            )}
            <label className="bg-gray-100 text-gray-800 px-5 py-2 rounded-lg text-sm font-semibold cursor-pointer">
              {loading === "upload-excel" ? "Uploading..." : "Upload Excel"}
              <input type="file" accept=".xlsx,.xlsm" onChange={uploadExcel} className="hidden" disabled={!reportId || Boolean(loading)} />
            </label>
            <button onClick={generateXml} disabled={!selectedFiling?.id || Boolean(loading)} className="bg-purple-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
              {loading === "xml" ? "Generating XML..." : "Generate XML"}
            </button>
            {xmlGeneration?.generated && (
              <button onClick={downloadXml} className="bg-purple-100 text-purple-800 px-5 py-2 rounded-lg text-sm font-semibold">Download XML</button>
            )}
          </div>

          {uploadedRows.length > 0 && (
            <p className="text-xs text-gray-500 mt-3">{uploadedRows.length.toLocaleString("en-IN")} supplier rows uploaded from MCA Excel.</p>
          )}

          {selectedReport && (
            <div className="grid md:grid-cols-3 gap-3 mt-5">
              <Metric label="Fiscal Year" value={selectedReport.fiscalYear} />
              <Metric label="Import Run" value={selectedReport.importRunId} />
              <Metric label="Created" value={shortDate(selectedReport.createdAt)} />
            </div>
          )}
        </section>

        <section className="bg-white rounded-lg p-5 shadow">
          <h3 className="text-lg font-bold text-gray-800 mb-3">Assisted MCA Upload</h3>
          <p className="text-sm text-gray-500 mb-4">The app opens MCA V3 for upload, but login, CAPTCHA, OTP, DSC, and final submission stay manual.</p>
          <label className="block mb-3">
            <span className="block text-xs font-semibold text-gray-700 mb-1">MCA User ID</span>
            <input value={mcaUserId} onChange={(event) => setMcaUserId(event.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Optional; stored only as filing reference" />
          </label>
          <button onClick={beginUpload} disabled={!selectedFiling?.downloadUrl || Boolean(loading)} className="bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
            {loading === "upload" ? "Opening..." : "Start Assisted Upload"}
          </button>

          <div className="border-t mt-5 pt-4">
            <label className="block mb-3">
              <span className="block text-xs font-semibold text-gray-700 mb-1">SRN After MCA Submission</span>
              <input value={srn} onChange={(event) => setSrn(event.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Enter MCA SRN" />
            </label>
            <button onClick={saveSrn} disabled={!selectedFiling?.id || !srn.trim() || Boolean(loading)} className="bg-gray-800 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
              {loading === "srn" ? "Saving..." : "Record SRN"}
            </button>
          </div>
        </section>
      </div>

      {preview && (
        <section className="bg-white rounded-lg p-5 shadow mt-5">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-lg font-bold text-gray-800">MCA Row Preview</h3>
              <p className="text-sm text-gray-500">{preview.halfYearLabel} | {preview.period.from} to {preview.period.to}</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <SmallMetric label="Rows" value={preview.eligibleRowCount} />
              <SmallMetric label="Errors" value={blockingErrors.length} tone={blockingErrors.length ? "red" : "green"} />
              <SmallMetric label="Warnings" value={warnings.length} tone={warnings.length ? "yellow" : "gray"} />
              <SmallMetric label="Outstanding >45" value={`Rs ${formatMoney(preview.totals.outstandingMoreThan45Amount)}`} />
              <SmallMetric label="Section 16 Interest" value={`Rs ${formatMoney(preview.totals.section16Interest)}`} tone="yellow" />
            </div>
          </div>

          {blockingErrors.length > 0 && (
            <IssueList title="Blocking Validation Errors" tone="red" issues={blockingErrors} />
          )}
          {warnings.length > 0 && (
            <IssueList title="Warnings" tone="yellow" issues={warnings} />
          )}

          <div className="overflow-auto max-h-[30rem] border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50">
                <tr>
                  {["#", "Supplier", "PAN", "Paid <=45 Other", "Paid >45", "Outstanding <=45", "Outstanding >45", "Sec. 16 Interest", "Reason"].map((label) => (
                    <th key={label} className="text-left p-2 text-xs text-gray-600 whitespace-nowrap">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={`${row.serialNumber}-${row.vendorName}`} className="border-t align-top">
                    <td className="p-2 text-xs">{row.serialNumber}</td>
                    <td className="p-2 text-xs font-semibold text-gray-800 min-w-56">{row.vendorName}</td>
                    <td className="p-2 text-xs font-mono">{row.panNumber || <span className="text-red-600 font-sans">Missing</span>}</td>
                    <td className="p-2 text-xs text-right">{row.paidWithin45OtherCount} / {formatMoney(row.paidWithin45OtherAmount)}</td>
                    <td className="p-2 text-xs text-right">{row.paidAfter45Count} / {formatMoney(row.paidAfter45Amount)}</td>
                    <td className="p-2 text-xs text-right">{row.outstanding45OrLessCount} / {formatMoney(row.outstanding45OrLessAmount)}</td>
                    <td className="p-2 text-xs text-right font-semibold">{row.outstandingMoreThan45Count} / {formatMoney(row.outstandingMoreThan45Amount)}</td>
                    <td className="p-2 text-xs text-right font-semibold">{formatMoney(row.section16Interest)}</td>
                    <td className="p-2 text-xs min-w-64">{row.reason}</td>
                  </tr>
                ))}
                {!preview.rows.length && (
                  <tr><td colSpan="9" className="p-4 text-sm text-gray-500">No MCA-eligible verified MSME rows found for this report.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="bg-white rounded-lg p-5 shadow mt-5">
        <h3 className="text-lg font-bold text-gray-800 mb-3">Recent MCA MSME-1 Filings</h3>
        <div className="overflow-auto max-h-[24rem]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50">
              <tr>{["Created", "FY", "Half-Year", "Rows", "Status", "SRN", "Action"].map((label) => <th key={label} className="text-left p-2 text-gray-600">{label}</th>)}</tr>
            </thead>
            <tbody>
              {filings.map((filing) => (
                <tr key={filing.id} className="border-t">
                  <td className="p-2 text-xs">{shortDate(filing.createdAt)}</td>
                  <td className="p-2 text-xs">{filing.fiscalYear}</td>
                  <td className="p-2 text-xs">{filing.halfYear}</td>
                  <td className="p-2 text-xs">{filing.rowCount}</td>
                  <td className="p-2 text-xs font-semibold">{filing.status}</td>
                  <td className="p-2 text-xs">{filing.srn || ""}</td>
                  <td className="p-2 text-xs">
                    <div className="flex gap-2">
                      <button onClick={() => setSelectedFiling(filing)} className="bg-gray-200 text-gray-800 px-3 py-1 rounded-lg text-xs font-semibold">Select</button>
                      {filing.downloadUrl && <button onClick={() => downloadFiling(filing)} className="bg-blue-700 text-white px-3 py-1 rounded-lg text-xs font-semibold">Download</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!filings.length && <tr><td colSpan="7" className="p-4 text-sm text-gray-500">No MCA filing records yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <p className="text-sm font-bold text-gray-800 truncate">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function SmallMetric({ label, value, tone = "gray" }) {
  const tones = {
    gray: "bg-gray-50 text-gray-800",
    green: "bg-green-50 text-green-700",
    red: "bg-red-50 text-red-700",
    yellow: "bg-yellow-50 text-yellow-700",
  };
  return (
    <div className={`${tones[tone] || tones.gray} rounded-lg px-3 py-2`}>
      <p className="text-sm font-bold whitespace-nowrap">{value}</p>
      <p className="text-xs">{label}</p>
    </div>
  );
}

function IssueList({ title, tone, issues }) {
  const classes = tone === "red"
    ? "bg-red-50 border-red-200 text-red-700"
    : "bg-yellow-50 border-yellow-200 text-yellow-800";
  return (
    <div className={`${classes} border rounded-lg p-3 mb-4`}>
      <p className="text-sm font-bold mb-2">{title}</p>
      <ul className="list-disc pl-5 text-xs space-y-1">
        {issues.slice(0, 8).map((issue, index) => (
          <li key={`${issue.code}-${index}`}>{issue.vendorName ? `${issue.vendorName}: ` : ""}{issue.message}</li>
        ))}
      </ul>
      {issues.length > 8 && <p className="text-xs mt-2">{issues.length - 8} more issues hidden in this view.</p>}
    </div>
  );
}
