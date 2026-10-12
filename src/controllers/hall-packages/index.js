const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadHallPackageImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const HallPackage = require("../../models/hall-packages");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, mapToDoc, exportRow, exportPopulate, sampleRows } = require("./import-export-fields");

// Mounted at /hall-meal — see routes/index.js. Nothing references a Hall
// Package yet (Hall Booking will, in Phase 2), so no `referencedBy` guard
// is needed here.
const router = express.Router();

const crud = makeCrudController(HallPackage, {
  searchFields: ["name"],
  populate: ["hallPurpose", "halls", "additionalServices"],
});

router.get("/hall-packages", requirePermission.any(["hall-packages", "hall-bookings", "hall-availability"], "view"), crud.list);
router.post("/hall-packages", requirePermission("hall-packages", "fullAccess"), uploadHallPackageImage, hydrateMultipartBody, validateBody(createSchema), crud.create);
router.put("/hall-packages/:id", requirePermission("hall-packages", "edit"), uploadHallPackageImage, hydrateMultipartBody, validateBody(updateSchema), crud.update);
router.delete("/hall-packages/:id", requirePermission("hall-packages", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(HallPackage, {
  entityLabel: "Hall Package",
  sheetName: "Hall Packages",
  fields: importExportFields,
  mapToDoc,
  exportRow,
  exportPopulate,
  sampleRows,
  extraDefaults: { status: 1, image: null, termsAndConditions: "" },
});

router.get("/hall-packages/export", requirePermission("hall-packages", "view"), importExport.exportList);
router.get("/hall-packages/import/template", requirePermission("hall-packages", "view"), importExport.downloadTemplate);
router.post("/hall-packages/import/validate", requirePermission("hall-packages", "fullAccess"), importExport.validateImport);
router.post("/hall-packages/import/commit", requirePermission("hall-packages", "fullAccess"), importExport.commitImport);

module.exports = router;
