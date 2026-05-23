const express = require("express");
const mcaMsme1Controller = require("../controllers/mcaMsme1Controller");

const router = express.Router();

router.post("/mca/msme1/preview", mcaMsme1Controller.preview);
router.post("/mca/msme1/generate", mcaMsme1Controller.generate);
router.get("/mca/msme1/filings", mcaMsme1Controller.list);
router.get("/mca/msme1/filings/:id/download", mcaMsme1Controller.download);
router.post("/mca/msme1/filings/:id/srn", mcaMsme1Controller.recordSrn);
router.post("/mca/msme1/upload/start", mcaMsme1Controller.startUpload);

module.exports = router;
