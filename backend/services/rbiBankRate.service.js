const crypto = require("crypto");
const https = require("https");
const db = require("../config/database");
const env = require("../config/env");

const DICGC_BANK_RATE_URL = "https://www.dicgc.org.in/bank-rate";
const ALLOWED_HOSTS = new Set(["www.dicgc.org.in", "dicgc.org.in", "www.rbi.org.in", "rbi.org.in", "m.rbi.org.in"]);
const UPDATE_FAILURE_MESSAGE = "RBI rate update failed — use last verified rate or manual override.";

function nowIso() {
  return new Date().toISOString();
}

function roundRate(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || /^till date$/i.test(text) || /^upto$/i.test(text)) return null;
  const compact = text
    .replace(/Sept/i, "Sep")
    .replace(/June/i, "Jun")
    .replace(/,/g, "");
  const named = compact.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (named) {
    const months = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const [, dd, monthName, year] = named;
    const mm = months[monthName.slice(0, 3).toLowerCase()];
    return mm ? `${year}-${mm}-${dd.padStart(2, "0")}` : null;
  }
  const direct = new Date(compact);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString().slice(0, 10);
  const numeric = compact.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (numeric) {
    const [, dd, mm, yy] = numeric;
    const year = yy.length === 2 ? `20${yy}` : yy;
    return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return null;
}

function normalizeRate(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? roundRate(Number(match[1])) : null;
}

function stripTags(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function assertAllowedSource(sourceUrl) {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS official RBI/DICGC sources are allowed");
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Only official RBI/DICGC Bank Rate sources are allowed");
  }
  if (!/bank-rate/i.test(parsed.pathname) && !/rbi\.org\.in$/i.test(parsed.hostname)) {
    throw new Error("Source must be a Bank Rate page or an explicitly allowed RBI current-rate page");
  }
}

function fetchText(sourceUrl) {
  assertAllowedSource(sourceUrl);
  return new Promise((resolve, reject) => {
    const request = https.get(sourceUrl, { headers: { "User-Agent": "MSME-Guard/1.0 BankRateUpdater" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, sourceUrl).toString();
        fetchText(redirected).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Official source returned HTTP ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    });
    request.setTimeout(20000, () => {
      request.destroy(new Error("Official source timed out"));
    });
    request.on("error", reject);
  });
}

function parseBankRateRows(html, sourceUrl = DICGC_BANK_RATE_URL, fetchedAt = nowIso()) {
  const text = stripTags(html);
  const matches = [];
  const rowPattern = /(\d{1,2}\s+[A-Za-z]+,?\s+\d{4})\s+(Till Date|\d{1,2}\s+[A-Za-z]+,?\s+\d{4})\s+(\d+(?:\.\d+)?)%\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%/gi;
  let match;
  while ((match = rowPattern.exec(text))) {
    const effectiveFromDate = normalizeDate(match[1]);
    const effectiveToDate = normalizeDate(match[2]);
    const bankRate = normalizeRate(match[3]);
    if (!effectiveFromDate || bankRate == null) continue;
    matches.push({
      effectiveFromDate,
      effectiveToDate,
      bankRate,
      sourceUrl,
      downloadedPdfPath: "",
      sourceType: "official_fetch",
      isManualOverride: false,
      overrideReason: "",
      createdBy: "",
      fetchedAt,
      createdAt: fetchedAt,
    });
  }
  return matches;
}

function mapRate(row) {
  if (!row) return null;
  return {
    id: row.id,
    effectiveFromDate: row.effective_from_date,
    effectiveToDate: row.effective_to_date || "",
    bankRate: Number(row.bank_rate),
    sourceUrl: row.source_url,
    downloadedPdfPath: row.downloaded_pdf_path || "",
    sourceType: row.source_type || "",
    isManualOverride: Boolean(row.is_manual_override),
    overrideReason: row.override_reason || "",
    createdBy: row.created_by || "",
    fetchedAt: row.fetched_at,
    createdAt: row.created_at,
  };
}

