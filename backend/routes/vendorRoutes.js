const express = require("express");
const vendorController = require("../controllers/vendorController");

const router = express.Router();

router.get("/unverified", vendorController.unverified);
router.get("/manual-review", vendorController.manualReview);
router.post("/verify-udyam", vendorController.verifyUdyam);
router.post("/save-status", vendorController.saveStatus);
router.post("/:id/udyam-proof", vendorController.uploadUdyamProof);
router.post("/:id/udyam-approve", vendorController.approveUdyamProof);
router.post("/:id/udyam-reject", vendorController.rejectUdyamProof);
router.get("/master", vendorController.master);
router.get("/audit-trail", vendorController.auditTrail);

module.exports = router;
