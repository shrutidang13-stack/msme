import { useEffect, useState } from "react";
import { auth } from "./firebase";
import { signOut } from "firebase/auth";
import TallyImport from "./TallyImport";
import MSMEInterestCalculator from "./MSMEInterestCalculator";
import MCAMSME1Filing from "./MCAMSME1Filing";
import PurchaseInvoices from "./PurchaseInvoices";
import {
  askComplianceAssistant,
  auditTrailDownloadUrl,
  downloadUrl,
  fetchAuditTrail,
  fetchHealth,
  fetchImports,
  fetchLegalRules,
  fetchPurchaseInvoices,
  fetchReports,
  fetchVerificationQueue,
  fetchVendorMaster,
  reviewUdyamProof,
} from "./services/api";

const NAV = [
  ["dashboard", "Dashboard"],
  ["tally", "Tally Import"],
  ["interest", "MSME Interest Calculator"],
  ["mca-msme1", "MCA MSME-1 Filing"],
  ["purchase", "Purchase Invoices"],
  ["vendors", "Vendor Master"],
  ["reports", "Reports"],
  ["ca-review", "CA Review"],
  ["rules", "Rules"],
  ["audit", "Audit Log"],
  ["settings", "Settings"],
  ["ai", "AI Assistant"],
];

export default function Dashboard({ user }) {
  const [activeTab, setActiveTab] = useState("dashboard");
  const handleLogout = async () => { await signOut(auth); };

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-blue-700 text-white p-4 flex justify-between items-center">
        <h1 className="text-xl font-bold">MSME Guard</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm">{user?.email}</span>
          <button onClick={handleLogout} className="bg-white text-blue-700 px-3 py-1 rounded-lg text-sm font-semibold">Logout</button>
        </div>
      </nav>
      <div className="bg-white shadow flex gap-1 px-4 pt-4 overflow-x-auto">
        {NAV.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 px-3 font-semibold text-sm whitespace-nowrap border-b-2 ${activeTab === key ? "border-blue-700 text-blue-700" : "border-transparent text-gray-500"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="p-6">
        {activeTab === "dashboard" && <Home />}
        {activeTab === "tally" && <TallyImport />}
        {activeTab === "interest" && <MSMEInterestCalculator />}
        {activeTab === "mca-msme1" && <MCAMSME1Filing />}
        {activeTab === "purchase" && <PurchaseInvoices />}
        {activeTab === "vendors" && <VendorMaster />}
        {activeTab === "reports" && <Reports />}
        {activeTab === "ca-review" && <CAReview />}
        {activeTab === "rules" && <Rules />}
        {activeTab === "audit" && <AuditLog />}
        {activeTab === "settings" && <Settings />}
        {activeTab === "ai" && <AIAssistant />}
      </div>
    </div>
  );
}

function Home() {
  const [data, setData] = useState({ vendors: [], reports: [], imports: [], invoices: [] });
  useEffect(() => {
    Promise.all([fetchVendorMaster(), fetchReports(), fetchImports(), fetchPurchaseInvoices()])
      .then(([vendors, reports, imports, invoices]) => setData({ vendors: vendors.vendors, reports: reports.reports, imports: imports.imports, invoices: invoices.invoices }))
      .catch(() => {});
  }, []);
  const verified = data.vendors.filter((vendor) => vendor.verificationStatus === "verified" && vendor.isMSME).length;
  const pending = data.vendors.filter((vendor) => ["pending", "failed", "manual_fallback_required"].includes(vendor.verificationStatus)).length;
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">MVP Control Center</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Metric label="Vendor Master" value={data.vendors.length} color="bg-blue-100 text-blue-700" />
        <Metric label="Verified MSME" value={verified} color="bg-green-100 text-green-700" />
        <Metric label="Pending Review" value={pending} color="bg-yellow-100 text-yellow-700" />
        <Metric label="Purchase Invoices" value={data.invoices.length} color="bg-purple-100 text-purple-700" />
      </div>
      <div className="mt-6 bg-white rounded-2xl p-6 shadow">
        <h3 className="text-lg font-bold text-gray-800 mb-3">Recent Import Runs</h3>
        <SimpleTable rows={data.imports.slice(0, 8)} columns={[
          ["createdAt", "Created"],
          ["fiscalYear", "FY"],
          ["status", "Status"],
          ["companyName", "Company"],
        ]} />
      </div>
    </div>
  );
}

