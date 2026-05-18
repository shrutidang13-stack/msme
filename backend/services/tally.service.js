const http = require("http");
const { execFile } = require("child_process");
const { XMLParser } = require("fast-xml-parser");
const env = require("../config/env");
const { normalizeVendorName } = require("../utils/normalizeVendorName");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
});

const TALLY_HOSTS = ["localhost", "127.0.0.1"];
function tallyHosts() {
  const configured = env.tallyHost || "localhost";
  return [...new Set([...TALLY_HOSTS, configured])];
}

function preview(value, length = 500) {
  return String(value || "").slice(0, length);
}

const COMPANY_CONTEXT_ERROR = "Tally XML export requires active company context.";

function logTallyHttp({ method, url, statusCode, body, error }) {
  if (error) {
    console.log(`[tally] ${method} ${url} failed code=${error.code || "UNKNOWN"} message=${error.message}`);
    return;
  }
  console.log(`[tally] ${method} ${url} status=${statusCode} bodyPreview=${JSON.stringify(preview(body))}`);
}

function logTallyRequestBody(method, host, port, body) {
  if (!body) return;
  const url = `http://${host}:${port}`;
  console.log(`[tally] ${method} ${url} requestPreview=${JSON.stringify(preview(body))}`);
}

function logImportStage(stage, details = {}) {
  console.log(`[tally-import] stage=${stage} ${JSON.stringify(details)}`);
}

function lineError(xml) {
  const match = String(xml || "").match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
  const message = match ? cleanName(match[1]) : "";
  if (message) logImportStage("lineError", { message });
  return message;
}

function requestTallyHttp({ method, host, port = env.tallyPort, body = "", timeoutMs = 5000, headers = {} }) {
  const url = `http://${host}:${port}`;
  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: host,
      port,
      path: "/",
      method,
      headers: {
        Connection: "close",
        ...headers,
      },
    };
    if (body) requestOptions.headers["Content-Length"] = Buffer.byteLength(body, "utf8");
    const req = http.request(requestOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        logTallyHttp({ method, url, statusCode: res.statusCode, body: data });
        resolve({ host, url, statusCode: res.statusCode, body: data });
      });
    });
    req.on("error", (error) => {
      logTallyHttp({ method, url, error });
      reject(error);
    });
    req.setTimeout(timeoutMs, () => {
      const timeoutError = new Error(`Tally ${method} timeout after ${Math.round(timeoutMs / 1000)}s`);
      timeoutError.code = "ETIMEDOUT";
      req.destroy(timeoutError);
    });
    logTallyRequestBody(method, host, port, body);
    if (body) req.write(body, "utf8");
    req.end();
  });
}

async function requestTallyWithFallback(requestOptions) {
  const errors = [];
  for (const host of tallyHosts()) {
    try {
      return await requestTallyHttp({ ...requestOptions, host });
    } catch (error) {
      errors.push({ host, code: error.code || null, message: error.message });
    }
  }
  const error = new Error(errors.map((item) => `${item.host}: ${item.message}`).join("; ") || "Tally request failed");
  error.tallyErrors = errors;
  error.code = errors[0]?.code;
  throw error;
}

function tallyRequest(xmlBody, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  return requestTallyWithFallback({
    method: "POST",
    body: xmlBody,
    timeoutMs,
    headers: { "Content-Type": "text/xml;charset=utf-8" },
  }).then((response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Tally returned HTTP ${response.statusCode} while processing XML export.`);
    }
    return response.body;
  }).catch((error) => {
    if (error.code === "ECONNREFUSED") throw new Error("Tally connection refused on port 9000.");
    if (error.code === "ECONNRESET") throw new Error("Tally closed the XML connection. Restart TallyPrime and confirm XML/HTTP server is enabled.");
    throw error;
  });
}

function tallyStatusRequest(options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  return requestTallyWithFallback({ method: "GET", timeoutMs });
}

function parseTallyProcessList(output) {
  const lines = String(output || "").split(/\r?\n/);
  return lines
    .filter((line) => /\bTallyPrime\.exe\b/i.test(line) || /\btally\.exe\b/i.test(line))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        imageName: parts[0] || "TallyPrime.exe",
        pid: parts[1] || "",
        raw: line.trim(),
      };
    });
}

function detectTallyProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    execFile("tasklist", ["/FI", "IMAGENAME eq TallyPrime.exe"], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        logImportStage("processDiagnostics", { status: "failed", error: error.message });
        return resolve([]);
      }
      const processes = parseTallyProcessList(stdout);
      if (processes.length > 1) {
        logImportStage("processDiagnostics", { status: "multiple_tally_processes", count: processes.length, processes });
      } else {
        logImportStage("processDiagnostics", { status: "ok", count: processes.length });
      }
      resolve(processes);
    });
  });
}

function parseXml(xml, context) {
  try {
    return parser.parse(xml || "<ENVELOPE/>");
  } catch (error) {
    throw new Error(`Malformed XML from Tally while parsing ${context}: ${error.message}`);
  }
}

function countKeys(parsed, keys) {
  return keys.reduce((sum, key) => sum + collectByKey(parsed, key).length, 0);
}

function validateStandardExportXml(xml, context, rowKeys = []) {
  const tallyLineError = lineError(xml);
  if (tallyLineError) {
    throw new Error(`${context} failed: ${tallyLineError}`);
  }
  if (/Unknown Request,\s*cannot be processed/i.test(xml || "")) {
    throw new Error(`${context} failed: Tally returned Unknown Request, cannot be processed.`);
  }
  const parsed = parseXml(xml, context);
  const rowCount = countKeys(parsed, rowKeys);
  const hasCmpInfo = collectByKey(parsed, "CMPINFO").length > 0;
  const hasEmptyCollection = /<COLLECTION>\s*<\/COLLECTION>/i.test(xml || "");
  const cmpInfoOnly = hasCmpInfo && (hasEmptyCollection || rowCount === 0);
  const emptyCollectionOnly = hasEmptyCollection && rowCount === 0;
  if (cmpInfoOnly || emptyCollectionOnly) {
    throw new Error(`${context} returned only metadata and no export rows. The XML export definition was not executed by Tally.`);
  }
  logImportStage("xmlParse", { context, parsedRows: rowCount });
  return { parsed, rowCount };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "object" && "#text" in value) return String(value["#text"] || "");
  return String(value);
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanName(name) {
  return text(name)
    .replace(/&#13;&#10;/g, "")
    .replace(/&#13;/g, "")
    .replace(/&#10;/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\r?\n/g, "")
    .trim();
}

function normalizeCompanyName(name) {
  return cleanName(name)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("en-IN");
}

function formatDate(raw) {
  const value = text(raw);
  if (!value || value.length !== 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function parseTallyDate(value) {
  const raw = text(value).replace(/-/g, "");
  if (!/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTallyDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function addUtcMonths(date, count) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function endOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function buildPeriodBatches(from, to, monthsPerBatch = 3) {
  const start = parseTallyDate(from);
  const end = parseTallyDate(to);
  if (!start || !end || start > end) return [];
  const batches = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const batchStartDate = cursor < start ? start : cursor;
    const batchEndCandidate = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + monthsPerBatch, 0));
    const batchEndDate = batchEndCandidate > end ? end : batchEndCandidate;
    batches.push({
      from: formatTallyDate(batchStartDate),
      to: formatTallyDate(batchEndDate),
      label: batchLabel(batchStartDate, batchEndDate),
    });
    cursor = addUtcMonths(cursor, monthsPerBatch);
  }
  return batches;
}

function buildMonthlyBatches(from, to) {
  const start = parseTallyDate(from);
  const end = parseTallyDate(to);
  if (!start || !end || start > end) return [];
  const batches = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const batchStartDate = cursor < start ? start : cursor;
    const monthEnd = endOfUtcMonth(cursor);
    const batchEndDate = monthEnd > end ? end : monthEnd;
    batches.push({
      from: formatTallyDate(batchStartDate),
      to: formatTallyDate(batchEndDate),
      label: batchLabel(batchStartDate, batchEndDate),
    });
    cursor = addUtcMonths(cursor, 1);
  }
  return batches;
}

function batchLabel(startDate, endDate) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Sep", "Oct", "Nov", "Dec"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const start = monthNames[startDate.getUTCMonth()] || months[startDate.getUTCMonth()];
  const end = monthNames[endDate.getUTCMonth()] || months[endDate.getUTCMonth()];
  return start === end ? start : `${start}-${end}`;
}

function staticVariablesXml(companyName, entries = []) {
  const selectedCompany = cleanName(companyName);
  const companyXml = selectedCompany ? `<SVCURRENTCOMPANY>${xmlEscape(selectedCompany)}</SVCURRENTCOMPANY>` : "";
  return `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyXml}${entries.join("")}</STATICVARIABLES>`;
}

function buildExportXml(reportName, staticVariables) {
  return `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>${reportName}</REPORTNAME>${staticVariables}</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

function buildLedgerCollectionXML(companyName) {
  return buildExportXml("List of Accounts", staticVariablesXml(companyName));
}

function buildDayBookXML(from, to, companyName) {
  return buildExportXml("Day Book", staticVariablesXml(companyName, [
    `<SVFROMDATE>${from}</SVFROMDATE>`,
    `<SVTODATE>${to}</SVTODATE>`,
  ]));
}

function buildLedgerVouchersXML(from, to, ledgerName, companyName) {
  return buildExportXml("Ledger Vouchers", staticVariablesXml(companyName, [
    `<SVFROMDATE>${from}</SVFROMDATE>`,
    `<SVTODATE>${to}</SVTODATE>`,
    `<LEDGERNAME>${xmlEscape(ledgerName)}</LEDGERNAME>`,
    `<SVLEDGERNAME>${xmlEscape(ledgerName)}</SVLEDGERNAME>`,
  ]));
}

function buildVoucherCollectionXML(from, to, companyName) {
  return buildDayBookXML(from, to, companyName);
}

function buildVoucherObjectCollectionXML(from, to, companyName) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MSME Voucher Collection</ID></HEADER><BODY><DESC>${staticVariablesXml(companyName, [
    `<SVFROMDATE>${from}</SVFROMDATE>`,
    `<SVTODATE>${to}</SVTODATE>`,
  ])}<TDL><TDLMESSAGE><COLLECTION NAME="MSME Voucher Collection" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,PartyName,Reference,AllLedgerEntries.*,LedgerEntries.*,BillAllocations.*</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function buildLoadedCompanyCollectionXML() {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Loaded Companies</ID></HEADER><BODY><DESC><TDL><TDLMESSAGE><COLLECTION NAME="Loaded Companies" ISMODIFY="No"><TYPE>Company</TYPE><FETCH>Name</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function collectByKey(node, key, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Object.prototype.hasOwnProperty.call(node, key)) out.push(...asArray(node[key]));
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => collectByKey(item, key, out));
    else if (value && typeof value === "object") collectByKey(value, key, out);
  }
  return out;
}