function mapAudit(row) {
  return {
    id: row.id,
    action: row.action,
    oldValue: parseJson(row.old_value_json, {}),
    newValue: parseJson(row.new_value_json, {}),
    changedBy: row.changed_by,
    reason: row.reason,
    sourceUrl: row.source_url,
    changedAt: row.changed_at,
  };
}

function insertAudit({ action, oldValue, newValue, actor, reason, sourceUrl, timestamp = nowIso() }) {
  db.prepare(`
    INSERT INTO rbi_bank_rate_audit_log (
      id, action, old_value_json, new_value_json, changed_by, reason, source_url, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    action,
    JSON.stringify(oldValue || {}),
    JSON.stringify(newValue || {}),
    actor || "unknown",
    reason || "",
    sourceUrl || "",
    timestamp
  );
}

function saveRates(rates = [], actor = "unknown") {
  const inserted = [];
  const statement = db.prepare(`
    INSERT OR IGNORE INTO rbi_bank_rates (
      id, effective_from_date, effective_to_date, bank_rate, source_url, downloaded_pdf_path,
      source_type, is_manual_override, override_reason, created_by, fetched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const rate of rates) {
      const id = crypto.randomUUID();
      const result = statement.run(
        id,
        rate.effectiveFromDate,
        rate.effectiveToDate || null,
        rate.bankRate,
        rate.sourceUrl,
        rate.downloadedPdfPath || "",
        rate.sourceType || "official_fetch",
        rate.isManualOverride ? 1 : 0,
        rate.overrideReason || "",
        actor,
        rate.fetchedAt || nowIso(),
        rate.createdAt || nowIso()
      );
      if (result.changes) inserted.push({ ...rate, id, createdBy: actor });
    }
    if (inserted.length) {
      insertAudit({
        action: "rbi_bank_rate_official_update",
        newValue: { inserted },
        actor,
        reason: "Fetched official DICGC Bank Rate history",
        sourceUrl: rates[0]?.sourceUrl || DICGC_BANK_RATE_URL,
      });
    }
  });
  tx();
  return inserted;
}

async function updateFromOfficialSource({ actor = "unknown", sourceUrl = DICGC_BANK_RATE_URL, fetcher = fetchText } = {}) {
  try {
    assertAllowedSource(sourceUrl);
    const fetchedAt = nowIso();
    const rates = [];
    for (let page = 1; page <= 20; page += 1) {
      const pageUrl = page === 1 ? sourceUrl : pageSourceUrl(sourceUrl, page);
      const html = await fetcher(pageUrl);
      const pageRates = parseBankRateRows(html, pageUrl, fetchedAt);
      if (!pageRates.length && page > 1) break;
      rates.push(...pageRates);
      if (pageRates.length === 0) break;
    }
    if (!rates.length) throw new Error("No Bank Rate history rows found in official source");
    const inserted = saveRates(rates, actor);
    return {
      success: true,
      sourceUrl,
      fetchedAt,
      parsed: rates.length,
      inserted: inserted.length,
      latest: getLatestRate(),
      rates: listRates(),
    };
  } catch (error) {
    insertAudit({
      action: "rbi_bank_rate_update_failed",
      oldValue: { latest: getLatestRate() },
      newValue: { error: error.message },
      actor,
      reason: UPDATE_FAILURE_MESSAGE,
      sourceUrl,
    });
    const failure = new Error(UPDATE_FAILURE_MESSAGE);
    failure.status = 502;
    failure.causeMessage = error.message;
    throw failure;
  }
}

function pageSourceUrl(sourceUrl, page) {
  const parsed = new URL(sourceUrl);
  parsed.searchParams.set("page", String(page));
  return parsed.toString();
}

