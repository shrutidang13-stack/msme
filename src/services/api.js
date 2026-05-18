import { auth } from "../firebase";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "http://127.0.0.1:3001";

async function authHeaders(headers = {}) {
  const token = await auth.currentUser?.getIdToken();
  const cleanHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...cleanHeaders,
  };
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: await authHeaders(options.headers),
    });
  } catch (error) {
    throw new Error(
      `Backend is not reachable at ${API_BASE_URL}. Start the Express backend with npm start, and make sure the legacy tally-proxy.js is not using port 3001.`
    );
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok || data?.success === false) {
    const requestError = new Error(data?.error || `Request failed with ${response.status}`);
    if (data?.diagnostics) requestError.diagnostics = data.diagnostics;
    throw requestError;
  }
  return data;
}

export async function fetchHealth() {
  const response = await fetch(`${API_BASE_URL}/api/health`);
  return response.json();
}

export async function importFromTally({ fiscalYear, fromDate, toDate, asOn, companyName }) {
  return request("/api/tally/import", {
    method: "POST",
    body: JSON.stringify({ fiscalYear, fromDate, toDate, asOn, companyName }),
  });
}

export async function fetchTallyHealth(companyName = "") {
  const query = companyName ? `?${new URLSearchParams({ companyName }).toString()}` : "";
  return request(`/api/tally/health${query}`);
}

export async function fetchImportRun(id) {
  return request(`/api/tally/imports/${id}`);
}

export async function fetchLedgerVouchers(importRunId, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== "")).toString();
  return request(`/api/tally/imports/${importRunId}/ledger-vouchers${query ? `?${query}` : ""}`);
}

export async function fetchImports() {
  return request("/api/tally/imports");
}

export async function fetchVendorMaster() {
  return request("/api/vendors/master");
}

export async function fetchPurchaseInvoices(params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  return request(`/api/purchase-invoices${query ? `?${query}` : ""}`);
}

export async function createPurchaseInvoice(payload) {
  return request("/api/purchase-invoices", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function bulkCreatePurchaseInvoices(invoices, source = "csv") {
  return request("/api/purchase-invoices/bulk", {
    method: "POST",
    body: JSON.stringify({ invoices, source }),
  });
}

export async function importPurchaseInvoicesFromTally(payload) {
  return request("/api/purchase-invoices/import-tally", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function verifyPurchaseInvoiceUdyam(id, udyamNumber) {
  return request(`/api/purchase-invoices/${id}/verify-udyam`, {
    method: "POST",
    body: JSON.stringify({ udyamNumber }),
  });
}

export async function fetchAuditTrail() {
  return request("/api/vendors/audit-trail");
}

export async function fetchLegalRules() {
  return request("/api/legal/rules");
}

export async function saveVendorStatus(payload) {
  return request("/api/vendors/save-status", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function verifyUdyam(payload) {
  return request("/api/vendors/verify-udyam", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createMSMEReport(importRunId, fiscalYear = "") {
  return request("/api/reports/msme", {
    method: "POST",
    body: JSON.stringify({ importRunId, fiscalYear }),
  });
}

export async function fetchReports() {
  return request("/api/reports");
}

export async function fetchReport(id) {
  return request(`/api/reports/${id}`);
}

export function reportDownloadUrl(id, extension) {
  return `${API_BASE_URL}/api/reports/${id}/download.${extension}`;
}

export async function downloadReportFile(id, extension) {
  const response = await fetch(reportDownloadUrl(id, extension), {
    headers: await authHeaders({ "Content-Type": undefined }),
  });
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `MSME_Report_${id}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function askComplianceAssistant(question) {
  return request("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

export { API_BASE_URL };
