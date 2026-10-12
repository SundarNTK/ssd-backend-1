const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadHallMedia, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const Hall = require("../../models/halls");
const HallPackage = require("../../models/hall-packages");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, mapToDoc, sampleRows } = require("./import-export-fields");

// Mounted at /hall-meal — see routes/index.js.
const router = express.Router();

const crud = makeCrudController(Hall, {
  searchFields: ["name", "code"],
  populate: ["category"],
  referencedBy: [{ model: HallPackage, field: "halls", label: "Hall Package" }],
});

router.get("/halls", requirePermission.any(["halls", "hall-bookings", "hall-availability"], "view"), crud.list);
// uploadHallMedia runs before validateBody — multer has to parse the
// multipart body (and stream both files to Cloudinary) before Joi
// validates the resulting req.body, same ordering categories/index.js uses.
router.post("/halls", requirePermission("halls", "fullAccess"), uploadHallMedia, hydrateMultipartBody, validateBody(createSchema), crud.create);
router.put("/halls/:id", requirePermission("halls", "edit"), uploadHallMedia, hydrateMultipartBody, validateBody(updateSchema), crud.update);
router.delete("/halls/:id", requirePermission("halls", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(Hall, {
  entityLabel: "Hall",
  sheetName: "Halls",
  fields: importExportFields,
  mapToDoc,
  sampleRows,
  extraDefaults: { status: 1, hallImages: [], floorPlan: null },
});

router.get("/halls/export", requirePermission("halls", "view"), importExport.exportList);
router.get("/halls/import/template", requirePermission("halls", "view"), importExport.downloadTemplate);
router.post("/halls/import/validate", requirePermission("halls", "fullAccess"), importExport.validateImport);
router.post("/halls/import/commit", requirePermission("halls", "fullAccess"), importExport.commitImport);

module.exports = router;
