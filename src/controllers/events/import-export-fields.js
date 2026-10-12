const Category = require("../../models/categories");
const SubCategory = require("../../models/sub-categories");
const Deity = require("../../models/deities");
const GeneralLedger = require("../../models/general-ledgers");

/**
 * Column definitions for Event's Excel import/export. Excludes Slot Details
 * (isSlotRequired's per-slot date/time/seat table) — too complex to
 * represent in a flat row; every imported event starts with Slot Required
 * off and slots can be added afterwards from the Edit form, same scoping
 * decision as excluding Item/Service's extra Category pairings. Image is
 * excluded for the same reason as every other master's import.
 */
const fields = [
  { key: "code", header: "Code*", type: "string", required: true, unique: true, maxLength: 30, helpText: "Unique code (max 30 characters). Stored in uppercase." },
  { key: "name", header: "Name*", type: "string", required: true, unique: true, minLength: 1, maxLength: 150, helpText: "Event name (1–150 characters). Must be unique." },
  { key: "tamilName", header: "Tamil Name", type: "string", required: false, helpText: "Optional Tamil name." },
  { key: "description", header: "Description", type: "string", required: false, helpText: "Optional description." },
  { key: "category", header: "Category*", type: "ref", required: true, refModel: Category, refLabelField: "name", helpText: "Must exactly match one of the active Categories." },
  { key: "subCategory", header: "Sub Category", type: "ref", required: false, refModel: SubCategory, refLabelField: "name", helpText: "Optional — must exactly match one of the active Sub Categories." },
  { key: "deityMapping", header: "Deity Mapping", type: "ref", multi: true, required: false, refModel: Deity, refLabelField: "name", helpText: "Optional. One or more active Deity names, separated by commas." },
  { key: "startDate", header: "Start Date*", type: "date", required: true, helpText: "Event start date (e.g. 2026-01-15)." },
  { key: "endDate", header: "End Date*", type: "date", required: true, helpText: "Event end date — cannot be before the start date." },
  { key: "salePrice", header: "Sale Price*", type: "number", required: true, min: 0.01, helpText: "Selling price, greater than 0 (at least 0.01)." },
  { key: "generalLedger", header: "General Ledger*", type: "ref", required: true, refModel: GeneralLedger, refLabelField: "name", helpText: "Must exactly match one of the active General Ledger records. Its GST Type decides the GST." },
  { key: "displayOrder", header: "Display Order", type: "number", integer: true, min: 0, default: 1, helpText: "Lower numbers appear first. Leave blank for 1." },
  { key: "posVisibility", header: "POS Visibility", type: "boolean", default: true, helpText: "Yes/No — visible at the POS counter. Defaults to Yes." },
  { key: "publicVisibility", header: "Public Visibility", type: "boolean", default: true, helpText: "Yes/No — visible on the customer portal. Defaults to Yes." },
  { key: "adminBookingVisibility", header: "Admin Booking Visibility", type: "boolean", default: true, helpText: "Yes/No — visible on the Admin Panel booking screen. Defaults to Yes." },
];

/** Matches controllers/events/index.js's own assertDatesValid business rule — mongoose schema validation alone won't catch this. */
function validateRow(resolved, errors) {
  if (resolved.startDate && resolved.endDate && resolved.endDate < resolved.startDate) {
    errors.push("End Date cannot be before the Start Date.");
  }
}

function exportRow(doc) {
  return {
    code: doc.code,
    name: doc.name,
    tamilName: doc.tamilName,
    description: doc.description,
    category: doc.category?.name ?? "",
    subCategory: doc.subCategory?.name ?? "",
    deityMapping: (doc.deityMapping || []).map((d) => d?.name).filter(Boolean).join(", "),
    startDate: doc.startDate ? new Date(doc.startDate).toISOString().slice(0, 10) : "",
    endDate: doc.endDate ? new Date(doc.endDate).toISOString().slice(0, 10) : "",
    salePrice: doc.salePrice,
    generalLedger: doc.generalLedger?.name ?? "",
    displayOrder: doc.displayOrder,
    posVisibility: doc.posVisibility ? "Yes" : "No",
    publicVisibility: doc.publicVisibility ? "Yes" : "No",
    adminBookingVisibility: doc.adminBookingVisibility === false ? "No" : "Yes",
  };
}

const exportPopulate = [
  { path: "category", select: "name" },
  { path: "subCategory", select: "name" },
  { path: "deityMapping", select: "name" },
  { path: "generalLedger", select: "name" },
];

function sampleRows(refLookups) {
  const categoryName = refLookups.category?.docs?.[0]?.name ?? "Your Category Name";
  const glName = refLookups.generalLedger?.docs?.[0]?.name ?? "Your General Ledger Name";
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return [
    {
      code: "EVT01",
      name: "Annual Thiruvizha",
      tamilName: "",
      description: "",
      category: categoryName,
      subCategory: "",
      deityMapping: "",
      startDate: start,
      endDate: end,
      salePrice: 100,
      generalLedger: glName,
      displayOrder: 1,
      posVisibility: "Yes",
      publicVisibility: "Yes",
      adminBookingVisibility: "Yes",
    },
  ];
}

module.exports = { fields, validateRow, exportRow, exportPopulate, sampleRows };
