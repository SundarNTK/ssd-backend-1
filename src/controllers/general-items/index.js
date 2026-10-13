const express = require("express");
const requireTicketImage = require("../../common/middleware/require-ticket-image");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadGeneralItemImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const GeneralItem = require("../../models/general-items");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, mapToDoc, exportRow, exportPopulate, sampleRows } = require("./import-export-fields");

const POPULATE = [
  { path: "generalLedger", select: "name code" },
  { path: "printingGroup", select: "name" },
  { path: "categoryDetails.category", select: "name color" },
  { path: "categoryDetails.subCategory", select: "name color" },
];

// Mounted at /masters — see routes/index.js (authGuard/adminOnly applied
// once for the whole /masters group there).
const router = express.Router();

const crud = makeCrudController(GeneralItem, { searchFields: ["name", "code", "tamilName"], populate: POPULATE });

router.get("/general-items", requirePermission("general-items", "view"), crud.list);
router.post(
  "/general-items",
  requirePermission("general-items", "fullAccess"),
  uploadGeneralItemImage,
  hydrateMultipartBody,
  validateBody(createSchema),
  requireTicketImage(GeneralItem),
  crud.create
);
router.put(
  "/general-items/:id",
  requirePermission("general-items", "edit"),
  uploadGeneralItemImage,
  hydrateMultipartBody,
  validateBody(updateSchema),
  requireTicketImage(GeneralItem),
  crud.update
);
router.delete("/general-items/:id", requirePermission("general-items", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(GeneralItem, {
  entityLabel: "General Item",
  sheetName: "General Items",
  fields: importExportFields,
  mapToDoc,
  exportRow,
  exportPopulate,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/general-items/export", requirePermission("general-items", "view"), importExport.exportList);
router.get("/general-items/import/template", requirePermission("general-items", "view"), importExport.downloadTemplate);
router.post("/general-items/import/validate", requirePermission("general-items", "fullAccess"), importExport.validateImport);
router.post("/general-items/import/commit", requirePermission("general-items", "fullAccess"), importExport.commitImport);

module.exports = router;
