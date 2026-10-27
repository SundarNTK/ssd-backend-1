const express = require("express");
const ExcelJS = require("exceljs");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");

const ReportDefinition = require("../../models/report-definitions");
const { listReportSourcesForClient, getReportSource } = require("../../common/reports/report-sources");
const { runReport, runReportForExport, MAX_EXPORT_ROWS } = require("../../common/reports/report-runner");
const { runSchema, saveDefinitionSchema, updateDefinitionSchema } = require("./request-objects");
const { buildDailyCollection } = require("../../common/reports/daily-collection");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Same shape as common/factories/import-export-controller.js's own slug() — kept local
// since that one isn't exported for reuse. Filenames are built from the source's *label*
// ("Item/Service Sales Report" -> "item-service-sales-report"), not its internal `key`
// (sourceKey stays a stable identifier for saved report definitions and must not change
// just because the display label does).
const slug = (label) => label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/**
 * Every field key this request actually touches — selected columns, every
 * filter condition, the Group By key, every aggregated field, every sort
 * key — has to belong to the chosen source. Joi can only check shapes, not
 * "is this a real field of this specific source", so that cross-check
 * happens here, once, covering every place a field key can appear.
 */
function assertConfigBelongsToSource(sourceKey, { fields = [], conditions = [], grouping = null, sort = [] }) {
  const source = getReportSource(sourceKey); // throws a plain string for an unknown sourceKey
  const validKeys = new Set(source.fields.map((f) => f.key));

  const touched = [
    ...fields,
    ...conditions.map((c) => c.field),
    ...sort.map((s) => s.field),
    ...(grouping ? [grouping.groupBy, ...grouping.aggregations.map((a) => a.field).filter(Boolean)] : []),
  ];
  const unknown = touched.filter((k) => !validKeys.has(k));
  if (unknown.length > 0) {
    throw `"${source.label}" has no field(s): ${[...new Set(unknown)].join(", ")}.`;
  }
  return source;
}

// Not nested under /masters or /hall-meal (see routes/index.js) — authGuard
// and adminOnly are applied here directly, same as controllers/inventory.
// This router is mounted at "/reports" in routes/index.js, so every route
// below is declared RELATIVE to that (just "/sources", not "/reports/sources")
// — same convention controllers/inventory's own routes follow. The one
// route that predates this file's rewrite ("/health") already followed it
// by accident; every other route here originally baked "/reports" into its
// own path too, which — combined with the "/reports" mount prefix — made
// every one of them only reachable at "/reports/reports/...", a real bug
// (Express's final catch-all 404'd the correct, single-prefixed URL every
// admin screen and this comment both expect to work).
const router = express.Router();
router.use(authGuard, adminOnly);

// ---- GET /reports/sources — the catalog the report builder renders from ----
router.get("/sources", requirePermission("reports", "view"), (req, res) => {
  return responseHandler({ res, response: { sources: listReportSourcesForClient() } });
});

// ---- POST /reports/run — an ad-hoc report, not saved ----
router.post("/run", requirePermission("reports", "view"), validateBody(runSchema), async (req, res) => {
  try {
    assertConfigBelongsToSource(req.body.sourceKey, req.body);
    const result = await runReport({
      sourceKey: req.body.sourceKey,
      fieldKeys: req.body.fields,
      conditions: req.body.conditions,
      grouping: req.body.grouping,
      sort: req.body.sort,
      page: req.body.page,
      pageSize: req.body.pageSize,
    });
    return responseHandler({ res, response: result });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
});

// ---- GET /reports/export — downloads the current (ad-hoc or saved) report as .xlsx,
// or (?format=json) returns the same full, unpaginated row set as JSON for the Print view ----
// The whole run config (fields/conditions/grouping/sort) travels as one
// JSON query param — flattening a filter tree plus a grouping object into
// several flat query params gets unreadable fast, and this is a GET only
// because the browser's plain-link download flow needs one.
router.get("/export", requirePermission("reports", "view"), async (req, res) => {
  try {
    let config;
    try {
      config = JSON.parse(req.query.config || "{}");
    } catch {
      throw "Malformed export configuration.";
    }
    const { sourceKey, fields = [], conditions = [], grouping = null, sort = [] } = config;
    if (!sourceKey) throw "sourceKey is required.";

    const source = assertConfigBelongsToSource(sourceKey, { fields, conditions, grouping, sort });
    const { rows, columns, truncated } = await runReportForExport({ sourceKey, fieldKeys: fields, conditions, grouping, sort });

    if (req.query.format === "json") {
      return responseHandler({ res, response: { rows, columns, truncated } });
    }

    const workbook = new ExcelJS.Workbook();
    // Excel sheet names ban * ? : \ / [ ] and cap out at 31 chars — a source label like
    // "Item/Service Sales Report" crashes addWorksheet() unsanitized.
    const sheetName = source.label.replace(/[*?:\\/[\]]/g, "-").slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(16, c.label.length + 4) }));
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C1527" } };
    });

    rows.forEach((row) => {
      const flat = {};
      columns.forEach((c) => {
        const value = row[c.key];
        if (c.type === "date" && value) flat[c.key] = new Date(value).toISOString().slice(0, 10);
        else if (c.type === "boolean") flat[c.key] = value ? "Yes" : "No";
        else flat[c.key] = value ?? "";
      });
      sheet.addRow(flat);
    });

    if (truncated) {
      const note = sheet.addRow([`Showing the first ${MAX_EXPORT_ROWS.toLocaleString()} rows — narrow the filters to export the rest.`]);
      note.getCell(1).font = { italic: true, color: { argb: "FF7C1527" } };
    }

    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${slug(source.label)}-${Date.now()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
});

