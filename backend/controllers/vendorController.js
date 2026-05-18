const vendorRepository = require("../repositories/vendorRepository");
const { verifyUdyamNumber } = require("../services/udyamVerifier.service");
const { actorFromUser } = require("../middleware/auth");

function actorFromRequest(req) {
  return actorFromUser(req);
}

async function master(req, res, next) {
  try {
    res.json({ success: true, vendors: await vendorRepository.getAllVendors() });
  } catch (error) {
    next(error);
  }
}

async function unverified(req, res, next) {
  try {
    const names = String(req.query.names || "")
      .split("|")
      .map((name) => name.trim())
      .filter(Boolean);
    res.json({ success: true, vendors: await vendorRepository.getUnverified(names) });
  } catch (error) {
    next(error);
  }
}

async function saveStatus(req, res, next) {
  try {
    const payload = req.body || {};
    if (!payload.vendorName) return res.status(400).json({ success: false, error: "vendorName is required" });
    if (payload.isMSME) {
      return res.status(400).json({
        success: false,
        error: "MSME vendors must be verified through /api/vendors/verify-udyam before they can enter reports.",
      });
    }
    const vendor = await vendorRepository.upsertVendorStatus(payload, actorFromRequest(req));
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
}

async function verifyUdyam(req, res, next) {
  try {
    const { vendorName, udyamNumber } = req.body || {};
    if (!vendorName) return res.status(400).json({ success: false, error: "vendorName is required" });
    if (!udyamNumber) return res.status(400).json({ success: false, error: "udyamNumber is required" });

    const verification = await verifyUdyamNumber(udyamNumber);
    const vendor = await vendorRepository.upsertVendorStatus(
      {
        vendorName,
        isMSME: verification.verified,
        udyamNumber: verification.udyamNumber,
        enterpriseName: verification.enterpriseName,
        enterpriseType: verification.enterpriseType,
        verificationStatus: verification.verified ? "verified" : verification.verificationStatus,
        udyamStatus: verification.verified ? "verified" : "manual_fallback_required",
        udyamRemarks: verification.verified ? "" : verification.error || "Udyam portal automation did not produce a certain verified result.",
        registrationValidity: verification.registrationValidity,
        registrationDate: verification.registrationDate,
        verifiedAt: verification.verifiedAt,
        lastVerifiedAt: new Date().toISOString(),
      },
      actorFromRequest(req),
      "udyam_verification"
    );
    vendorRepository.recordVerificationAttempt({
      vendorId: vendor.id,
      vendorName,
      udyamNumber: verification.udyamNumber,
      status: verification.verificationStatus,
      response: verification,
      screenshotPath: verification.screenshotPath,
      actor: actorFromRequest(req),
    });

    res.json({ success: true, verification, vendor });
  } catch (error) {
    next(error);
  }
}

async function uploadUdyamProof(req, res, next) {
  try {
    const { proofFileUrl, proofUrl, proofMetadata, remarks } = req.body || {};
    const proof = proofFileUrl || proofUrl || proofMetadata;
    if (!proof) return res.status(400).json({ success: false, error: "proofFileUrl, proofUrl, or proofMetadata is required" });
    const vendor = vendorRepository.updateVendorById(
      req.params.id,
      {
        udyamStatus: "pending_manual_review",
        udyamProofFileUrl: typeof proof === "string" ? proof : JSON.stringify(proof),
        udyamProofUploadedAt: new Date().toISOString(),
        udyamRemarks: remarks || "",
      },
      actorFromRequest(req),
      "udyam_proof_uploaded"
    );
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
}

async function approveUdyamProof(req, res, next) {
  try {
    const { remarks } = req.body || {};
    const actor = actorFromRequest(req);
    const vendor = vendorRepository.updateVendorById(
      req.params.id,
      {
        isMSME: true,
        verificationStatus: "verified",
        udyamStatus: "approved",
        udyamVerifiedBy: actor,
        udyamVerifiedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        udyamRemarks: remarks || "Udyam proof approved by CA/admin.",
      },
      actor,
      "udyam_proof_approved"
    );
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
}

async function rejectUdyamProof(req, res, next) {
  try {
    const { remarks } = req.body || {};
    const vendor = vendorRepository.updateVendorById(
      req.params.id,
      {
        isMSME: false,
        verificationStatus: "rejected",
        udyamStatus: "rejected",
        udyamRemarks: remarks || "Udyam proof rejected.",
      },
      actorFromRequest(req),
      "udyam_proof_rejected"
    );
    res.json({ success: true, vendor });
  } catch (error) {
    next(error);
  }
}

async function manualReview(req, res, next) {
  try {
    res.json({ success: true, vendors: vendorRepository.getManualReviewVendors() });
  } catch (error) {
    next(error);
  }
}

async function auditTrail(req, res, next) {
  try {
    res.json({ success: true, auditTrail: await vendorRepository.getAuditTrail() });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  master,
  unverified,
  saveStatus,
  verifyUdyam,
  uploadUdyamProof,
  approveUdyamProof,
  rejectUdyamProof,
  manualReview,
  auditTrail,
};
