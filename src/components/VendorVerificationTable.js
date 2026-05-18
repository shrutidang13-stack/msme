import { useMemo, useState } from "react";

const statusStyles = {
  verified: "bg-green-100 text-green-700",
  manual_confirmed: "bg-blue-100 text-blue-700",
  not_msme: "bg-gray-100 text-gray-700",
  failed: "bg-red-100 text-red-700",
  pending: "bg-yellow-100 text-yellow-700",
  manual_fallback_required: "bg-red-100 text-red-700",
  pending_manual_review: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

function statusLabel(vendor) {
  const status = vendor.vendorMaster?.udyamStatus || vendor.vendorMaster?.verificationStatus || "pending";
  if (status === "verified") return "Verified";
  if (status === "approved") return "Approved";
  if (status === "manual_fallback_required") return "Manual Fallback";
  if (status === "pending_manual_review") return "Proof Pending";
  if (status === "rejected") return "Rejected";
  if (status === "manual_confirmed") return "Manual Confirmed";
  if (status === "not_msme") return "Non-MSME";
  if (status === "failed") return "Failed";
  return "Pending";
}

export default function VendorVerificationTable({
  vendors,
  drafts,
  updateDraft,
  verifyingRows,
  onVerify,
  onSave,
  onBulkVerify,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const filteredVendors = useMemo(() => {
    const q = query.trim().toUpperCase();
    return vendors.filter((vendor) => {
      const status = vendor.vendorMaster?.udyamStatus || vendor.vendorMaster?.verificationStatus || "pending";
      const matchesFilter =
        filter === "all" ||
        (filter === "verified" && status === "verified") ||
        (filter === "pending" && (status === "pending" || !vendor.vendorMaster)) ||
        (filter === "non_msme" && status === "not_msme") ||
        (filter === "failed" && status === "failed");
      const matchesQuery = !q || vendor.name.toUpperCase().includes(q);
      return matchesFilter && matchesQuery;
    });
  }, [vendors, query, filter]);

  return (
    <div className="bg-white rounded-2xl p-6 shadow">
      <div className="flex justify-between items-start gap-3 flex-wrap mb-4">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Mandatory MSME/Udyam Verification</h3>
          <p className="text-sm text-gray-500 mt-1">
            MSME status comes only from stored master data, user confirmation, or verified Udyam registration.
          </p>
        </div>
        <button
          onClick={() => onBulkVerify(filteredVendors)}
          className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-800">
          Bulk Verify Entered Udyam
        </button>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          className="border rounded-lg px-3 py-2 text-sm min-w-64"
          placeholder="Search vendor"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="border rounded-lg px-3 py-2 text-sm"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All vendors</option>
          <option value="verified">Verified</option>
          <option value="pending">Pending</option>
          <option value="non_msme">Non-MSME</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      <div className="max-h-[34rem] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50">
            <tr>
              <th className="text-left p-2 text-gray-600">Vendor Name</th>
              <th className="text-left p-2 text-gray-600">MSME Registered?</th>
              <th className="text-left p-2 text-gray-600">Udyam Number</th>
              <th className="text-left p-2 text-gray-600">Enterprise Type</th>
              <th className="text-left p-2 text-gray-600">Verification Status</th>
              <th className="text-left p-2 text-gray-600">Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredVendors.map((vendor) => {
              const draft = drafts[vendor.name] || {};
              const status = vendor.vendorMaster?.udyamStatus || vendor.vendorMaster?.verificationStatus || "pending";
              const isMSME = draft.isMSME || (vendor.vendorMaster?.isMSME ? "yes" : vendor.vendorMaster?.verificationStatus === "not_msme" ? "no" : "");
              return (
                <tr key={vendor.name} className="border-t align-top">
                  <td className="p-2 font-semibold text-xs min-w-52">
                    {vendor.name}
                    {vendor.vendorMaster?.enterpriseName && (
                      <p className="text-gray-500 font-normal mt-1">{vendor.vendorMaster.enterpriseName}</p>
                    )}
                  </td>
                  <td className="p-2">
                    <select
                      className="border rounded p-2 text-xs"
                      value={isMSME}
                      onChange={(event) => updateDraft(vendor.name, { isMSME: event.target.value })}>
                      <option value="">Select</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </td>
                  <td className="p-2">
                    <input
                      className="border rounded p-2 text-xs w-44"
                      placeholder="UDYAM-XX-00-0000000"
                      value={draft.udyamNumber ?? vendor.vendorMaster?.udyamNumber ?? ""}
                      disabled={isMSME === "no"}
                      onChange={(event) => updateDraft(vendor.name, { udyamNumber: event.target.value.toUpperCase() })}
                    />
                  </td>
                  <td className="p-2">
                    <select
                      className="border rounded p-2 text-xs"
                      value={draft.enterpriseType ?? vendor.vendorMaster?.enterpriseType ?? "Micro"}
                      disabled={isMSME === "no"}
                      onChange={(event) => updateDraft(vendor.name, { enterpriseType: event.target.value })}>
                      <option value="Micro">Micro</option>
                      <option value="Small">Small</option>
                      <option value="Medium">Medium</option>
                    </select>
                  </td>
                  <td className="p-2">
                    <span className={`px-2 py-1 rounded-full text-xs font-bold ${statusStyles[status] || statusStyles.pending}`}>
                      {statusLabel(vendor)}
                    </span>
                    {vendor.vendorMaster?.lastVerifiedAt && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        {new Date(vendor.vendorMaster.lastVerifiedAt).toLocaleString("en-IN")}
                      </p>
                    )}
                  </td>
                  <td className="p-2">
                    <div className="flex gap-2 flex-wrap">
                      <button
                        disabled={verifyingRows[vendor.name] || isMSME !== "yes"}
                        onClick={() => onVerify(vendor)}
                        className="bg-blue-600 text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50">
                        {verifyingRows[vendor.name] ? "Verifying..." : "Verify"}
                      </button>
                      <button
                        onClick={() => onSave(vendor)}
                        className="bg-green-600 text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-green-700">
                        Save Status
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
