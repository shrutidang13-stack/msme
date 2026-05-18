const express = require("express");
const reportController = require("../controllers/reportController");

const router = express.Router();

router.get("/reports", reportController.listReports);
router.post("/reports/msme", reportController.createMSME);
router.get("/reports/:id", reportController.getReport);
router.get("/reports/:id/download.csv", reportController.downloadCsv);
router.get("/reports/:id/download.xml", reportController.downloadXml);

module.exports = router;