function companyText(value) {
  if (value == null) return "";
  if (typeof value === "object" && !("#text" in value)) return "";
  return cleanName(value);
}

function uniqueCleanNames(values) {
  return [...new Set(values.map(companyText).filter(Boolean))];
}

function companyNameCandidatesFromNode(node) {
  if (!node || typeof node !== "object") return [];
  const direct = [
    node["@_NAME"],
    node.NAME,
    node.CMPNAME,
    node.COMPANYNAME,
    node.CURRENTCOMPANY,
    node.SVCURRENTCOMPANY,
    node.DSPDISPNAME,
    node.MAILINGNAME,
  ].flatMap(asArray);
  const nested = [
    ...collectByKey(node, "COMPANY").flatMap((company) => [company["@_NAME"], company.NAME, company.CMPNAME]),
    ...collectByKey(node, "CMPINFO").flatMap((info) => [info["@_NAME"], info.NAME, info.CMPNAME, info.COMPANYNAME]),
    ...collectByKey(node, "CURRENTCOMPANY").flatMap(asArray),
    ...collectByKey(node, "SVCURRENTCOMPANY").flatMap(asArray),
    ...collectByKey(node, "CMPNAME").flatMap(asArray),
    ...collectByKey(node, "COMPANYNAME").flatMap(asArray),
    ...collectByKey(node, "DSPDISPNAME").flatMap(asArray),
  ];
  return uniqueCleanNames([...direct, ...nested]);
}

function parseCompanyNames(xml, context = "company discovery") {
  const parsed = parseXml(xml, context);
  return companyNameCandidatesFromNode(parsed);
}

function selectedCompanyFrom({ companyName } = {}) {
  const explicit = cleanName(companyName);
  const configured = cleanName(env.tallyCompanyName || process.env.TALLY_COMPANY_NAME);
  logImportStage("companyConfig", {
    envCompany: configured || null,
    normalizedEnvCompany: configured ? normalizeCompanyName(configured) : null,
  });
  if (explicit) return { companyName: explicit, normalizedCompany: normalizeCompanyName(explicit), companyNames: [explicit], method: "request_override" };
  if (configured) return { companyName: configured, normalizedCompany: normalizeCompanyName(configured), companyNames: [configured], method: "env_override" };
  return null;
}

async function discoverCompanyFromXml({ label, body }) {
  try {
    const xml = await tallyRequest(body, { timeoutMs: 10000, skipCompanyContext: true });
    const names = parseCompanyNames(xml, label);
    logImportStage("companyDetect", {
      status: names.length ? "success" : "empty",
      method: label,
      detectedCompanies: names,
      normalizedDetectedCompanies: names.map(normalizeCompanyName),
    });
    return names;
  } catch (error) {
    logImportStage("companyDetect", { status: "failed", method: label, error: error.message });
    return [];
  }
}

async function resolveTallyCompany({ companyName } = {}) {
  const selected = selectedCompanyFrom({ companyName });
  if (selected) {
    logImportStage("companyDetect", {
      status: "selected",
      method: selected.method,
      companyName: selected.companyName,
      normalizedCompany: selected.normalizedCompany,
    });
    return selected;
  }

  const loadedNames = await discoverCompanyFromXml({ label: "loaded_company_collection", body: buildLoadedCompanyCollectionXML() });
  if (loadedNames.length) {
    const company = loadedNames[0];
    return { companyName: company, normalizedCompany: normalizeCompanyName(company), companyNames: loadedNames, method: "loaded_company_collection" };
  }

  return { companyName: "", normalizedCompany: "", companyNames: [], method: "not_detected" };
}

