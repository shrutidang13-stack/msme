const crypto = require("crypto");
const db = require("../config/database");
const { normalizeVendorName } = require("../utils/normalizeVendorName");

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapVendor(row) {
  if (!row) return null;
  return {
    id: row.id,
    vendorName: row.vendor_name,
    normalizedVendorName: row.normalized_vendor_name,
    isMSME: Boolean(row.is_msme),
    udyamNumber: row.udyam_number || "",
    enterpriseType: row.enterprise_type || "",
    verificationStatus: row.verification_status,
    enterpriseName: row.enterprise_name || "",
    registrationValidity: row.registration_validity || "",
    registrationDate: row.registration_date || "",
    verifiedAt: row.verified_at || "",
    lastVerifiedAt: row.last_verified_at || "",
    udyamStatus: row.udyam_status || "not_started",
    udyamProofFileUrl: row.udyam_proof_file_url || "",
    udyamProofUploadedAt: row.udyam_proof_uploaded_at || "",
    udyamVerifiedBy: row.udyam_verified_by || "",
    udyamVerifiedAt: row.udyam_verified_at || "",
    udyamRemarks: row.udyam_remarks || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRawByNormalized(normalizedVendorName) {
  return db.prepare("SELECT * FROM vendor_master WHERE normalized_vendor_name = ?").get(normalizedVendorName);
}

function getRawById(id) {
  return db.prepare("SELECT * FROM vendor_master WHERE id = ?").get(id);
}

function findByNormalizedName(normalizedVendorName) {
  return mapVendor(getRawByNormalized(normalizedVendorName));
}

function findManyByNames(vendorNames) {
  const normalized = [...new Set(vendorNames.map(normalizeVendorName).filter(Boolean))];
  if (!normalized.length) return [];
  const placeholders = normalized.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM vendor_master WHERE normalized_vendor_name IN (${placeholders})`)
    .all(...normalized)
    .map(mapVendor);
}

function getAllVendors() {
  return db.prepare("SELECT * FROM vendor_master ORDER BY vendor_name COLLATE NOCASE").all().map(mapVendor);
}

function findById(id) {
  return mapVendor(getRawById(id));
}

function getUnverified(vendorNames = []) {
  const existing = findManyByNames(vendorNames);
  const byNormalized = new Map(existing.map((vendor) => [vendor.normalizedVendorName, vendor]));
  return [...new Set(vendorNames.map(normalizeVendorName).filter(Boolean))]
    .map((normalized) => byNormalized.get(normalized))
    .filter((vendor) => !vendor || ["pending", "failed", "manual_fallback_required"].includes(vendor.verificationStatus));
}

function upsertVendorStatus(input, actor = "unknown", source = "manual") {
  const timestamp = nowIso();
  const normalizedVendorName = normalizeVendorName(input.vendorName);
  if (!normalizedVendorName) throw new Error("vendorName is required");

  const oldRow = getRawByNormalized(normalizedVendorName);
  const oldVendor = mapVendor(oldRow);
  const id = oldVendor?.id || crypto.randomUUID();
  const isMSME = Boolean(input.isMSME);
  const verificationStatus = input.verificationStatus || (isMSME ? "verified" : "not_msme");
  const udyamStatus = input.udyamStatus || (
    verificationStatus === "verified" ? "verified" :
    verificationStatus === "manual_fallback_required" ? "manual_fallback_required" :
    oldVendor?.udyamStatus || "not_started"
  );
  const vendor = {
    id,
    vendor_name: input.vendorName.trim(),
    normalized_vendor_name: normalizedVendorName,
    is_msme: isMSME ? 1 : 0,
    udyam_number: input.udyamNumber || "",
    enterprise_type: isMSME ? input.enterpriseType || "" : "",
    verification_status: verificationStatus,
    enterprise_name: input.enterpriseName || "",
    registration_validity: input.registrationValidity || "",
    registration_date: input.registrationDate || "",
    verified_at: input.verifiedAt || oldVendor?.verifiedAt || (isMSME ? timestamp : ""),
    last_verified_at: input.lastVerifiedAt || timestamp,
    udyam_status: udyamStatus,
    udyam_proof_file_url: input.udyamProofFileUrl ?? oldVendor?.udyamProofFileUrl ?? "",
    udyam_proof_uploaded_at: input.udyamProofUploadedAt ?? oldVendor?.udyamProofUploadedAt ?? "",
    udyam_verified_by: input.udyamVerifiedBy ?? oldVendor?.udyamVerifiedBy ?? "",
    udyam_verified_at: input.udyamVerifiedAt ?? oldVendor?.udyamVerifiedAt ?? "",
    udyam_remarks: input.udyamRemarks ?? oldVendor?.udyamRemarks ?? "",
    created_by: oldVendor?.createdBy || actor,
    created_at: oldVendor?.createdAt || timestamp,
    updated_at: timestamp,
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO vendor_master (
        id, vendor_name, normalized_vendor_name, is_msme, udyam_number, enterprise_type,
        verification_status, enterprise_name, registration_validity, registration_date,
        verified_at, last_verified_at, udyam_status, udyam_proof_file_url, udyam_proof_uploaded_at,
        udyam_verified_by, udyam_verified_at, udyam_remarks,
        created_by, created_at, updated_at
      ) VALUES (
        @id, @vendor_name, @normalized_vendor_name, @is_msme, @udyam_number, @enterprise_type,
        @verification_status, @enterprise_name, @registration_validity, @registration_date,
        @verified_at, @last_verified_at, @udyam_status, @udyam_proof_file_url, @udyam_proof_uploaded_at,
        @udyam_verified_by, @udyam_verified_at, @udyam_remarks,
        @created_by, @created_at, @updated_at
      )
      ON CONFLICT(normalized_vendor_name) DO UPDATE SET
        vendor_name = excluded.vendor_name,
        is_msme = excluded.is_msme,
        udyam_number = excluded.udyam_number,
        enterprise_type = excluded.enterprise_type,
        verification_status = excluded.verification_status,
        enterprise_name = excluded.enterprise_name,
        registration_validity = excluded.registration_validity,
        registration_date = excluded.registration_date,
        verified_at = excluded.verified_at,
        last_verified_at = excluded.last_verified_at,
        udyam_status = excluded.udyam_status,
        udyam_proof_file_url = excluded.udyam_proof_file_url,
        udyam_proof_uploaded_at = excluded.udyam_proof_uploaded_at,
        udyam_verified_by = excluded.udyam_verified_by,
        udyam_verified_at = excluded.udyam_verified_at,
        udyam_remarks = excluded.udyam_remarks,
        updated_at = excluded.updated_at
    `).run(vendor);

    const nextVendor = mapVendor(getRawById(id));
    db.prepare(`
      INSERT INTO vendor_audit_log (
        id, vendor_id, action, old_value, new_value, changed_by, changed_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      id,
      oldVendor ? "vendor_status_updated" : "vendor_status_created",
      oldVendor ? JSON.stringify(oldVendor) : "",
      JSON.stringify(nextVendor),
      actor,
      timestamp,
      source
    );
  });

  tx();
  return mapVendor(getRawById(id));
}

function updateVendorById(id, patch, actor = "unknown", source = "manual") {
  const oldVendor = findById(id);
  if (!oldVendor) throw new Error("Vendor not found");
  return upsertVendorStatus(
    {
      vendorName: patch.vendorName || oldVendor.vendorName,
      isMSME: patch.isMSME ?? oldVendor.isMSME,
      udyamNumber: patch.udyamNumber ?? oldVendor.udyamNumber,
      enterpriseName: patch.enterpriseName ?? oldVendor.enterpriseName,
      enterpriseType: patch.enterpriseType ?? oldVendor.enterpriseType,
      verificationStatus: patch.verificationStatus ?? oldVendor.verificationStatus,
      registrationValidity: patch.registrationValidity ?? oldVendor.registrationValidity,
      registrationDate: patch.registrationDate ?? oldVendor.registrationDate,
      verifiedAt: patch.verifiedAt ?? oldVendor.verifiedAt,
      lastVerifiedAt: patch.lastVerifiedAt ?? oldVendor.lastVerifiedAt,
      udyamStatus: patch.udyamStatus ?? oldVendor.udyamStatus,
      udyamProofFileUrl: patch.udyamProofFileUrl ?? oldVendor.udyamProofFileUrl,
      udyamProofUploadedAt: patch.udyamProofUploadedAt ?? oldVendor.udyamProofUploadedAt,
      udyamVerifiedBy: patch.udyamVerifiedBy ?? oldVendor.udyamVerifiedBy,
      udyamVerifiedAt: patch.udyamVerifiedAt ?? oldVendor.udyamVerifiedAt,
      udyamRemarks: patch.udyamRemarks ?? oldVendor.udyamRemarks,
    },
    actor,
    source
  );
}

function getManualReviewVendors() {
  return db
    .prepare("SELECT * FROM vendor_master WHERE udyam_status IN ('manual_fallback_required', 'pending_manual_review') ORDER BY updated_at DESC")
    .all()
    .map(mapVendor);
}

function recordVerificationAttempt({ vendorId, vendorName, udyamNumber, status, response, screenshotPath, actor }) {
  db.prepare(`
    INSERT INTO udyam_verification_attempts (
      id, vendor_id, vendor_name, udyam_number, status, response_json, screenshot_path, attempted_by, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    vendorId || null,
    vendorName,
    udyamNumber,
    status,
    JSON.stringify(response || {}),
    screenshotPath || "",
    actor || "unknown",
    nowIso()
  );
}

function getAuditTrail() {
  return db.prepare("SELECT * FROM vendor_audit_log ORDER BY changed_at DESC").all().map((row) => ({
    id: row.id,
    vendorId: row.vendor_id,
    action: row.action,
    oldValue: parseJson(row.old_value),
    newValue: parseJson(row.new_value, {}),
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    source: row.source,
  }));
}

module.exports = {
  normalizeVendorName,
  findById,
  findByNormalizedName,
  findManyByNames,
  getAllVendors,
  getUnverified,
  upsertVendorStatus,
  updateVendorById,
  getManualReviewVendors,
  recordVerificationAttempt,
  getAuditTrail,
};
