const GeneralLedger = require("../../models/general-ledgers");
const Category = require("../../models/categories");
const SubCategory = require("../../models/sub-categories");
const Deity = require("../../models/deities");
const PrintingGroup = require("../../models/printing-groups");
const Unit = require("../../models/units");

/**
 * Column definitions for Item's Excel import/export. Scoped to the fields
 * that map cleanly onto one flat spreadsheet row — every dropdown-backed
 * reference field (General Ledger, Category/Sub Category, Deity Mapping,
 * Printing Group, Unit of Measure) is included, matching the interlinked-
 * master pattern of Deity Master's own import. Deliberately excludes what a
 * single row can't represent sanely: multiple Category/Sub Category
 * pairings (only the first pairing is imported — see mapToDoc below; add
 * more from the regular Edit form afterwards), the future booking cut-off
 * date, and the item image (same reasoning as Deity's import — no sane way
 * to embed a Cloudinary upload in a spreadsheet cell).
 */
const fields = [
  { key: "code", header: "Code*", type: "string", required: true, unique: true, maxLength: 30, helpText: "Unique code (max 30 characters). Stored in uppercase." },
  { key: "name", header: "Name*", type: "string", required: true, unique: true, minLength: 1, maxLength: 150, helpText: "Item name (1–150 characters). Must be unique." },
  { key: "tamilName", header: "Tamil Name", type: "string", required: false, helpText: "Optional Tamil name." },
  { key: "description", header: "Description", type: "string", required: false, helpText: "Optional description." },
  { key: "generalLedger", header: "General Ledger*", type: "ref", required: true, refModel: GeneralLedger, refLabelField: "name", helpText: "Must exactly match one of the active General Ledger records." },
  { key: "salePrice", header: "Sale Price*", type: "number", required: true, min: 0.01, helpText: "Selling price, greater than 0 (at least 0.01)." },
  { key: "category", header: "Category*", type: "ref", required: true, refModel: Category, refLabelField: "name", helpText: "Must exactly match one of the active Categories. Becomes this item's first Category/Sub Category pairing — add more from the Edit form if needed." },
  { key: "subCategory", header: "Sub Category", type: "ref", required: false, refModel: SubCategory, refLabelField: "name", helpText: "Optional — must exactly match one of the active Sub Categories." },
  { key: "isDeityMappingRequired", header: "Deity Mapping Required", type: "boolean", default: false, helpText: "Yes/No. When Yes, Deity Mapping is required and Printing Group is taken from the deity instead." },
  {
    key: "deityMapping",
    header: "Deity Mapping",
    type: "ref",
    multi: true,
    refModel: Deity,
    refLabelField: "name",
    requiredIf: (r) => r.isDeityMappingRequired === true,
    helpText: "Required when Deity Mapping Required is Yes. One or more active Deity names, separated by commas.",
  },
  {
    key: "printingGroup",
    header: "Printing Group",
    type: "ref",
    refModel: PrintingGroup,
    refLabelField: "name",
    requiredIf: (r) => r.isDeityMappingRequired !== true,
    helpText: "Required when Deity Mapping Required is No. Must exactly match one of the active Printing Groups.",
  },
  { key: "isInventoryApplicable", header: "Inventory Applicable", type: "boolean", default: false, helpText: "Yes/No — whether stock is tracked for this item." },
  { key: "unitOfMeasure", header: "Unit of Measure", type: "ref", refModel: Unit, refLabelField: "unitName", storeAs: "label", helpText: "Must exactly match one of the active Unit master's Unit Name values (e.g. PCS, KG)." },
  { key: "threshold", header: "Threshold", type: "number", integer: true, min: 1, default: 1, helpText: "Low-stock threshold, at least 1. Leave blank for 1." },
  { key: "minQuantity", header: "Min Quantity", type: "number", integer: true, min: 1, default: 1, helpText: "Minimum bookable quantity. Leave blank for 1." },
  { key: "maxQuantity", header: "Max Quantity", type: "number", integer: true, min: 0, default: 0, helpText: "Maximum bookable quantity, 0 = unlimited. Leave blank for 0." },
  { key: "quantityReduction", header: "Quantity Reduction", type: "number", integer: true, min: 1, default: 1, helpText: "Stock reduced per booking unit. Leave blank for 1." },
  { key: "isFamilyMembersRequired", header: "Family Members Required", type: "boolean", default: false, helpText: "Yes/No — whether family member details are collected." },
  { key: "maxFamilyMembers", header: "Max Family Members", type: "number", integer: true, min: 1, default: 2, helpText: "Leave blank for 2." },
  { key: "posAvailability", header: "POS Availability", type: "boolean", default: true, helpText: "Yes/No — available at the POS counter. Defaults to Yes." },
  { key: "customerPortalAvailability", header: "Customer Portal Availability", type: "boolean", default: true, helpText: "Yes/No — available on the customer portal. Defaults to Yes." },
  { key: "favorite", header: "Favorite", type: "boolean", default: false, helpText: "Yes/No — shown under the POS Portal's Favorites tab. Defaults to No." },
];

