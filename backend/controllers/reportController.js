const reportService = require("../services/report.service");
const { actorFromUser } = require("../middleware/auth");

async function createMSME(req, res, next) {
  try {
    const { importRunId, fiscalYear } = req.body || {};
    if (!importRunId) return res.status(400).json({ success: false, error: "importRunId is required" });
    const report = reportService.createMSMEReport({ importRunId, fiscalYear, actor: actorFromUser(req) });
    res.json({ success: true, report });
  } catch (error) {
    next(error);
  }
}

async function getReport(req, res, next) {
  try {
    const report = reportService.getReport(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: "Report not found" });
    res.json({ success: true, report });
  } catch (error) {
    next(error);
  }
}

async function listReports(req, res, next) {
  try {
    res.json({ success: true, reports: reportService.listReports() });
  } catch (error) {
    next(error);
  }
}

async function downloadCsv(req, res, next) {
  try {
    const report = reportService.getReport(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: "Report not found" });
    res.type("text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=MSME_Report_${report.id}.csv`);
    res.send(reportService.toCsv(report));
  } catch (error) {
    next(error);
  }
}

async function downloadXml(req, res, next) {
  try {
    const report = reportService.getReport(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: "Report not found" });
    res.type("application/xml");
    res.setHeader("Content-Disposition", `attachment; filename=MSME_Report_${report.id}.xml`);
    res.send(reportService.toXml(report));
  } catch (error) {
    next(error);
  }
}

module.exports = { createMSME, getReport, listReports, downloadCsv, downloadXml };
