const GeneralLedger = require("../../models/general-ledgers");
const Category = require("../../models/categories");
const SubCategory = require("../../models/sub-categories");
const Deity = require("../../models/deities");
const PrintingGroup = require("../../models/printing-groups");

/**
 * Column definitions for Service's Excel import/export — same shape as
 * Item's (see controllers/items/import-export-fields.js) minus the
 * inventory/unit fields Service doesn't have. Only the first Category/Sub
 * Category pairing is imported; add more from the Edit form afterwards.
 * Booking cut-off date and image are excluded, same reasoning as Item.
 */
const fields = [
  { key: "code", header: "Code*", type: "string", required: true, unique: true, maxLength: 30, helpText: "Unique code (max 30 characters). Stored in uppercase." },
  { key: "name", header: "Name*", type: "string", required: true, unique: true, minLength: 1, maxLength: 150, helpText: "Service name (1–150 characters). Must be unique." },
  { key: "tamilName", header: "Tamil Name", type: "string", required: false, helpText: "Optional Tamil name." },
  { key: "description", header: "Description", type: "string", required: false, helpText: "Optional description." },
  { key: "generalLedger", header: "General Ledger*", type: "ref", required: true, refModel: GeneralLedger, refLabelField: "name", helpText: "Must exactly match one of the active General Ledger records." },
  { key: "salePrice", header: "Sale Price*", type: "number", required: true, min: 0.01, helpText: "Selling price, greater than 0 (at least 0.01)." },
  { key: "category", header: "Category*", type: "ref", required: true, refModel: Category, refLabelField: "name", helpText: "Must exactly match one of the active Categories. Becomes this service's first Category/Sub Category pairing." },
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
  { key: "isFamilyMembersRequired", header: "Family Members Required", type: "boolean", default: false, helpText: "Yes/No — whether family member details are collected." },
  { key: "maxFamilyMembers", header: "Max Family Members", type: "number", integer: true, min: 1, default: 2, helpText: "Leave blank for 2." },
  { key: "isInventoryRequired", header: "Inventory Required", type: "boolean", default: false, helpText: "Yes/No — whether stock is tracked for this service." },
  { key: "thresholdCount", header: "Threshold Count", type: "number", integer: true, min: 1, default: 1, helpText: "Low-stock threshold, at least 1. Leave blank for 1." },
  { key: "isPosAvailable", header: "POS Availability", type: "boolean", default: true, helpText: "Yes/No — available at the POS counter. Defaults to Yes." },
  { key: "publicAvailability", header: "Public Availability", type: "boolean", default: true, helpText: "Yes/No — available on the customer portal. Defaults to Yes." },
  { key: "favorite", header: "Favorite", type: "boolean", default: false, helpText: "Yes/No — shown under the POS Portal's Favorites tab. Defaults to No." },
];

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
    categoryDetails: [{ category: resolved.category, subCategory: resolved.subCategory || null, displayOrder: 1 }],
    isFamilyMembersRequired: resolved.isFamilyMembersRequired,
    maxFamilyMembers: resolved.maxFamilyMembers,
    isInventoryRequired: resolved.isInventoryRequired,
    thresholdCount: resolved.thresholdCount,
    isPosAvailable: resolved.isPosAvailable,
    publicAvailability: resolved.publicAvailability,
    favorite: resolved.favorite,
  };
}

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
    isFamilyMembersRequired: doc.isFamilyMembersRequired ? "Yes" : "No",
    maxFamilyMembers: doc.maxFamilyMembers,
    isInventoryRequired: doc.isInventoryRequired ? "Yes" : "No",
    thresholdCount: doc.thresholdCount,
    isPosAvailable: doc.isPosAvailable ? "Yes" : "No",
    publicAvailability: doc.publicAvailability ? "Yes" : "No",
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
  const deityNames = (refLookups.deityMapping?.docs || []).slice(0, 2).map((d) => d.name);

  return [
    {
      code: "SVC01",
      name: "Ganapathy Homam",
      tamilName: "",
      description: "",
      generalLedger: glName,
      salePrice: 500,
      category: categoryName,
      subCategory: "",
      isDeityMappingRequired: deityNames.length ? "Yes" : "No",
      deityMapping: deityNames.slice(0, 1).join(", "),
      printingGroup: "",
      isFamilyMembersRequired: "Yes",
      maxFamilyMembers: 4,
      isInventoryRequired: "No",
      thresholdCount: 1,
      isPosAvailable: "Yes",
      publicAvailability: "Yes",
      favorite: "Yes",
    },
    {
      code: "SVC02",
      name: "Archana",
      tamilName: "",
      description: "",
      generalLedger: glName,
      salePrice: 20,
      category: categoryName,
      subCategory: "",
      isDeityMappingRequired: "No",
      deityMapping: "",
      printingGroup: printingGroupName,
      isFamilyMembersRequired: "No",
      maxFamilyMembers: 2,
      isInventoryRequired: "No",
      thresholdCount: 1,
      isPosAvailable: "Yes",
      publicAvailability: "Yes",
      favorite: "No",
    },
  ];
}

module.exports = { fields, mapToDoc, exportRow, exportPopulate, sampleRows };