function VendorMaster() {
  const [vendors, setVendors] = useState([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    fetchVendorMaster().then((data) => setVendors(data.vendors)).catch(() => {});
  }, []);
  const filtered = vendors.filter((vendor) => vendor.vendorName.toUpperCase().includes(query.trim().toUpperCase()));
  return (
    <Panel title="Vendor Master" subtitle="Permanent MSME/Udyam source of truth used by reports.">
      <input className="border rounded-lg px-3 py-2 text-sm mb-4" placeholder="Search vendors" value={query} onChange={(event) => setQuery(event.target.value)} />
      <SimpleTable rows={filtered} columns={[
        ["vendorName", "Vendor"],
        ["verificationStatus", "Status"],
        ["udyamNumber", "Udyam"],
        ["enterpriseType", "Type"],
        ["lastVerifiedAt", "Last Verified"],
      ]} />
    </Panel>
  );
}

function Reports() {
  const [reports, setReports] = useState([]);
  useEffect(() => {
    fetchReports().then((data) => setReports(data.reports)).catch(() => {});
  }, []);
  return (
    <Panel title="Reports" subtitle="Backend-generated report snapshots.">
      <SimpleTable rows={reports} columns={[
        ["createdAt", "Created"],
        ["fiscalYear", "FY"],
        ["importRunId", "Import Run"],
        ["createdBy", "Created By"],
      ]} />
    </Panel>
  );
}

function CAReview() {
  const [vendors, setVendors] = useState([]);
  const [message, setMessage] = useState("");
  const load = () => fetchVerificationQueue().then((data) => setVendors(data.vendors)).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const decide = async (vendor, decision) => {
    const remarks = window.prompt(decision === "approve" ? "Approval remarks" : "Rejection remarks", vendor.reviewComment || vendor.udyamRemarks || "");
    if (remarks === null) return;
    try {
      await reviewUdyamProof(vendor.id, decision, remarks);
      setMessage(`${vendor.vendorName} ${decision === "approve" ? "approved" : "rejected"}.`);
      load();
    } catch (error) {
      setMessage(error.message);
    }
  };
  const reviewRows = vendors.filter((vendor) => ["manual_review", "failed", "pending_action"].includes(vendor.actionStatus) || ["pending_manual_review", "manual_fallback_required", "rejected"].includes(vendor.udyamStatus));
  return (
    <Panel title="CA Review" subtitle="Manual proof approval queue with evidence links and reviewer decisions.">
      {message && <div className="bg-blue-50 border border-blue-200 text-blue-700 rounded-xl p-3 mb-4 text-sm font-semibold">{message}</div>}
      <SimpleTable
        rows={reviewRows}
        columns={[
          ["vendorName", "Vendor"],
          ["udyamNumber", "Udyam"],
          ["enterpriseType", "Type"],
          ["actionStatus", "Action"],
          ["reviewStatus", "Review"],
          ["evidenceUrl", "Evidence"],
          ["udyamRemarks", "Notes"],
        ]}
        actions={(vendor) => (
          <div className="flex gap-2">
            <button onClick={() => decide(vendor, "approve")} className="bg-green-600 text-white px-3 py-1 rounded-lg text-xs font-semibold">Approve</button>
            <button onClick={() => decide(vendor, "reject")} className="bg-red-600 text-white px-3 py-1 rounded-lg text-xs font-semibold">Reject</button>
          </div>
        )}
      />
    </Panel>
  );
}

function Rules() {
  const [rulePack, setRulePack] = useState(null);
  useEffect(() => {
    fetchLegalRules().then((data) => setRulePack(data.rulePack)).catch(() => {});
  }, []);
  return (
    <Panel title="Rules" subtitle="Active rule pack used by backend MSME compliance reports.">
      {!rulePack && <p className="text-sm text-gray-500">No rules loaded.</p>}
      {rulePack && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <Metric label="Rule Version" value={rulePack.version} color="bg-blue-100 text-blue-700" />
            <Metric label="Rules" value={rulePack.rules.length} color="bg-green-100 text-green-700" />
            <Metric label="Sources" value={rulePack.sources.length} color="bg-purple-100 text-purple-700" />
          </div>
          <SimpleTable rows={rulePack.rules} columns={[
            ["id", "Rule ID"],
            ["name", "Name"],
            ["condition", "Condition"],
            ["effect", "Effect"],
          ]} />
        </div>
      )}
    </Panel>
  );
}

