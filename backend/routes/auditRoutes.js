const express = require("express");
const auditController = require("../controllers/auditController");

const router = express.Router();

router.post("/run-full-audit", auditController.runFullAudit);

module.exports = router;
