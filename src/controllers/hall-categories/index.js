const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadHallCategoryImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const HallCategory = require("../../models/hall-categories");
const Hall = require("../../models/halls");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, sampleRows } = require("./import-export-fields");

// Mounted at /hall-meal — see routes/index.js (authGuard + hallMealAccessOnly
// applied once for the whole /hall-meal group there).
const router = express.Router();

const crud = makeCrudController(HallCategory, {
  searchFields: ["name", "code"],
  referencedBy: [{ model: Hall, field: "category", label: "Hall" }],
});

router.get("/hall-categories", requirePermission.any(["hall-categories", "hall-bookings", "hall-availability"], "view"), crud.list);
router.post("/hall-categories", requirePermission("hall-categories", "fullAccess"), uploadHallCategoryImage, hydrateMultipartBody, validateBody(createSchema), crud.create);
router.put("/hall-categories/:id", requirePermission("hall-categories", "edit"), uploadHallCategoryImage, hydrateMultipartBody, validateBody(updateSchema), crud.update);
router.delete("/hall-categories/:id", requirePermission("hall-categories", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(HallCategory, {
  entityLabel: "Hall Category",
  sheetName: "Hall Categories",
  fields: importExportFields,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/hall-categories/export", requirePermission("hall-categories", "view"), importExport.exportList);
router.get("/hall-categories/import/template", requirePermission("hall-categories", "view"), importExport.downloadTemplate);
router.post("/hall-categories/import/validate", requirePermission("hall-categories", "fullAccess"), importExport.validateImport);
router.post("/hall-categories/import/commit", requirePermission("hall-categories", "fullAccess"), importExport.commitImport);

module.exports = router;
