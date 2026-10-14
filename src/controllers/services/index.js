const express = require("express");
const requireTicketImage = require("../../common/middleware/require-ticket-image");
const requireSessionCutoff = require("../../common/middleware/require-session-cutoff");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadServiceImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const Service = require("../../models/services");
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

const crud = makeCrudController(Service, { searchFields: ["name", "code", "tamilName"], populate: POPULATE, uniqueNames: "service" });

router.get("/services", requirePermission("services", "view"), crud.list);
router.post(
  "/services",
  requirePermission("services", "fullAccess"),
  uploadServiceImage,
  hydrateMultipartBody,
  validateBody(createSchema),
  requireTicketImage(Service),
  requireSessionCutoff(Service, "bookingCutoffDate"),
  crud.create
);
router.put(
  "/services/:id",
  requirePermission("services", "edit"),
  uploadServiceImage,
  hydrateMultipartBody,
  validateBody(updateSchema),
  requireTicketImage(Service),
  requireSessionCutoff(Service),
  crud.update
);
router.delete("/services/:id", requirePermission("services", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(Service, {
  entityLabel: "Service",
  sheetName: "Services",
  fields: importExportFields,
  mapToDoc,
  exportRow,
  exportPopulate,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/services/export", requirePermission("services", "view"), importExport.exportList);
router.get("/services/import/template", requirePermission("services", "view"), importExport.downloadTemplate);
router.post("/services/import/validate", requirePermission("services", "fullAccess"), importExport.validateImport);
router.post("/services/import/commit", requirePermission("services", "fullAccess"), importExport.commitImport);

module.exports = router;