async function requireTallyCompany(options = {}) {
  const resolved = await resolveTallyCompany(options);
  if (!resolved.companyName) {
    const error = new Error(COMPANY_CONTEXT_ERROR);
    error.companyNames = resolved.companyNames;
    error.companyDetectionMethod = resolved.method;
    throw error;
  }
  logImportStage("companyContext", {
    selectedCompany: resolved.companyName,
    normalizedCompany: resolved.normalizedCompany,
    injectedSVCURRENTCOMPANY: true,
    exactInjectedSVCURRENTCOMPANY: resolved.companyName,
    method: resolved.method,
  });
  return resolved;
}

function companyContextVariants(companyName) {
  const exact = cleanName(companyName);
  const variants = [
    exact,
    String(companyName || "").trim(),
    exact.replace(/\s+/g, " "),
    exact.replace(/\s+-\s+\(/g, " - ("),
    exact.replace(/\s+\(/g, " ("),
  ].map(cleanName).filter(Boolean);
  const seen = new Set();
  return variants.filter((variant) => {
    const key = variant;
    if (!normalizeCompanyName(variant) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cannotSetCompanyContext(message) {
  return /Could not set\s+'?SVCurrentCompany'?/i.test(message || "");
}

async function tallyRequestWithCompanyVariants(buildXml, companyName, options = {}) {
  const variants = companyContextVariants(companyName);
  let lastXml = "";
  let lastLineError = "";
  for (const variant of variants) {
    logImportStage("companyContextAttempt", {
      attemptedSVCURRENTCOMPANY: variant,
      normalizedAttempt: normalizeCompanyName(variant),
    });
    const xml = await tallyRequest(buildXml(variant), options);
    lastXml = xml;
    const tallyLineError = lineError(xml);
    if (!cannotSetCompanyContext(tallyLineError)) return { xml, companyName: variant, lineError: tallyLineError };
    lastLineError = tallyLineError;
  }
  return { xml: lastXml, companyName: variants[variants.length - 1] || cleanName(companyName), lineError: lastLineError };
}

function normalizeGroupName(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
}

function isCreditorGroupName(name) {
  const normalized = normalizeGroupName(name);
  return (
    /\bSUNDRY\s+CREDITORS?\b/.test(normalized) ||
    /\bTRADE\s+PAYABLES?\b/.test(normalized) ||
    /\bSUPPLIER\s+PAYABLES?\b/.test(normalized) ||
    /\bCREDITORS?\b/.test(normalized)
  );
}

function parseBooleanFlag(value) {
  return /^(YES|TRUE|1)$/i.test(text(value).trim());
}

function parseBalanceInfo(value) {
  const raw = text(value);
  const cleaned = raw.replace(/,/g, "").trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  let signed = match ? Number(match[0]) : 0;
  if (/\(/.test(cleaned) && /\)/.test(cleaned)) signed = -Math.abs(signed);
  const hasCreditMarker = /\bCR\b/i.test(cleaned);
  const hasDebitMarker = /\bDR\b/i.test(cleaned);
  if (hasCreditMarker && signed > 0) signed = -signed;
  if (hasDebitMarker && signed < 0) signed = Math.abs(signed);
  return {
    raw,
    signed: Number.isFinite(signed) ? signed : 0,
    absolute: Math.abs(Number.isFinite(signed) ? signed : 0),
    payable: signed < 0 || hasCreditMarker,
  };
}

function collectLedgerAliases(ledger) {
  const aliasValues = [
    ledger.ALIAS,
    ledger["NAME.LIST"]?.NAME,
    ledger.NAMELIST?.NAME,
    ledger.LANGUAGENAME?.NAME,
    ledger["LANGUAGENAME.LIST"]?.NAME,
  ].flatMap(asArray);
  return uniqueCleanNames(aliasValues);
}

function parseLedgerRecords(xml) {
  const { parsed } = validateStandardExportXml(xml, "List of Accounts", ["LEDGER", "GROUP", "DSPACCNAME"]);
  const ledgers = collectByKey(parsed, "LEDGER");
  const ledgerRecords = ledgers.map((ledger) => {
    const aliases = collectLedgerAliases(ledger);
    const name = cleanName(ledger["@_NAME"]) || cleanName(ledger.NAME) || aliases[0] || "";
    const parent = cleanName(ledger.PARENT);
    const closing = parseBalanceInfo(ledger.CLOSINGBALANCE);
    const opening = parseBalanceInfo(ledger.OPENINGBALANCE);
    return {
      name,
      parent,
      aliases,
      guid: cleanName(ledger.GUID) || cleanName(ledger.Guid) || cleanName(ledger["@_GUID"]),
      gstin: cleanName(ledger.GSTIN) || cleanName(ledger.GSTREGISTRATIONNUMBER) || cleanName(ledger.GSTREGNNO),
      isBillWiseOn: parseBooleanFlag(ledger.ISBILLWISEON),
      openingBalance: opening.signed,
      closingBalance: closing.signed,
      openingBalanceRaw: opening.raw,
      closingBalanceRaw: closing.raw,
      payableBalance: closing.payable || opening.payable,
      outstandingAmount: Math.round(closing.absolute * 100) / 100,
      raw: ledger,
    };
  }).filter((ledger) => ledger.name);
  if (ledgerRecords.length) return ledgerRecords;

  const names = collectByKey(parsed, "DSPACCNAME");
  const infos = collectByKey(parsed, "DSPACCINFO");
  return names.map((nameNode, index) => {
    const name = cleanName(nameNode?.DSPDISPNAME) || cleanName(nameNode?.NAME);
    const info = infos[index] || {};
    const crAmt = parseBalanceInfo(info?.DSPCLCRAMT?.DSPCLCRAMTA);
    const drAmt = parseBalanceInfo(info?.DSPCLDRAMT?.DSPCLDRAMTA);
    const amount = crAmt.absolute || drAmt.absolute;
    return {
      name,
      parent: "",
      aliases: [],
      guid: "",
      gstin: "",
      isBillWiseOn: false,
      openingBalance: 0,
      closingBalance: crAmt.absolute ? -amount : amount,
      openingBalanceRaw: "",
      closingBalanceRaw: crAmt.raw || drAmt.raw,
      payableBalance: crAmt.absolute > 0,
      outstandingAmount: Math.round(amount * 100) / 100,
      raw: { nameNode, info },
    };
  }).filter((ledger) => ledger.name);
}

function parseGroupCollection(xml) {
  if (!xml) return new Map();
  const parsed = parseXml(xml, "Group Collection");
  const groups = collectByKey(parsed, "GROUP");
  const map = new Map();
  for (const group of groups) {
    const name = cleanName(group["@_NAME"]) || cleanName(group.NAME);
    const parent = cleanName(group.PARENT);
    if (name) map.set(normalizeGroupName(name), parent);
  }
  return map;
}

function groupAncestors(parentName, groupMap) {
  const ancestors = [];
  const seen = new Set();
  let current = parentName;
  while (current && !seen.has(normalizeGroupName(current))) {
    seen.add(normalizeGroupName(current));
    const next = groupMap.get(normalizeGroupName(current));
    if (!next) break;
    ancestors.push(next);
    current = next;
  }
  return ancestors;
}

function classifyCreditorLedger(ledger, groupMap) {
  const ancestry = groupAncestors(ledger.parent, groupMap);
  const groupNames = [ledger.parent, ...ancestry].filter(Boolean);
  const parentCreditor = groupNames.some(isCreditorGroupName);
  const aliasCreditor = ledger.aliases.some(isCreditorGroupName);
  const hasOutstanding = ledger.outstandingAmount > 0;
  const hasBalanceSignal = Boolean(ledger.closingBalanceRaw || ledger.openingBalanceRaw);
  const reasons = [];
  if (parentCreditor) reasons.push("creditor_parent_or_ancestor");
  if (aliasCreditor) reasons.push("creditor_alias");
  if (ledger.isBillWiseOn) reasons.push("bill_wise_enabled");
  if (ledger.payableBalance) reasons.push("payable_balance");
  if (!hasBalanceSignal && (parentCreditor || aliasCreditor)) reasons.push("balance_unavailable_parent_match");
  const detected =
    parentCreditor ||
    aliasCreditor ||
    (hasOutstanding && (ledger.payableBalance || ledger.isBillWiseOn));
  return { detected, reasons, groupNames };
}

function buildCreditorDiagnostics({ records, creditors, groupMap, skipped }) {
  const parentNames = [...new Set(records.map((ledger) => ledger.parent).filter(Boolean).map(cleanName))].sort();
  const detectedParentNames = [...new Set(creditors.map((creditor) => creditor.parent).filter(Boolean))].sort();
  return {
    totalLedgersExported: records.length,
    detectedCreditorCount: creditors.length,
    skippedLedgerCount: skipped.length,
    sampleParentNames: parentNames.slice(0, 20),
    detectedParentNames: detectedParentNames.slice(0, 20),
    groupNamesEncountered: [...new Set([...parentNames, ...Array.from(groupMap.keys())])].slice(0, 50),
    skippedLedgerSamples: skipped.slice(0, 10).map((ledger) => ({
      name: ledger.name,
      parent: ledger.parent,
      closingBalance: ledger.closingBalanceRaw,
      isBillWiseOn: ledger.isBillWiseOn,
    })),
  };
}

function parseLedgerCollectionDetailed(xml, { groupXml = "" } = {}) {
  const records = parseLedgerRecords(xml);
  let groupMap = new Map();
  try {
    groupMap = parseGroupCollection(groupXml || xml);
  } catch (error) {
    logImportStage("creditorsExport", { status: "group_parse_failed", error: error.message });
  }
  const creditors = [];
  const skipped = [];

  for (const ledger of records) {
    const classification = classifyCreditorLedger(ledger, groupMap);
    if (!classification.detected) {
      skipped.push(ledger);
      continue;
    }
    creditors.push({
      ...ledger,
      name: ledger.name,
      normalizedVendorName: normalizeVendorName(ledger.name),
      detectionReasons: classification.reasons,
      groupHierarchy: classification.groupNames,
    });
  }

  const sorted = creditors.sort((a, b) => b.outstandingAmount - a.outstandingAmount);
  return {
    creditors: sorted,
    diagnostics: buildCreditorDiagnostics({ records, creditors: sorted, groupMap, skipped }),
  };
}

function parseLedgerCollection(xml, groupName = "Sundry Creditors", groupXml = "") {
  return parseLedgerCollectionDetailed(xml, { groupName, groupXml }).creditors;
}

function firstText(node, keys) {
  for (const key of keys) {
    const values = collectByKey(node, key).map(text).filter(Boolean);
    if (values[0]) return values[0];
  }
  return "";
}

function parseAmount(value) {
  const cleaned = text(value).replace(/,/g, "").replace(/[()]/g, "").trim();
  const number = parseFloat(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function collectAmounts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Object.prototype.hasOwnProperty.call(node, "AMOUNT")) {
    for (const amount of asArray(node.AMOUNT)) out.push(parseFloat(text(amount)) || 0);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => collectAmounts(item, out));
    else if (value && typeof value === "object") collectAmounts(value, out);
  }
  return out;
}

function collectBillRefs(entry) {
  return [
    ...collectByKey(entry, "BILLALLOCATIONS.LIST"),
    ...collectByKey(entry, "BILLALLOCATIONS"),
  ].map((bill) => ({
    billReference: cleanName(bill.NAME) || cleanName(bill.BILLNAME),
    signedAmount: parseAmount(bill.AMOUNT || bill.PENDINGAMOUNT),
    pendingAmount: Math.abs(parseAmount(bill.AMOUNT || bill.PENDINGAMOUNT)),
  })).filter((bill) => bill.billReference || bill.pendingAmount);
}

function signedAmountFromEntry(entry) {
  const directAmount = parseAmount(entry?.AMOUNT);
  if (directAmount) return directAmount;
  const billAmount = collectBillRefs(entry).find((bill) => bill.signedAmount)?.signedAmount || 0;
  if (billAmount) return billAmount;
  return collectAmounts(entry).find((amount) => amount !== 0) || 0;
}

function signedAmountFromVoucher(voucher) {
  const billAmount = collectBillRefs(voucher).find((bill) => bill.signedAmount)?.signedAmount || 0;
  if (billAmount) return billAmount;
  const amounts = collectAmounts(voucher).filter((amount) => amount !== 0);
  return amounts.find((amount) => amount < 0) || amounts.find((amount) => amount > 0) || 0;
}

function findLedgerEntry(voucher, ledgerName) {
  const target = normalizeVendorName(ledgerName);
  const entries = [
    ...collectByKey(voucher, "ALLLEDGERENTRIES.LIST"),
    ...collectByKey(voucher, "LEDGERENTRIES.LIST"),
  ];
  return entries.find((entry) => normalizeVendorName(cleanName(entry.LEDGERNAME)) === target) || null;
}

function findParticulars(voucher, ledgerName) {
  const target = normalizeVendorName(ledgerName);
  const entries = [
    ...collectByKey(voucher, "ALLLEDGERENTRIES.LIST"),
    ...collectByKey(voucher, "LEDGERENTRIES.LIST"),
  ];
  const counter = entries.find((entry) => {
    const name = cleanName(entry.LEDGERNAME);
    return name && normalizeVendorName(name) !== target;
  });
  return cleanName(counter?.LEDGERNAME) || cleanName(voucher.PARTYLEDGERNAME) || cleanName(voucher.PARTYNAME) || "";
}

function parseLedgerVouchers(xml, ledgerName) {
  const parsed = parseXml(xml, `Ledger Vouchers for ${ledgerName}`);
  const vouchers = collectByKey(parsed, "VOUCHER");
  const rows = [];
  for (const voucher of vouchers) {
    const date = formatDate(voucher.DATE || firstText(voucher, ["DATE"]));
    if (!date) continue;
    const ledgerEntry = findLedgerEntry(voucher, ledgerName);
    const entryAmount = ledgerEntry ? signedAmountFromEntry(ledgerEntry) : 0;
    const fallbackAmount = collectAmounts(voucher).find((amount) => amount !== 0) || 0;
    const signedAmount = entryAmount || fallbackAmount;
    const debit = signedAmount > 0 ? Math.abs(signedAmount) : 0;
    const credit = signedAmount < 0 ? Math.abs(signedAmount) : 0;
    const amount = Math.max(debit, credit);
    if (!amount) continue;
    const bill = collectBillRefs(ledgerEntry || voucher)[0] || {};
    rows.push({
      vendorName: ledgerName,
      normalizedVendorName: normalizeVendorName(ledgerName),
      ledgerName,
      normalizedLedgerName: normalizeVendorName(ledgerName),
      date,
      particulars: findParticulars(voucher, ledgerName),
      voucherType: text(voucher["@_VCHTYPE"]) || cleanName(voucher.VOUCHERTYPENAME),
      voucherNumber: text(voucher.VOUCHERNUMBER),
      debit: Math.round(debit * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      amount: Math.round(amount * 100) / 100,
      billReference: bill.billReference || "",
      pendingAmount: bill.pendingAmount || 0,
      raw: voucher,
    });
  }
  return rows;
}

function parseVoucherCollection(xml, creditorNames) {
  const parsed = parseXml(xml, "Voucher Collection");
  const vouchers = collectByKey(parsed, "VOUCHER");
  const creditorSet = new Set(creditorNames.map(normalizeVendorName));
  const rows = [];

  for (const voucher of vouchers) {
    const date = formatDate(voucher.DATE || firstText(voucher, ["DATE"]));
    if (!date) continue;
    const entries = [
      ...collectByKey(voucher, "ALLLEDGERENTRIES.LIST"),
      ...collectByKey(voucher, "LEDGERENTRIES.LIST"),
    ];
    const partyLedger = cleanName(voucher.PARTYLEDGERNAME) || cleanName(voucher.PARTYNAME);
    const voucherType = text(voucher["@_VCHTYPE"]) || cleanName(voucher.VOUCHERTYPENAME);
    const voucherNumber = text(voucher.VOUCHERNUMBER);
    const matchedLedgers = new Set();

    for (const entry of entries) {
      const ledgerName = cleanName(entry.LEDGERNAME);
      const normalized = normalizeVendorName(ledgerName);
      if (!ledgerName || !creditorSet.has(normalized)) continue;
      const signedAmount = signedAmountFromEntry(entry);
      const debit = signedAmount > 0 ? Math.abs(signedAmount) : 0;
      const credit = signedAmount < 0 ? Math.abs(signedAmount) : 0;
      const amount = Math.max(debit, credit);
      if (!amount) continue;
      const bill = collectBillRefs(entry)[0] || {};
      matchedLedgers.add(normalized);
      rows.push({
        vendorName: ledgerName,
        normalizedVendorName: normalized,
        ledgerName,
        normalizedLedgerName: normalized,
        date,
        particulars: partyLedger && normalizeVendorName(partyLedger) !== normalized ? partyLedger : findParticulars(voucher, ledgerName),
        voucherType,
        voucherNumber,
        debit: Math.round(debit * 100) / 100,
        credit: Math.round(credit * 100) / 100,
        amount: Math.round(amount * 100) / 100,
        billReference: bill.billReference || "",
        pendingAmount: bill.pendingAmount || 0,
        raw: voucher,
      });
    }

    const normalizedPartyLedger = normalizeVendorName(partyLedger);
    if (partyLedger && creditorSet.has(normalizedPartyLedger) && !matchedLedgers.has(normalizedPartyLedger)) {
      const signedAmount = signedAmountFromVoucher(voucher);
      const debit = signedAmount > 0 ? Math.abs(signedAmount) : 0;
      const credit = signedAmount < 0 ? Math.abs(signedAmount) : 0;
      const amount = Math.max(debit, credit);
      if (amount) {
        const bill = collectBillRefs(voucher)[0] || {};
        rows.push({
          vendorName: partyLedger,
          normalizedVendorName: normalizedPartyLedger,
          ledgerName: partyLedger,
          normalizedLedgerName: normalizedPartyLedger,
          date,
          particulars: findParticulars(voucher, partyLedger),
          voucherType,
          voucherNumber,
          debit: Math.round(debit * 100) / 100,
          credit: Math.round(credit * 100) / 100,
          amount: Math.round(amount * 100) / 100,
          billReference: bill.billReference || "",
          pendingAmount: bill.pendingAmount || 0,
          raw: voucher,
        });
      }
    }
  }

  return rows;
}

function parseVouchers(xml, filterType) {
  const parsed = parseXml(xml, "Day Book");
  const vouchers = collectByKey(parsed, "VOUCHER");
  const rows = [];
  for (const voucher of vouchers) {
    const vchType = text(voucher["@_VCHTYPE"]);
    if (filterType && vchType !== filterType) continue;
    const date = formatDate(voucher.DATE);
    const party = cleanName(voucher.PARTYLEDGERNAME);
    if (!date || !party) continue;
    const amounts = collectAmounts(voucher);
    rows.push({
      date,
      vchType,
      party,
      voucherNumber: text(voucher.VOUCHERNUMBER),
      amount: Math.abs(amounts.find((amount) => amount !== 0) || 0),
    });
  }
  return rows;
}

function computeFIFOAging(purchases, payments, asOn) {
  const asOnDate = new Date(asOn || new Date());
  const parties = {};
  for (const purchase of purchases) {
    if (!parties[purchase.party]) parties[purchase.party] = { purchases: [], payments: [] };
    parties[purchase.party].purchases.push({ ...purchase });
  }
  for (const payment of payments) {
    if (!parties[payment.party]) parties[payment.party] = { purchases: [], payments: [] };
    parties[payment.party].payments.push({ ...payment });
  }

  const agingMap = {};
  for (const [partyName, data] of Object.entries(parties)) {
    if (!data.purchases.length) continue;
    const invoices = [...data.purchases]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((invoice) => ({ ...invoice, remaining: invoice.amount, paid: 0 }));
    const pmts = [...data.payments].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const payment of pmts) {
      let left = payment.amount;
      for (const invoice of invoices) {
        if (left <= 0 || invoice.remaining <= 0) continue;
        const applied = Math.min(invoice.remaining, left);
        invoice.remaining -= applied;
        invoice.paid += applied;
        left -= applied;
      }
    }
    const outstanding = invoices.filter((invoice) => invoice.remaining >= 1);
    if (!outstanding.length) continue;
    const days = Math.floor((asOnDate - new Date(outstanding[0].date)) / 86400000);
    agingMap[partyName] = {
      oldestInvoiceDate: outstanding[0].date,
      daysOutstanding: days,
      bucket:
        days <= 30 ? "0-30 days" :
        days <= 45 ? "31-45 days" :
        days <= 60 ? "46-60 days" :
        days <= 90 ? "61-90 days" : "90+ days",
    };
  }
  return agingMap;
}

async function fetchCompanyName(options = {}) {
  const resolved = await resolveTallyCompany(options);
  return resolved.companyName;
}

async function fetchCreditors({ from = "20250401", to = "20260331", group = "Sundry Creditors", asOn, companyName } = {}) {
  let source = "list_of_accounts";
  let creditors = [];
  let warnings = [];
  let creditorDiagnostics = null;
  const company = await requireTallyCompany({ companyName });
  logImportStage("creditorsExport", {
    status: "start",
    from,
    to,
    group,
    companyName: company.companyName,
    primaryExportPath: "List of Accounts",
  });
  try {
    const { xml: ledgerXml } = await tallyRequestWithCompanyVariants(
      (selectedCompany) => buildLedgerCollectionXML(selectedCompany),
      company.companyName,
      { timeoutMs: 30000 }
    );
    const ledgerLineError = lineError(ledgerXml);
    if (ledgerLineError) throw new Error(ledgerLineError);
    const parsedLedgers = parseLedgerCollectionDetailed(ledgerXml, { groupName: group });
    creditors = parsedLedgers.creditors;
    creditorDiagnostics = parsedLedgers.diagnostics;
    logImportStage("creditorsExport", {
      status: "classified",
      source,
      primaryExportPathUsed: "List of Accounts",
      groupSummaryFallback: "skipped",
      fallbackSkippedReason: "List of Accounts is the stable creditor source",
      totalLedgersExported: creditorDiagnostics.totalLedgersExported,
      detectedCreditorCount: creditorDiagnostics.detectedCreditorCount,
      skippedLedgerCount: creditorDiagnostics.skippedLedgerCount,
      sampleParentNames: creditorDiagnostics.sampleParentNames,
      detectedParentNames: creditorDiagnostics.detectedParentNames,
    });
  } catch (ledgerError) {
    logImportStage("creditorsExport", { status: "ledger_collection_failed", error: ledgerError.message });
    warnings.push(`Ledger collection failed: ${ledgerError.message}`);
    logImportStage("creditorsExport", {
      status: "failed",
      source,
      primaryExportPathUsed: "List of Accounts",
      groupSummaryFallback: "skipped",
      fallbackSkippedReason: "Group Summary disabled for TallyPrime compatibility",
      error: ledgerError.message,
    });
    throw new Error(`Could not fetch Sundry Creditors from Tally: ${ledgerError.message}`);
  }
  warnings.push("Group Summary fallback skipped; using List of Accounts ledger classification only.");
  if (!creditors.length) {
    const sampleParents = creditorDiagnostics?.sampleParentNames || [];
    logImportStage("creditorsExport", {
      status: "empty",
      source,
      primaryExportPathUsed: "List of Accounts",
      groupSummaryFallback: "skipped",
      fallbackSkippedReason: "Group Summary disabled for TallyPrime compatibility",
      diagnostics: creditorDiagnostics || null,
    });
    const error = new Error(
      `0 creditor ledgers detected${sampleParents.length ? `. Sample parent names: ${sampleParents.join(", ")}` : ""}`
    );
    error.diagnostics = {
      creditorDiagnostics,
      warnings,
    };
    throw error;
  }
  logImportStage("creditorsExport", {
    status: "success",
    source,
    primaryExportPathUsed: "List of Accounts",
    groupSummaryFallback: "skipped",
    count: creditors.length,
    diagnostics: creditorDiagnostics ? {
      totalLedgersExported: creditorDiagnostics.totalLedgersExported,
      skippedLedgerCount: creditorDiagnostics.skippedLedgerCount,
      detectedParentNames: creditorDiagnostics.detectedParentNames,
    } : null,
  });

  let purchases = [];
  let payments = [];
  try {
    const { xml: dayBookXml } = await tallyRequestWithCompanyVariants(
      (selectedCompany) => buildDayBookXML(from, to, selectedCompany),
      company.companyName,
      { timeoutMs: 30000 }
    );
    const dayBookLineError = lineError(dayBookXml);
    if (dayBookLineError) throw new Error(dayBookLineError);
    purchases = [...parseVouchers(dayBookXml, "Purchase"), ...parseVouchers(dayBookXml, "Journal")];
    payments = parseVouchers(dayBookXml, "Payment");
  } catch (dayBookError) {
    warnings.push(`Day Book aging fetch failed: ${dayBookError.message}`);
  }
  const effectiveAsOn = asOn || new Date().toISOString().split("T")[0];
  const agingMap = computeFIFOAging(purchases, payments, effectiveAsOn);

  const result = creditors.map((creditor) => {
    const aging = agingMap[creditor.name] || null;
    const days = aging ? aging.daysOutstanding : null;
    const delayed = days != null && days > 45;
    const interest = delayed
      ? creditor.outstandingAmount * (Math.pow(1 + 0.195 / 12, days / 30) - 1)
      : 0;
    return {
      party: creditor.name,
      normalizedVendorName: creditor.normalizedVendorName,
      outstandingAmount: creditor.outstandingAmount,
      daysOutstanding: days,
      bucket: aging ? aging.bucket : "Unknown",
      delayed,
      interestLiability: Math.round(interest * 100) / 100,
      disallowanceAmount: delayed ? creditor.outstandingAmount : 0,
      oldestInvoiceDate: aging ? aging.oldestInvoiceDate : "",
    };
  });

  return {
    success: true,
    asOn: effectiveAsOn,
    period: { from, to },
    companyName: company.companyName,
    companyNames: company.companyNames,
    companyDetectionMethod: company.method,
    summary: {
      totalCreditors: result.length,
      totalOutstanding: Math.round(result.reduce((sum, row) => sum + row.outstandingAmount, 0) * 100) / 100,
      parsedPurchases: purchases.length,
      parsedPayments: payments.length,
      tallySource: source,
      creditorDiagnostics,
      warnings,
    },
    creditors: result,
  };
}

async function fetchLedgerVouchers({ ledgerName, from = "20250401", to = "20260331", companyName } = {}) {
  const company = await requireTallyCompany({ companyName });
  const { xml } = await tallyRequestWithCompanyVariants(
    (selectedCompany) => buildLedgerVouchersXML(from, to, ledgerName, selectedCompany),
    company.companyName,
    { timeoutMs: voucherTimeoutMs() }
  );
  const tallyLineError = lineError(xml);
  if (tallyLineError) throw new Error(tallyLineError);
  return parseLedgerVouchers(xml, ledgerName);
}

function voucherTimeoutMs() {
  return Number(process.env.TALLY_VOUCHER_TIMEOUT_MS || 60000);
}

function maxVoucherRowsPerBatch() {
  return Number(process.env.TALLY_VOUCHER_MAX_ROWS_PER_BATCH || 5000);
}

function isTimeoutError(error) {
  return error?.code === "ETIMEDOUT" || /timeout/i.test(error?.message || "");
}

function dedupeVoucherRows(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = [
      row.normalizedLedgerName,
      row.date,
      row.voucherType,
      row.voucherNumber,
      row.amount,
      row.billReference,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function dateInTallyRange(date, from, to) {
  const compact = String(date || "").replace(/-/g, "");
  return /^\d{8}$/.test(compact) && compact >= from && compact <= to;
}

async function fetchVoucherObjectCollectionBatch({ batch, creditorNames, companyName, mode }) {
  const startedAt = Date.now();
  logImportStage("vouchersExport", {
    status: "fallback_batch_start",
    primaryExportPath: "Day Book",
    fallbackExportPath: "Voucher Collection",
    mode,
    label: batch.label,
    from: batch.from,
    to: batch.to,
  });
  const { xml } = await tallyRequestWithCompanyVariants(
    (selectedCompany) => buildVoucherObjectCollectionXML(batch.from, batch.to, selectedCompany),
    companyName,
    { timeoutMs: voucherTimeoutMs() }
  );
  const tallyLineError = lineError(xml);
  if (tallyLineError) throw new Error(tallyLineError);
  const parsed = parseXml(xml, `Voucher Collection fallback ${batch.label}`);
  const exportedVoucherCount = countKeys(parsed, ["VOUCHER"]);
  const rows = parseVoucherCollection(xml, creditorNames)
    .filter((row) => dateInTallyRange(row.date, batch.from, batch.to))
    .map((row) => ({ ...row, voucherSource: "Voucher Collection" }));
  const maxRows = maxVoucherRowsPerBatch();
  const limitedRows = rows.slice(0, maxRows);
  logImportStage("vouchersExport", {
    status: "fallback_batch_end",
    primaryExportPath: "Day Book",
    fallbackExportPath: "Voucher Collection",
    mode,
    label: batch.label,
    from: batch.from,
    to: batch.to,
    responseSize: Buffer.byteLength(xml, "utf8"),
    elapsedMs: Date.now() - startedAt,
    exportedVoucherCount,
    parsedVoucherCount: rows.length,
    voucherCount: limitedRows.length,
    truncated: rows.length > maxRows,
  });
  return {
    rows: limitedRows,
    source: "Voucher Collection",
    fallbackUsed: true,
    warning: rows.length > maxRows
      ? { ledgerName: "ALL", message: `Voucher collection batch ${batch.label} exceeded ${maxRows} rows and was truncated to prevent huge exports.` }
      : null,
  };
}

async function fetchVoucherBatch({ batch, creditorNames, companyName, mode = "quarter" }) {
  const startedAt = Date.now();
  const xmlBody = buildVoucherCollectionXML(batch.from, batch.to, companyName);
  logImportStage("vouchersExport", {
    status: "batch_start",
    mode,
    label: batch.label,
    from: batch.from,
    to: batch.to,
    primaryExportPath: "Day Book",
    xmlSize: Buffer.byteLength(xmlBody, "utf8"),
  });
  const { xml } = await tallyRequestWithCompanyVariants(
    (selectedCompany) => buildVoucherCollectionXML(batch.from, batch.to, selectedCompany),
    companyName,
    { timeoutMs: voucherTimeoutMs() }
  );
  const tallyLineError = lineError(xml);
  if (tallyLineError) throw new Error(tallyLineError);
  const validated = validateStandardExportXml(xml, `Day Book voucher export ${batch.label}`, ["VOUCHER"]);
  const rows = parseVoucherCollection(xml, creditorNames).map((row) => ({ ...row, voucherSource: "Day Book" }));
  if (rows.length === 0) {
    logImportStage("vouchersExport", {
      status: "fallback_start",
      reason: "Day Book returned no creditor voucher rows",
      primaryExportPath: "Day Book",
      fallbackExportPath: "Voucher Collection",
      mode,
      label: batch.label,
      from: batch.from,
      to: batch.to,
      exportedVoucherCount: validated.rowCount,
      parsedVoucherCount: rows.length,
    });
    return fetchVoucherObjectCollectionBatch({ batch, creditorNames, companyName, mode });
  }
  const maxRows = maxVoucherRowsPerBatch();
  const limitedRows = rows.slice(0, maxRows);
  const elapsedMs = Date.now() - startedAt;
  logImportStage("vouchersExport", {
    status: "batch_end",
    mode,
    label: batch.label,
    from: batch.from,
    to: batch.to,
    primaryExportPath: "Day Book",
    responseSize: Buffer.byteLength(xml, "utf8"),
    elapsedMs,
    exportedVoucherCount: validated.rowCount,
    parsedVoucherCount: rows.length,
    voucherCount: limitedRows.length,
    truncated: rows.length > maxRows,
  });
  return {
    rows: limitedRows,
    source: "Day Book",
    fallbackUsed: false,
    warning: rows.length > maxRows
      ? { ledgerName: "ALL", message: `Voucher batch ${batch.label} exceeded ${maxRows} rows and was truncated to prevent huge exports.` }
      : null,
  };
}

async function fetchAllCreditorLedgerVouchers({ creditors, from = "20250401", to = "20260331", companyName } = {}) {
  const rows = [];
  const warnings = [];
  const sourcesUsed = new Set();
  let fallbackUsed = false;
  const creditorNames = creditors.map((creditor) => creditor.party || creditor.name).filter(Boolean);
  const quarterBatches = buildPeriodBatches(from, to, 3);
  const company = await requireTallyCompany({ companyName });
  logImportStage("vouchersExport", { status: "start", creditorCount: creditors.length, batchCount: quarterBatches.length, from, to, companyName: company.companyName });

  for (const batch of quarterBatches) {
    try {
      const result = await fetchVoucherBatch({ batch, creditorNames, companyName: company.companyName, mode: "quarter" });
      rows.push(...result.rows);
      if (result.source) sourcesUsed.add(result.source);
      if (result.fallbackUsed) fallbackUsed = true;
      if (result.warning) warnings.push(result.warning);
    } catch (error) {
      if (!isTimeoutError(error)) {
        warnings.push({ ledgerName: "ALL", message: `Voucher batch ${batch.label} failed: ${error.message}` });
        continue;
      }
      logImportStage("vouchersExport", { status: "batch_timeout_retry_monthly", label: batch.label, error: error.message });
      for (const monthBatch of buildMonthlyBatches(batch.from, batch.to)) {
        try {
          const result = await fetchVoucherBatch({ batch: monthBatch, creditorNames, companyName: company.companyName, mode: "monthly_retry" });
          rows.push(...result.rows);
          if (result.source) sourcesUsed.add(result.source);
          if (result.fallbackUsed) fallbackUsed = true;
          if (result.warning) warnings.push(result.warning);
        } catch (monthlyError) {
          warnings.push({
            ledgerName: "ALL",
            message: `Voucher batch ${monthBatch.label} failed: ${monthlyError.message}`,
          });
        }
      }
    }
  }

  const mergedRows = dedupeVoucherRows(rows);
  const voucherSource = sourcesUsed.size > 1 ? [...sourcesUsed].join(" + ") : [...sourcesUsed][0] || "Day Book";
  if (quarterBatches.length > 0 && mergedRows.length === 0 && warnings.length >= quarterBatches.length) {
    logImportStage("vouchersExport", { status: "failed", warnings });
    throw new Error(`Could not fetch voucher rows for selected financial year: ${warnings[0]?.message || "Tally voucher export failed"}`);
  }
  if (fallbackUsed) {
    warnings.push({
      ledgerName: "ALL",
      message: "Voucher Collection fallback was used because Day Book returned no creditor voucher rows for one or more batches.",
      severity: "warning",
    });
  }
  logImportStage("vouchersExport", {
    status: "success",
    exportedVoucherCount: rows.length,
    parsedVoucherCount: rows.length,
    dedupedVoucherCount: mergedRows.length,
    voucherSource,
    fallbackUsed,
    rows: mergedRows.length,
    warnings: warnings.length,
  });
  return { rows: mergedRows, warnings, voucherSource, fallbackUsed, sourcesUsed: [...sourcesUsed] };
}

async function checkStatus() {
  const company = await requireTallyCompany();
  const { xml } = await tallyRequestWithCompanyVariants(
    (selectedCompany) => buildLedgerCollectionXML(selectedCompany),
    company.companyName,
    { timeoutMs: 30000 }
  );
  validateStandardExportXml(xml, "List of Accounts status check", ["LEDGER", "GROUP", "DSPACCNAME"]);
  return { online: true, tallyConnected: true };
}

async function companyContextStatus(options = {}) {
  const configuredCompany = cleanName(env.tallyCompanyName || process.env.TALLY_COMPANY_NAME);
  const resolved = await resolveTallyCompany(options);
  const processes = await detectTallyProcesses();
  let companyContextWorking = false;
  let error = null;

  if (resolved.companyName) {
    try {
      const { xml } = await tallyRequestWithCompanyVariants(
        (selectedCompany) => buildLedgerCollectionXML(selectedCompany),
        resolved.companyName,
        { timeoutMs: 30000 }
      );
      validateStandardExportXml(xml, "List of Accounts company context probe", ["LEDGER", "GROUP", "DSPACCNAME"]);
      companyContextWorking = true;
    } catch (probeError) {
      error = probeError.message;
    }
  } else {
    error = COMPANY_CONTEXT_ERROR;
  }

  return {
    configuredCompany: configuredCompany || null,
    normalizedCompany: configuredCompany ? normalizeCompanyName(configuredCompany) : null,
    detectedCompanies: resolved.companyNames || [],
    selectedCompany: resolved.companyName || null,
    multipleTallyProcesses: processes.length > 1,
    tallyProcesses: processes,
    companyContextWorking,
    error,
  };
}

async function startupValidation() {
  const configuredCompany = cleanName(env.tallyCompanyName || process.env.TALLY_COMPANY_NAME);
  if (!configuredCompany) {
    console.warn("[tally] TALLY_COMPANY_NAME is not configured. Company context will be auto-detected when possible.");
  } else {
    console.log(`[tally] configuredCompany=${JSON.stringify(configuredCompany)} normalized=${JSON.stringify(normalizeCompanyName(configuredCompany))}`);
  }
  const processes = await detectTallyProcesses();
  if (processes.length > 1) {
    console.warn(`[tally] Multiple TallyPrime.exe processes detected (${processes.length}). Close duplicate Tally instances to avoid unstable company context.`);
  }
  return { configuredCompany, processes };
}

async function tallyHealth(options = {}) {
  let pingResponse;
  logImportStage("ping", { status: "start" });
  try {
    pingResponse = await tallyStatusRequest({ timeoutMs: 5000 });
  } catch (error) {
    const errors = error.tallyErrors || [{ host: env.tallyHost, code: error.code || null, message: error.message }];
    logImportStage("ping", { status: "failed", errors });
    return {
      reachable: false,
      portOpen: false,
      serverRunning: false,
      xmlPostWorking: false,
      companyDetected: false,
      companyLoaded: false,
      companyName: null,
      rawPingResponse: "",
      rawXmlResponsePreview: "",
      error: "TallyPrime is not open or port 9000 is unreachable",
      nextAction: "Open TallyPrime and enable the XML/HTTP server on port 9000.",
      port: env.tallyPort,
      message: "TallyPrime is not open or port 9000 is unreachable",
      errors: ["Port 9000 unreachable", ...errors.map((item) => item.code || item.message).filter(Boolean)],
    };
  }

  const rawPingResponse = pingResponse.body || "";
  const serverRunning =
    pingResponse.statusCode === 200 ||
    /TallyPrime\s+Server\s+is\s+Running/i.test(rawPingResponse) ||
    /Tally\s+Server\s+is\s+Running/i.test(rawPingResponse) ||
    /<RESPONSE>/i.test(rawPingResponse);
  logImportStage("ping", { status: serverRunning ? "success" : "invalid_response", httpStatus: pingResponse.statusCode });

  if (!serverRunning) {
    return {
      reachable: true,
      portOpen: true,
      serverRunning: false,
      xmlPostWorking: false,
      companyDetected: false,
      companyLoaded: false,
      companyName: null,
      rawPingResponse,
      rawXmlResponsePreview: "",
      error: "Tally responded on port 9000, but did not return the expected server status.",
      nextAction: "Confirm TallyPrime XML/HTTP server is enabled on port 9000.",
      port: env.tallyPort,
      message: "Tally responded on port 9000, but did not return the expected server status.",
      errors: ["Invalid Tally server response"],
    };
  }

  const company = await resolveTallyCompany(options);
  if (!company.companyName) {
    logImportStage("xmlPostTest", { status: "failed", error: COMPANY_CONTEXT_ERROR });
    return {
      reachable: true,
      portOpen: true,
      serverRunning: true,
      xmlPostWorking: false,
      companyDetected: false,
      companyLoaded: false,
      companyName: null,
      companyNames: company.companyNames,
      companyDetectionMethod: company.method,
      rawPingResponse,
      rawXmlResponsePreview: "",
      error: COMPANY_CONTEXT_ERROR,
      nextAction: "Open the target company in TallyPrime or set TALLY_COMPANY_NAME.",
      port: env.tallyPort,
      xmlServerResponding: true,
      message: COMPANY_CONTEXT_ERROR,
      errors: [COMPANY_CONTEXT_ERROR],
    };
  }
  logImportStage("companyContext", {
    selectedCompany: company.companyName,
    normalizedCompany: company.normalizedCompany,
    injectedSVCURRENTCOMPANY: true,
    exactInjectedSVCURRENTCOMPANY: company.companyName,
    method: company.method,
  });

  let exportProbe;
  let exportProbeBody = "";
  logImportStage("xmlPostTest", { status: "start" });
  try {
    const companyProbe = await tallyRequestWithCompanyVariants(
      (selectedCompany) => buildLedgerCollectionXML(selectedCompany),
      company.companyName,
      { timeoutMs: 30000 }
    );
    exportProbeBody = companyProbe.xml;
    exportProbe = { body: companyProbe.xml };
    const validated = validateStandardExportXml(exportProbeBody, "List of Accounts health probe", ["LEDGER", "GROUP", "DSPACCNAME"]);
    logImportStage("xmlPostTest", { status: "success", reportName: "List of Accounts", parsedRows: validated.rowCount });
  } catch (error) {
    logImportStage("xmlPostTest", { status: "failed", error: error.message });
    return {
      reachable: true,
      portOpen: true,
      serverRunning: true,
      xmlPostWorking: false,
      companyDetected: true,
      companyLoaded: false,
      companyName: company.companyName,
      companyNames: company.companyNames,
      companyDetectionMethod: company.method,
      rawPingResponse,
      rawXmlResponsePreview: preview(exportProbeBody || exportProbe?.body || ""),
      error: "Tally server is reachable, but XML export request failed.",
      nextAction: "Restart TallyPrime or verify that XML export requests are allowed on port 9000.",
      port: env.tallyPort,
      xmlServerResponding: false,
      message: "Tally server is reachable, but XML export request failed.",
      errors: [error.message, ...(error.tallyErrors || []).map((item) => item.code || item.message)].filter(Boolean),
    };
  }

  return {
    reachable: true,
    portOpen: true,
    serverRunning: true,
    xmlPostWorking: true,
    companyDetected: true,
    companyLoaded: true,
    companyName: company.companyName,
    companyNames: company.companyNames,
    companyDetectionMethod: company.method,
    rawPingResponse,
    rawXmlResponsePreview: preview(exportProbeBody || exportProbe.body),
    error: null,
    nextAction: "Ready to import from TallyPrime.",
    port: env.tallyPort,
    xmlServerResponding: true,
    message: "Tally server is running",
    errors: [],
  };
}

module.exports = {
  tallyRequest,
  fetchCreditors,
  checkStatus,
  tallyHealth,
  parseLedgerCollection,
  parseVouchers,
  computeFIFOAging,
  parseLedgerVouchers,
  parseVoucherCollection,
  fetchLedgerVouchers,
  fetchAllCreditorLedgerVouchers,
  buildPeriodBatches,
  buildMonthlyBatches,
  buildVoucherCollectionXML,
  buildLedgerCollectionXML,
  buildLedgerVouchersXML,
  parseCompanyNames,
  normalizeCompanyName,
  resolveTallyCompany,
  companyContextStatus,
  startupValidation,
  parseTallyProcessList,
  detectTallyProcesses,
  COMPANY_CONTEXT_ERROR,
  tallyStatusRequest,
};
