import { useMemo, useState } from "react";
import { saveVendorStatus, verifyUdyam } from "../services/api";

const emptyDraft = {
  isMSME: "",
  udyamNumber: "",
  enterpriseType: "Micro",
  verificationStatus: "pending",
};

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\bPRIVATE\s+LIMITED\b/g, " ")
    .replace(/\bPVT\.?\s*LTD\.?\b/g, " ")
    .replace(/\bLIMITED\b/g, " ")
    .replace(/\bLTD\.?\b/g, " ")
    .replace(/\bLLP\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function useVendorVerification() {
  const [drafts, setDrafts] = useState({});
  const [verifyingRows, setVerifyingRows] = useState({});

  const updateDraft = (vendorName, patch) => {
    setDrafts((prev) => ({
      ...prev,
      [vendorName]: { ...(prev[vendorName] || emptyDraft), ...patch },
    }));
  };

  const mergeMasterIntoVendors = (creditors) =>
    creditors.map((creditor) => {
      const master = creditor.vendorMaster;
      return {
        name: creditor.party,
        normalizedVendorName: creditor.normalizedVendorName || normalizeName(creditor.party),
        outstandingAmount: creditor.outstandingAmount,
        daysOutstanding: creditor.daysOutstanding,
        bucket: creditor.bucket,
        delayed: creditor.delayed,
        interestLiability: creditor.interestLiability,
        disallowanceAmount: creditor.disallowanceAmount,
        oldestInvoiceDate: creditor.oldestInvoiceDate,
        vendorMaster: master,
      };
    });

  const saveManualStatus = async (vendor, draft) => {
    if (draft.isMSME === "yes") {
      throw new Error("For MSME vendors, enter the Udyam number and use Verify. Manual save is allowed only for Non-MSME confirmation.");
    }
    if (draft.isMSME !== "no") {
      throw new Error("Select No before saving a vendor as Non-MSME.");
    }
    const response = await saveVendorStatus(
      {
        vendorName: vendor.name,
        isMSME: false,
        udyamNumber: draft.udyamNumber || "",
        enterpriseType: "",
        verificationStatus: "not_msme",
      },
    );
    return response.vendor;
  };

  const verifyVendor = async (vendor, draft) => {
    if (!draft.udyamNumber?.trim()) throw new Error("Enter Udyam number before verification.");
    setVerifyingRows((prev) => ({ ...prev, [vendor.name]: true }));
    try {
      const response = await verifyUdyam(
        { vendorName: vendor.name, udyamNumber: draft.udyamNumber },
      );
      return response.vendor;
    } finally {
      setVerifyingRows((prev) => ({ ...prev, [vendor.name]: false }));
    }
  };

  const bulkVerify = async (vendors, onVerified) => {
    for (const vendor of vendors) {
      const draft = drafts[vendor.name] || emptyDraft;
      if (draft.isMSME !== "yes" || !draft.udyamNumber) continue;
      const updated = await verifyVendor(vendor, draft);
      onVerified(vendor.name, updated);
    }
  };

  const statsFor = useMemo(
    () => (vendors) => {
      const total = vendors.length;
      const verifiedMSME = vendors.filter((v) =>
        v.vendorMaster?.isMSME &&
        ["verified", "approved"].includes(v.vendorMaster?.udyamStatus)
      ).length;
      const nonMSME = vendors.filter((v) => v.vendorMaster?.verificationStatus === "not_msme").length;
      const failedVerification = vendors.filter((v) =>
        ["failed", "manual_fallback_required", "pending_manual_review", "rejected", "invalid_format", "not_verified"].includes(v.vendorMaster?.udyamStatus || v.vendorMaster?.verificationStatus)
      ).length;
      const pendingVerification = total - verifiedMSME - nonMSME - failedVerification;
      return { total, verifiedMSME, pendingVerification, nonMSME, failedVerification };
    },
    []
  );

  return {
    drafts,
    updateDraft,
    verifyingRows,
    mergeMasterIntoVendors,
    saveManualStatus,
    verifyVendor,
    bulkVerify,
    statsFor,
  };
}