function listRates() {
  return db.prepare(`
    SELECT * FROM rbi_bank_rates
    ORDER BY effective_from_date DESC, is_manual_override DESC, fetched_at DESC
  `).all().map(mapRate);
}

function listAuditLog() {
  return db.prepare("SELECT * FROM rbi_bank_rate_audit_log ORDER BY changed_at DESC LIMIT 100").all().map(mapAudit);
}

function getLatestRate() {
  return mapRate(db.prepare(`
    SELECT * FROM rbi_bank_rates
    ORDER BY effective_from_date DESC, is_manual_override DESC, fetched_at DESC
    LIMIT 1
  `).get());
}

function getRateForDate(dateValue) {
  const date = normalizeDate(dateValue) || String(dateValue || "").slice(0, 10);
  if (!date) return null;
  const row = db.prepare(`
    SELECT * FROM rbi_bank_rates
    WHERE effective_from_date <= ?
      AND (effective_to_date IS NULL OR effective_to_date = '' OR effective_to_date >= ?)
    ORDER BY is_manual_override DESC, effective_from_date DESC, fetched_at DESC
    LIMIT 1
  `).get(date, date);
  return mapRate(row);
}

function fallbackRate(dateValue = "") {
  const bankRate = roundRate(env.msmeBankRatePercent || 5.5);
  return {
    id: "",
    effectiveFromDate: normalizeDate(dateValue) || "",
    effectiveToDate: "",
    bankRate,
    sourceUrl: "MSME_BANK_RATE_PERCENT",
    downloadedPdfPath: "",
    sourceType: "config_fallback",
    isManualOverride: false,
    overrideReason: "",
    createdBy: "",
    fetchedAt: "",
    createdAt: "",
  };
}

function getRateForDateOrFallback(dateValue) {
  return getRateForDate(dateValue) || fallbackRate(dateValue);
}

function createManualOverride(input = {}, actor = "unknown") {
  const effectiveFromDate = normalizeDate(input.effectiveFromDate || input.effective_from_date);
  const effectiveToDate = normalizeDate(input.effectiveToDate || input.effective_to_date);
  const bankRate = normalizeRate(input.bankRate ?? input.bank_rate);
  const reason = String(input.reason || input.overrideReason || "").trim();
  if (!effectiveFromDate) {
    const error = new Error("effectiveFromDate is required");
    error.status = 400;
    throw error;
  }
  if (bankRate == null || bankRate < 0) {
    const error = new Error("bankRate must be a non-negative number");
    error.status = 400;
    throw error;
  }
  if (!reason) {
    const error = new Error("Manual override reason is required");
    error.status = 400;
    throw error;
  }
  const timestamp = nowIso();
  const oldValue = getRateForDate(effectiveFromDate);
  const id = crypto.randomUUID();
  const sourceUrl = input.sourceUrl || "manual_override";
  db.prepare(`
    INSERT INTO rbi_bank_rates (
      id, effective_from_date, effective_to_date, bank_rate, source_url, downloaded_pdf_path,
      source_type, is_manual_override, override_reason, created_by, fetched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, '', 'manual_override', 1, ?, ?, ?, ?)
  `).run(id, effectiveFromDate, effectiveToDate, bankRate, sourceUrl, reason, actor, timestamp, timestamp);
  const newValue = mapRate(db.prepare("SELECT * FROM rbi_bank_rates WHERE id = ?").get(id));
  insertAudit({
    action: "rbi_bank_rate_manual_override",
    oldValue,
    newValue,
    actor,
    reason,
    sourceUrl,
    timestamp,
  });
  return newValue;
}

module.exports = {
  DICGC_BANK_RATE_URL,
  UPDATE_FAILURE_MESSAGE,
  normalizeDate,
  parseBankRateRows,
  updateFromOfficialSource,
  listRates,
  listAuditLog,
  getLatestRate,
  getRateForDate,
  getRateForDateOrFallback,
  createManualOverride,
};
