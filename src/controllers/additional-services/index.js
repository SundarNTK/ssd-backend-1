const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadAdditionalServiceImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const AdditionalService = require("../../models/additional-services");
const HallPackage = require("../../models/hall-packages");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, sampleRows } = require("./import-export-fields");

// Mounted at /hall-meal — see routes/index.js.
const router = express.Router();

const crud = makeCrudController(AdditionalService, {
  searchFields: ["name", "code"],
  referencedBy: [{ model: HallPackage, field: "additionalServices", label: "Hall Package" }],
});

router.get("/additional-services", requirePermission.any(["additional-services", "hall-bookings", "hall-availability"], "view"), crud.list);
router.post("/additional-services", requirePermission("additional-services", "fullAccess"), uploadAdditionalServiceImage, hydrateMultipartBody, validateBody(createSchema), crud.create);
router.put("/additional-services/:id", requirePermission("additional-services", "edit"), uploadAdditionalServiceImage, hydrateMultipartBody, validateBody(updateSchema), crud.update);
router.delete("/additional-services/:id", requirePermission("additional-services", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(AdditionalService, {
  entityLabel: "Additional Service",
  sheetName: "Additional Services",
  fields: importExportFields,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/additional-services/export", requirePermission("additional-services", "view"), importExport.exportList);
router.get("/additional-services/import/template", requirePermission("additional-services", "view"), importExport.downloadTemplate);
router.post("/additional-services/import/validate", requirePermission("additional-services", "fullAccess"), importExport.validateImport);
router.post("/additional-services/import/commit", requirePermission("additional-services", "fullAccess"), importExport.commitImport);

module.exports = router;