function AuditLog() {
  const [audit, setAudit] = useState([]);
  useEffect(() => {
    fetchAuditTrail().then((data) => setAudit(data.auditTrail)).catch(() => {});
  }, []);
  return (
    <Panel title="Audit Log" subtitle="Every vendor master mutation with old and new values.">
      <div className="flex gap-2 mb-4">
        <button onClick={() => downloadUrl(auditTrailDownloadUrl("csv"), "MSME_Audit_Trail.csv")} className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">Download CSV</button>
        <button onClick={() => downloadUrl(auditTrailDownloadUrl("json"), "MSME_Audit_Trail.json")} className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg text-sm font-semibold">Download JSON</button>
      </div>
      <SimpleTable rows={audit} columns={[
        ["changedAt", "Changed"],
        ["changedBy", "User"],
        ["action", "Action"],
        ["source", "Source"],
      ]} />
    </Panel>
  );
}

function Settings() {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    fetchHealth().then(setHealth).catch((error) => setHealth({ success: false, error: error.message }));
  }, []);
  return (
    <Panel title="Settings" subtitle="Runtime checks for the local MVP backend.">
      <pre className="bg-gray-900 text-green-100 rounded-xl p-4 text-xs overflow-auto">{JSON.stringify(health, null, 2)}</pre>
    </Panel>
  );
}

function AIAssistant() {
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState([
    { role: "ai", text: "Ask compliance questions here. I will not classify vendors or decide MSME report eligibility." },
  ]);
  const [loading, setLoading] = useState(false);

  const handleSend = async (q) => {
    const userQ = q || question;
    if (!userQ.trim()) return;
    const nextChat = [...chat, { role: "user", text: userQ }];
    setChat(nextChat);
    setQuestion("");
    setLoading(true);
    try {
      const data = await askComplianceAssistant(userQ);
      setChat([...nextChat, { role: "ai", text: data.reply || "No response returned." }]);
    } catch {
      setChat([...nextChat, { role: "ai", text: "Backend AI assistant is not configured or unavailable." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Panel title="AI Compliance Assistant" subtitle="Optional advisory helper. Never used as a vendor MSME source of truth.">
      <div className="bg-gray-50 rounded-xl p-4 h-72 overflow-y-auto mb-4">
        {chat.map((msg, index) => (
          <div key={index} className={`mb-3 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`px-4 py-2 rounded-2xl text-sm max-w-lg ${msg.role === "user" ? "bg-blue-700 text-white" : "bg-white text-gray-700 shadow"}`}>
              {msg.text}
            </div>
          </div>
        ))}
        {loading && <div className="text-sm text-gray-500">Thinking...</div>}
      </div>
      <div className="flex gap-2">
        <input className="flex-1 border p-3 rounded-lg" placeholder="Ask about MSME compliance" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => event.key === "Enter" && handleSend()} />
        <button onClick={() => handleSend()} disabled={loading} className="bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold disabled:opacity-50">Send</button>
      </div>
    </Panel>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-2xl p-6 shadow">
      <h2 className="text-2xl font-bold text-gray-800">{title}</h2>
      <p className="text-sm text-gray-500 mb-4">{subtitle}</p>
      {children}
    </div>
  );
}

function Metric({ label, value, color }) {
  return <div className={`p-6 rounded-2xl ${color}`}><p className="text-3xl font-bold">{value}</p><p className="text-sm mt-1">{label}</p></div>;
}

function SimpleTable({ rows, columns, actions }) {
  if (!rows.length) return <p className="text-sm text-gray-500">No records yet.</p>;
  return (
    <div className="overflow-auto max-h-[34rem]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-50">
          <tr>{columns.map(([, label]) => <th key={label} className="text-left p-2 text-gray-600">{label}</th>)}{actions && <th className="text-left p-2 text-gray-600">Action</th>}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || index} className="border-t">
              {columns.map(([key]) => <td key={key} className="p-2 text-xs">{String(row[key] ?? "")}</td>)}
              {actions && <td className="p-2 text-xs">{actions(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
