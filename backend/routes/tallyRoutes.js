const express = require("express");
const tallyController = require("../controllers/tallyController");

const router = express.Router();

router.get("/status", tallyController.status);
router.get("/tally/health", tallyController.health);
router.get("/tally/company-context", tallyController.companyContext);
router.post("/tally/import", tallyController.importTally);
router.get("/tally/imports", tallyController.listImports);
router.get("/tally/imports/:id/ledger-vouchers", tallyController.getLedgerVouchers);
router.get("/tally/imports/:id", tallyController.getImport);

module.exports = router;