// ---- Saved report definitions — "My Reports" ----
// Scoped to the caller's own createdBy throughout (list/update/remove/run)
// — a saved report is personal, the same way a browser's own saved
// searches are; nobody can list, edit, or run another admin's by guessing
// its id.

router.get("/definitions", requirePermission("reports", "view"), async (req, res) => {
  try {
    const definitions = await ReportDefinition.find(
      ReportDefinition.notDeletedFilter({ createdBy: req.auth.userId })
    ).sort({ createdAt: -1 });
    return responseHandler({ res, response: { items: definitions } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
});

router.post(
  "/definitions",
  requirePermission("reports", "fullAccess"),
  validateBody(saveDefinitionSchema),
  async (req, res) => {
    try {
      assertConfigBelongsToSource(req.body.sourceKey, req.body);
      const doc = await ReportDefinition.create({ ...req.body, createdBy: req.auth.userId });
      return responseHandler({ res, response: doc, successMessage: "Report saved successfully.", statusCode: 201 });
    } catch (error) {
      if (error?.code === 11000) {
        return exceptionHandler({ res, error: "You already have a saved report with this name.", statusCode: 409 });
      }
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
    }
  }
);

router.put(
  "/definitions/:id",
  requirePermission("reports", "fullAccess"),
  validateBody(updateDefinitionSchema),
  async (req, res) => {
    try {
      const existing = await ReportDefinition.findOne(
        ReportDefinition.notDeletedFilter({ _id: req.params.id, createdBy: req.auth.userId })
      );
      if (!existing) throw "Report not found.";

      const merged = {
        sourceKey: req.body.sourceKey ?? existing.sourceKey,
        fields: req.body.fields ?? existing.fields,
        conditions: req.body.conditions ?? existing.conditions,
        grouping: req.body.grouping !== undefined ? req.body.grouping : existing.grouping,
        sort: req.body.sort ?? existing.sort,
      };
      assertConfigBelongsToSource(merged.sourceKey, merged);

      Object.assign(existing, req.body, { updatedBy: req.auth.userId });
      await existing.save();
      return responseHandler({ res, response: existing, successMessage: "Report updated successfully." });
    } catch (error) {
      if (error?.code === 11000) {
        return exceptionHandler({ res, error: "You already have a saved report with this name.", statusCode: 409 });
      }
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
    }
  }
);

router.delete("/definitions/:id", requirePermission("reports", "fullAccess"), async (req, res) => {
  try {
    const existing = await ReportDefinition.findOne(
      ReportDefinition.notDeletedFilter({ _id: req.params.id, createdBy: req.auth.userId })
    );
    if (!existing) throw "Report not found.";
    await existing.softDelete(req.auth.userId);
    return responseHandler({ res, successMessage: "Report deleted successfully." });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
});

router.post("/definitions/:id/run", requirePermission("reports", "view"), async (req, res) => {
  try {
    const definition = await ReportDefinition.findOne(
      ReportDefinition.notDeletedFilter({ _id: req.params.id, createdBy: req.auth.userId })
    );
    if (!definition) throw "Report not found.";

    const result = await runReport({
      sourceKey: definition.sourceKey,
      fieldKeys: definition.fields,
      conditions: definition.conditions,
      grouping: definition.grouping,
      sort: definition.sort,
      page: req.body?.page,
      pageSize: req.body?.pageSize,
    });
    return responseHandler({ res, response: result });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
});

// ---- GET /reports/daily-collection?from=&to= — collection totals per payment mode / source / cashier ----
router.get("/daily-collection", requirePermission("reports", "view"), async (req, res) => {
  try {
    const summary = await buildDailyCollection({ from: req.query.from, to: req.query.to });
    return responseHandler({ res, response: summary });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
});

// ---- GET /reports/daily-collection/export?from=&to= — the same summary as an .xlsx ----
router.get("/daily-collection/export", requirePermission("reports", "view"), async (req, res) => {
  try {
    const d = await buildDailyCollection({ from: req.query.from, to: req.query.to });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Collection Summary");
    const period = d.from === d.to ? d.from : `${d.from} to ${d.to}`;
    const money = "#,##0.00";
    sheet.columns = [{ width: 30 }, { width: 14 }, { width: 16 }, { width: 22 }, { width: 22 }];

    const title = sheet.addRow([`Daily Collection Summary - ${period}`]);
    title.font = { bold: true, size: 14, color: { argb: "FF7C1527" } };
    sheet.addRow([]);

    const section = (heading, labelHeader, rows, labelKey) => {
      const h = sheet.addRow([heading]);
      h.font = { bold: true, color: { argb: "FF7C1527" } };
      const head = sheet.addRow([labelHeader, "Payments", "Amount ($)", "Manually confirmed (count)", "Manually confirmed ($)"]);
      head.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C1527" } };
      });
      rows.forEach((r) => {
        const row = sheet.addRow([r[labelKey], r.count, r.total, r.manualCount, r.manualTotal]);
        row.getCell(3).numFmt = money;
        row.getCell(5).numFmt = money;
      });
      sheet.addRow([]);
    };

    section("By payment mode", "Payment mode", d.byMode, "mode");
    const totalRow = sheet.addRow(["GRAND TOTAL", d.grand.count, d.grand.total, d.grand.manualCount, d.grand.manualTotal]);
    totalRow.font = { bold: true };
    totalRow.getCell(3).numFmt = money;
    totalRow.getCell(5).numFmt = money;
    sheet.addRow([]);
    section("By source", "Source", d.bySource, "source");
    section("By cashier", "Processed by", d.byCashier, "cashier");

    const modeNames = d.byMode.map((m) => m.mode);
    const mh = sheet.addRow(["Source by payment mode ($)", ...modeNames]);
    mh.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C1527" } };
    });
    d.sourceModeMatrix.forEach((r) => {
      const row = sheet.addRow([r.source, ...modeNames.map((m) => r.modes[m] ?? 0)]);
      for (let i = 2; i <= modeNames.length + 1; i += 1) row.getCell(i).numFmt = money;
    });

    // Collection entered by the temple against what the bookings say.
    const rec = d.reconciliation;
    const label = { matched: "Matched", excess: "Excess", shortage: "Shortage", "not-entered": "Not entered" };
    sheet.addRow([]);
    const rh = sheet.addRow(["Collection entered vs system - by payment mode"]);
    rh.font = { bold: true, color: { argb: "FF7C1527" } };
    const rhead = sheet.addRow(["Payment mode", "System ($)", "Entered ($)", "Difference ($)", "Status"]);
    rhead.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C1527" } };
    });
    rec.byMode.forEach((m) => {
      const row = sheet.addRow([m.mode, m.comparedSystem, m.enteredTotal, m.difference, label[m.status] + (m.daysNotEntered ? ` (${m.daysNotEntered} day(s) not entered)` : "")]);
      [2, 3, 4].forEach((i) => (row.getCell(i).numFmt = money));
    });
    const rtotal = sheet.addRow(["TOTAL", rec.totals.comparedSystem, rec.totals.enteredTotal, rec.totals.difference, label[rec.totals.status]]);
    rtotal.font = { bold: true };
    [2, 3, 4].forEach((i) => (rtotal.getCell(i).numFmt = money));
    sheet.addRow([]);
    const dh = sheet.addRow(["Date", "Payment mode", "System ($)", "Entered ($)", "Difference ($)", "Status", "Remarks"]);
    dh.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C1527" } };
    });
    rec.rows.forEach((r) => {
      const row = sheet.addRow([r.date, r.mode, r.system, r.entered ?? "", r.difference ?? "", label[r.status], r.remarks]);
      [3, 4, 5].forEach((i) => (row.getCell(i).numFmt = money));
    });
    sheet.getColumn(6).width = 34;
    sheet.getColumn(7).width = 30;

    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="daily-collection-summary-${d.from}${d.from === d.to ? "" : `-to-${d.to}`}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
});

router.get("/health", (req, res) => res.json({ ok: true, service: "SSD-Backend", module: "reports" }));

module.exports = router;