/** Flattens the imported Category/Sub Category pair and Deity-Mapping conditional fields into Item's actual nested schema shape. */
function mapToDoc(resolved) {
  return {
    code: resolved.code,
    name: resolved.name,
    tamilName: resolved.tamilName,
    description: resolved.description,
    generalLedger: resolved.generalLedger,
    salePrice: resolved.salePrice,
    isDeityMappingRequired: resolved.isDeityMappingRequired,
    deityMapping: resolved.isDeityMappingRequired ? resolved.deityMapping || [] : [],
    printingGroup: resolved.isDeityMappingRequired ? null : resolved.printingGroup ?? null,
    categoryDetails: [{ category: resolved.category, subCategory: resolved.subCategory || null, displayOrder: 0 }],
    isInventoryApplicable: resolved.isInventoryApplicable,
    unitOfMeasure: resolved.isInventoryApplicable ? resolved.unitOfMeasure || null : null,
    threshold: resolved.threshold,
    minQuantity: resolved.minQuantity,
    maxQuantity: resolved.maxQuantity,
    quantityReduction: resolved.quantityReduction,
    isFamilyMembersRequired: resolved.isFamilyMembersRequired,
    maxFamilyMembers: resolved.maxFamilyMembers,
    posAvailability: resolved.posAvailability,
    customerPortalAvailability: resolved.customerPortalAvailability,
    favorite: resolved.favorite,
  };
}

/** Reverses mapToDoc for the export sheet — Item's populated doc has categoryDetails as an array, not flat category/subCategory columns. */
function exportRow(doc) {
  const firstPair = doc.categoryDetails?.[0];
  return {
    code: doc.code,
    name: doc.name,
    tamilName: doc.tamilName,
    description: doc.description,
    generalLedger: doc.generalLedger?.name ?? "",
    salePrice: doc.salePrice,
    category: firstPair?.category?.name ?? "",
    subCategory: firstPair?.subCategory?.name ?? "",
    isDeityMappingRequired: doc.isDeityMappingRequired ? "Yes" : "No",
    deityMapping: (doc.deityMapping || []).map((d) => d?.name).filter(Boolean).join(", "),
    printingGroup: doc.printingGroup?.name ?? "",
    isInventoryApplicable: doc.isInventoryApplicable ? "Yes" : "No",
    unitOfMeasure: doc.unitOfMeasure ?? "",
    threshold: doc.threshold,
    minQuantity: doc.minQuantity,
    maxQuantity: doc.maxQuantity,
    quantityReduction: doc.quantityReduction,
    isFamilyMembersRequired: doc.isFamilyMembersRequired ? "Yes" : "No",
    maxFamilyMembers: doc.maxFamilyMembers,
    posAvailability: doc.posAvailability ? "Yes" : "No",
    customerPortalAvailability: doc.customerPortalAvailability ? "Yes" : "No",
    favorite: doc.favorite ? "Yes" : "No",
  };
}

const exportPopulate = [
  { path: "generalLedger", select: "name" },
  { path: "printingGroup", select: "name" },
  { path: "deityMapping", select: "name" },
  { path: "categoryDetails.category", select: "name" },
  { path: "categoryDetails.subCategory", select: "name" },
];

function sampleRows(refLookups) {
  const glName = refLookups.generalLedger?.docs?.[0]?.name ?? "Your General Ledger Name";
  const categoryName = refLookups.category?.docs?.[0]?.name ?? "Your Category Name";
  const printingGroupName = refLookups.printingGroup?.docs?.[0]?.name ?? "Your Printing Group Name";
  const unitName = refLookups.unitOfMeasure?.docs?.[0]?.label ?? refLookups.unitOfMeasure?.docs?.[0]?.unitName ?? "PCS";
  const deityNames = (refLookups.deityMapping?.docs || []).slice(0, 2).map((d) => d.name);

  return [
    {
      code: "ITM01",
      name: "Coconut",
      tamilName: "தேங்காய்",
      description: "",
      generalLedger: glName,
      salePrice: 15,
      category: categoryName,
      subCategory: "",
      isDeityMappingRequired: "No",
      deityMapping: "",
      printingGroup: printingGroupName,
      isInventoryApplicable: "Yes",
      unitOfMeasure: unitName,
      threshold: 10,
      minQuantity: 1,
      maxQuantity: 0,
      quantityReduction: 1,
      isFamilyMembersRequired: "No",
      maxFamilyMembers: 2,
      posAvailability: "Yes",
      customerPortalAvailability: "Yes",
      favorite: "Yes",
    },
    {
      code: "ITM02",
      name: "Archana Basket",
      tamilName: "",
      description: "",
      generalLedger: glName,
      salePrice: 50,
      category: categoryName,
      subCategory: "",
      isDeityMappingRequired: deityNames.length ? "Yes" : "No",
      deityMapping: deityNames.join(", "),
      printingGroup: "",
      isInventoryApplicable: "No",
      unitOfMeasure: "",
      threshold: 1,
      minQuantity: 1,
      maxQuantity: 0,
      quantityReduction: 1,
      isFamilyMembersRequired: "No",
      maxFamilyMembers: 2,
      posAvailability: "Yes",
      customerPortalAvailability: "Yes",
      favorite: "No",
    },
  ];
}

module.exports = { fields, mapToDoc, exportRow, exportPopulate, sampleRows };
