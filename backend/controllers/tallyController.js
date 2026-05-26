const tallyService = require("../services/tally.service");
const tallyImportService = require("../services/tallyImport.service");
const importRepository = require("../repositories/importRepository");
const { actorFromUser } = require("../middleware/auth");

async function status(req, res, next) {
  try {
    res.json(await tallyService.checkStatus());
  } catch (error) {
    res.json({ online: false, tallyConnected: false, message: error.message });
  }
}

async function health(req, res, next) {
  try {
    res.json(await tallyService.tallyHealth({ companyName: req.query?.companyName }));
  } catch (error) {
    next(error);
  }
}

async function companyContext(req, res, next) {
  try {
    res.json(await tallyService.companyContextStatus({ companyName: req.query?.companyName }));
  } catch (error) {
    next(error);
  }
}

async function importTally(req, res, next) {
  try {
    const { periodType, fiscalYear, fromDate, toDate, asOn, companyName } = req.body || {};
    if (!fiscalYear || !fromDate || !toDate) {
      return res.status(400).json({ success: false, error: "fiscalYear, fromDate, and toDate are required" });
    }
    const result = await tallyImportService.importFromTally({
      fiscalYear,
      periodType,
      fromDate,
      toDate,
      asOn,
      companyName,
      actor: actorFromUser(req),
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function getDaybook(req, res, next) {
  try {
    const result = tallyImportService.getDaybook(req.params.id, req.query || {});
    if (!result) return res.status(404).json({ success: false, error: "Import run not found" });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

function statementHandler(type) {
  return (req, res, next) => {
    try {
      const result = tallyImportService.getStatement(req.params.id, type);
      if (!result) return res.status(404).json({ success: false, error: "Import run not found" });
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  };
}

async function getImport(req, res, next) {
  try {
    const result = tallyImportService.getImportRun(req.params.id);
    if (!result) return res.status(404).json({ success: false, error: "Import run not found" });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

async function getLedgerVouchers(req, res, next) {
  try {
    const result = tallyImportService.getLedgerVouchers(req.params.id, req.query || {});
    if (!result) return res.status(404).json({ success: false, error: "Import run not found" });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

async function listImports(req, res, next) {
  try {
    res.json({ success: true, imports: importRepository.listRuns() });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  status,
  health,
  companyContext,
  importTally,
  getImport,
  getLedgerVouchers,
  getDaybook,
  getTrialBalance: statementHandler("trial-balance"),
  getBalanceSheet: statementHandler("balance-sheet"),
  getProfitLoss: statementHandler("profit-loss"),
  listImports,
};
