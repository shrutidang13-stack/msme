import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTaxAuditReport,
  downloadUrl,
  fetchReports,
  fetchTaxAuditReport,
  fetchTaxAuditReports,
  taxAuditDownloadUrl,
  updateTaxAuditAssessee,
  updateTaxAuditAuditor,
  updateTaxAuditClause,
  validateTaxAuditReport,
} from "./services/api";
import TaxAuditClauseReviewTable from "./components/TaxAuditClauseReviewTable";
import TaxAuditValidationPanel from "./components/TaxAuditValidationPanel";

const STATUS_OPTIONS = [
  ["", "Select status"],
  ["1", "Individual"],
  ["2", "HUF"],
  ["3", "Firm"],
  ["4", "LLP"],
  ["5", "Company"],
  ["6", "Trust"],
  ["7", "AOP"],
  ["10", "Co-operative Society"],
];

export default function TaxAuditReportGenerator() {
  const [msmeReports, setMsmeReports] = useState([]);
  const [taxReports, setTaxReports] = useState([]);
  const [selectedMsmeReportId, setSelectedMsmeReportId] = useState("");
  const [formType, setFormType] = useState("3CB");
  const [assessmentYear, setAssessmentYear] = useState("");
  const [activeReport, setActiveReport] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState("");
  const [assesseeDraft, setAssesseeDraft] = useState({});
  const [auditorDraft, setAuditorDraft] = useState({});

  const blockingErrors = useMemo(() => (activeReport?.validation || []).filter((item) => item.severity === "error"), [activeReport]);

  const load = useCallback(async () => {
    const [msme, tax] = await Promise.all([fetchReports(), fetchTaxAuditReports()]);
    setMsmeReports(msme.reports || []);
    setTaxReports(tax.reports || []);
    if (!selectedMsmeReportId && msme.reports?.[0]) setSelectedMsmeReportId(msme.reports[0].id);
  }, [selectedMsmeReportId]);

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, [load]);

  const setReport = (report) => {
    setActiveReport(report);
    setAssesseeDraft(report?.assessee || {});
    setAuditorDraft(report?.auditor || {});
  };

  const createReport = async () => {
    if (!selectedMsmeReportId) return;
    setLoading("create");
    setMessage("");
    try {
      const response = await createTaxAuditReport({ msmeReportId: selectedMsmeReportId, formType, assessmentYear });
      setReport(response.report);
      setMessage("Tax audit draft created for CA review.");
      await load();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading("");
    }
  };

  const openReport = async (id) => {
    setLoading(`open-${id}`);
    try {
      const response = await fetchTaxAuditReport(id);
      setReport(response.report);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading("");
    }
  };

  const saveAssessee = async () => {
    setLoading("assessee");
    try {
      const response = await updateTaxAuditAssessee(activeReport.id, assesseeDraft);
      setReport(response.report);
      setMessage("Assessee details saved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading("");
    }
  };

  const saveAuditor = async () => {
    setLoading("auditor");
    try {
      const response = await updateTaxAuditAuditor(activeReport.id, auditorDraft);
      setReport(response.report);
      setMessage("Auditor details saved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading("");
    }
  };

  const saveClause = async (clauseNo, patch) => {
    const response = await updateTaxAuditClause(activeReport.id, clauseNo, patch);
    setReport(response.report);
  };

  const runValidation = async () => {
    setLoading("validate");
    try {
      const response = await validateTaxAuditReport(activeReport.id);
      setReport(response.report);
      setMessage("Validation refreshed.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading("");
    }
  };

  const download = async (extension) => {
    const names = { json: "Tax_Audit.json", pdf: "Tax_Audit_Draft.pdf", zip: "Tax_Audit_Export.zip" };
    await downloadUrl(taxAuditDownloadUrl(activeReport.id, extension), names[extension]);
  };

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-lg p-5 shadow">
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Tax Audit Report Generator</h2>
            <p className="text-sm text-gray-500 mt-1">CA-reviewable Form 3CA/3CB + 3CD draft preparation with schema validation and MSME annexures.</p>
          </div>
          {activeReport && (
            <div className="text-right text-sm">
              <p className="font-bold text-gray-800">{activeReport.formType}-3CD</p>
              <p className="text-gray-500">{activeReport.status} | {activeReport.validationStatus}</p>
            </div>
          )}
        </div>
        <div className="mt-4 border border-amber-200 bg-amber-50 text-amber-800 rounded-lg p-3 text-sm font-semibold">
          Draft for CA review only. Final filing, upload, validation and DSC must happen through the official Income Tax utility/portal.
        </div>
        {message && <div className="mt-4 border border-blue-200 bg-blue-50 text-blue-800 rounded-lg p-3 text-sm font-semibold">{message}</div>}
      </section>

      <section className="bg-white rounded-lg p-5 shadow">
        <h3 className="text-lg font-bold text-gray-800 mb-3">Create Draft</h3>
        <div className="grid md:grid-cols-4 gap-3">
          <select value={selectedMsmeReportId} onChange={(event) => setSelectedMsmeReportId(event.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Select MSME report</option>
            {msmeReports.map((report) => (
              <option key={report.id} value={report.id}>{report.fiscalYear} | {report.createdAt}</option>
            ))}
          </select>
          <select value={formType} onChange={(event) => setFormType(event.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="3CB">Form 3CB + 3CD</option>
            <option value="3CA">Form 3CA + 3CD</option>
          </select>
          <input value={assessmentYear} onChange={(event) => setAssessmentYear(event.target.value)} placeholder="Assessment year e.g. 2026-27" className="border rounded-lg px-3 py-2 text-sm" />
          <button onClick={createReport} disabled={!selectedMsmeReportId || loading === "create"} className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
            {loading === "create" ? "Creating..." : "Create Tax Audit Draft"}
          </button>
        </div>
      </section>

      <section className="bg-white rounded-lg p-5 shadow">
        <h3 className="text-lg font-bold text-gray-800 mb-3">Existing Tax Audit Drafts</h3>
        {!taxReports.length && <p className="text-sm text-gray-500">No tax audit drafts yet.</p>}
        {taxReports.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left bg-gray-50"><th className="p-2">Created</th><th className="p-2">Form</th><th className="p-2">FY</th><th className="p-2">AY</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead>
              <tbody>
                {taxReports.map((report) => (
                  <tr key={report.id} className="border-t">
                    <td className="p-2 text-xs">{report.createdAt}</td>
                    <td className="p-2">{report.formType}</td>
                    <td className="p-2">{report.financialYear}</td>
                    <td className="p-2">{report.assessmentYear}</td>
                    <td className="p-2">{report.status}</td>
                    <td className="p-2"><button onClick={() => openReport(report.id)} className="bg-gray-900 text-white px-3 py-1 rounded text-xs font-semibold">{loading === `open-${report.id}` ? "Opening..." : "Open"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {activeReport && (
        <>
          <section className="grid lg:grid-cols-2 gap-5">
            <DetailForm title="Assessee Details" draft={assesseeDraft} setDraft={setAssesseeDraft} onSave={saveAssessee} loading={loading === "assessee"} fields={[
              ["name", "Name"], ["pan", "PAN"], ["address", "Address"], ["city", "City"], ["pinCode", "PIN"], ["gstin", "GSTIN"], ["natureOfBusiness", "Nature of business"], ["booksOfAccount", "Books of account"], ["placeOfBusiness", "Place of business"], ["tallyCompanyMapping", "Tally company mapping"],
            ]} extra={<select value={assesseeDraft.statusCode || ""} onChange={(event) => setAssesseeDraft((prev) => ({ ...prev, statusCode: event.target.value, status: event.target.options[event.target.selectedIndex].text }))} className="border rounded-lg px-3 py-2 text-sm">{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>} />
            <DetailForm title="Auditor Details" draft={auditorDraft} setDraft={setAuditorDraft} onSave={saveAuditor} loading={loading === "auditor"} fields={[
              ["caName", "CA name"], ["firmName", "Firm name"], ["membershipNumber", "Membership number"], ["frn", "FRN"], ["address", "Address"], ["city", "City"], ["pinCode", "PIN"], ["place", "Place"], ["date", "Date"], ["udin", "UDIN"], ["observations", "Observations/qualifications"],
            ]} />
          </section>

          <section className="bg-white rounded-lg p-5 shadow">
            <TaxAuditValidationPanel validation={activeReport.validation || []} />
            <div className="flex flex-wrap gap-2 mt-4">
              <button onClick={runValidation} className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-semibold">{loading === "validate" ? "Validating..." : "Run Validation"}</button>
              <button onClick={() => download("pdf")} className="bg-blue-100 text-blue-800 px-4 py-2 rounded-lg text-sm font-semibold">Download PDF Preview</button>
              <button onClick={() => download("json")} disabled={blockingErrors.length > 0} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">Download JSON</button>
              <button onClick={() => download("zip")} disabled={blockingErrors.length > 0} className="bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">Export ZIP</button>
            </div>
          </section>

          <section className="bg-white rounded-lg p-5 shadow">
            <TaxAuditClauseReviewTable clauses={activeReport.clauses || []} validation={activeReport.validation || []} onSaveClause={saveClause} />
          </section>

          <section className="grid lg:grid-cols-2 gap-5">
            <AnnexurePreview title="Clause 22 MSME Computation Annexure" rows={activeReport.annexures?.find((item) => item.annexureType === "clause22")?.payload || []} amountKey="clause22iiiBOutstandingDisallowance" />
            <AnnexurePreview title="Clause 26 43B(h) From Clause 22 Annexure" rows={activeReport.annexures?.find((item) => item.annexureType === "clause26")?.payload || []} amountKey="principalDisallowance" />
          </section>
        </>
      )}
    </div>
  );
}

function DetailForm({ title, draft, setDraft, fields, extra, onSave, loading }) {
  return (
    <section className="bg-white rounded-lg p-5 shadow">
      <h3 className="text-lg font-bold text-gray-800 mb-3">{title}</h3>
      <div className="grid md:grid-cols-2 gap-3">
        {fields.map(([key, label]) => (
          <label key={key} className="text-xs font-semibold text-gray-600">
            {label}
            <input value={draft[key] || ""} onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal text-gray-800" />
          </label>
        ))}
        {extra}
      </div>
      <button onClick={onSave} className="mt-4 bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">{loading ? "Saving..." : "Save"}</button>
    </section>
  );
}

function AnnexurePreview({ title, rows, amountKey }) {
  const total = rows.reduce((sum, row) => sum + Number(row[amountKey] || row.disallowanceAmount || row.amountInadmissible || 0), 0);
  return (
    <section className="bg-white rounded-lg p-5 shadow">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-lg font-bold text-gray-800">{title}</h3>
        <span className="text-sm font-bold text-gray-700">Rs {total.toLocaleString("en-IN")}</span>
      </div>
      <div className="overflow-auto max-h-72">
        <table className="w-full text-xs">
          <thead><tr className="text-left bg-gray-50"><th className="p-2">Supplier</th><th className="p-2">Invoice</th><th className="p-2 text-right">Amount</th><th className="p-2">Status</th></tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan="4" className="p-3 text-gray-500">No rows.</td></tr>}
            {rows.slice(0, 50).map((row, index) => (
              <tr key={`${row.supplier}-${row.invoiceNumber}-${index}`} className="border-t">
                <td className="p-2">{row.supplier || row.vendorName}</td>
                <td className="p-2">{row.invoiceNumber || "-"}</td>
                <td className="p-2 text-right">{Number(row[amountKey] || row.disallowanceAmount || row.amountInadmissible || 0).toLocaleString("en-IN")}</td>
                <td className="p-2">{row.status || row.remarks || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
