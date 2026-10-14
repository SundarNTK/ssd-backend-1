const express = require("express");
const requireTicketImage = require("../../common/middleware/require-ticket-image");
const requireSessionCutoff = require("../../common/middleware/require-session-cutoff");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadItemImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const Item = require("../../models/items");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, mapToDoc, exportRow, exportPopulate, sampleRows } = require("./import-export-fields");

const POPULATE = [
  { path: "generalLedger", select: "name code" },
  { path: "printingGroup", select: "name" },
  {
    path: "deityMapping",
    select: "name printingGroup",
    // Admin-assigned display order (ties alphabetical) — see
    // models/deities' displayOrder field.
    options: { sort: { displayOrder: 1, name: 1 } },
    populate: { path: "printingGroup", select: "name" },
  },
  { path: "categoryDetails.category", select: "name color" },
  { path: "categoryDetails.subCategory", select: "name color" },
];

// Mounted at /masters — see routes/index.js (authGuard/adminOnly now applied
// once for the whole /masters group there, not per master).
const router = express.Router();

const crud = makeCrudController(Item, { searchFields: ["name", "code", "tamilName"], populate: POPULATE, uniqueNames: "item" });

router.get("/items", requirePermission("items", "view"), crud.list);
router.post(
  "/items",
  requirePermission("items", "fullAccess"),
  uploadItemImage,
  hydrateMultipartBody,
  validateBody(createSchema),
  requireTicketImage(Item),
  requireSessionCutoff(Item, "futureBookingCutOffDate"),
  crud.create
);
router.put(
  "/items/:id",
  requirePermission("items", "edit"),
  uploadItemImage,
  hydrateMultipartBody,
  validateBody(updateSchema),
  requireTicketImage(Item),
  requireSessionCutoff(Item),
  crud.update
);
router.delete("/items/:id", requirePermission("items", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(Item, {
  entityLabel: "Item",
  sheetName: "Items",
  fields: importExportFields,
  mapToDoc,
  exportRow,
  exportPopulate,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/items/export", requirePermission("items", "view"), importExport.exportList);
router.get("/items/import/template", requirePermission("items", "view"), importExport.downloadTemplate);
router.post("/items/import/validate", requirePermission("items", "fullAccess"), importExport.validateImport);
router.post("/items/import/commit", requirePermission("items", "fullAccess"), importExport.commitImport);

module.exports = router;
