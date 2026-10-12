const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadFoodMenuItemImage, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");

const FoodMenuItem = require("../../models/food-menu-items");
const FoodPackage = require("../../models/food-packages");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, sampleRows } = require("./import-export-fields");

// Mounted at /hall-meal — see routes/index.js.
const router = express.Router();

const crud = makeCrudController(FoodMenuItem, {
  searchFields: ["name", "itemCategory"],
  referencedBy: [{ model: FoodPackage, field: "menuItems.menuItem", label: "Food Package" }],
});

router.get("/food-menu-items", requirePermission.any(["food-menu-items", "hall-bookings", "hall-availability"], "view"), crud.list);
router.post("/food-menu-items", requirePermission("food-menu-items", "fullAccess"), uploadFoodMenuItemImage, hydrateMultipartBody, validateBody(createSchema), crud.create);
router.put("/food-menu-items/:id", requirePermission("food-menu-items", "edit"), uploadFoodMenuItemImage, hydrateMultipartBody, validateBody(updateSchema), crud.update);
router.delete("/food-menu-items/:id", requirePermission("food-menu-items", "fullAccess"), crud.remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(FoodMenuItem, {
  entityLabel: "Food Menu Item",
  sheetName: "Food Menu Items",
  fields: importExportFields,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/food-menu-items/export", requirePermission("food-menu-items", "view"), importExport.exportList);
router.get("/food-menu-items/import/template", requirePermission("food-menu-items", "view"), importExport.downloadTemplate);
router.post("/food-menu-items/import/validate", requirePermission("food-menu-items", "fullAccess"), importExport.validateImport);
router.post("/food-menu-items/import/commit", requirePermission("food-menu-items", "fullAccess"), importExport.commitImport);

module.exports = router;
