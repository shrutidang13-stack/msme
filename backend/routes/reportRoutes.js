const express = require("express");
const reportController = require("../controllers/reportController");

const router = express.Router();

router.get("/reports", reportController.listReports);
router.post("/reports/msme", reportController.createMSME);
router.get("/reports/:id", reportController.getReport);
router.get("/reports/:id/download.csv", reportController.downloadCsv);
router.get("/reports/:id/download.xml", reportController.downloadXml);
router.get("/reports/:id/evidence-bundle", reportController.evidenceBundle);
router.get("/reports/:id/tally-reconciliation", reportController.tallyReconciliation);

module.exports = router;
