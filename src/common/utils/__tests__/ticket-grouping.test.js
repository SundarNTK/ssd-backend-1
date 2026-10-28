/**
 * Pure-function tests for ticket-grouping.js — no database, no mocks
 * needed. Covers the five scenarios the SSD Nets-Service print-splitting
 * spec calls out explicitly.
 */
const { resolveLineUnits, buildTicketGroups } = require("../ticket-grouping");

function deity(id, name, groupId, groupName) {
  return { _id: id, name, printingGroup: { _id: groupId, name: groupName } };
}

function line(name, code, overrides = {}) {
  return { name, code, quantity: 1, unitPrice: 10, lineTotal: 10, devotees: [{ name: "Devotee", nakshatra: "Rohini" }], ...overrides };
}

describe("resolveLineUnits", () => {
  test("deity-mapping-required line with one deity resolves one unit via the deity's print group", () => {
    const murugan = deity("d1", "Murugan", "gA", "Group A");
    const units = resolveLineUnits(line("Murugan Archana", "ARC-MUR"), { isDeityMappingRequired: true }, [murugan]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ isDeityBased: true, deityId: "d1", deityName: "Murugan", printGroupId: "gA", printGroupName: "Group A" });
  });

  test("deity-mapping-required line with multiple deities fans out into one unit per deity, splitting the line's total AND quantity evenly", () => {
    const murugan = deity("d1", "Murugan", "gA", "Group A");
    const vinayagar = deity("d2", "Vinayagar", "gB", "Group B");
    const units = resolveLineUnits(line("Combo Archana", "ARC-COMBO", { quantity: 2 }), { isDeityMappingRequired: true }, [murugan, vinayagar]);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.deityId)).toEqual(["d1", "d2"]);
    // The line's $10 total and quantity 2 are a single flat charge/count for
    // the whole line (see controllers/pos-orders' createOrder — neither is
    // ever multiplied by deity count), so each deity's own ticket must show
    // its even share of both, not the full line replicated onto both —
    // "Qty: 2, $5.00" on both tickets would itself be internally
    // inconsistent (2 units at $5 implies $10, not the $5 actually shown).
    expect(units[0].allocatedLineTotal).toBe(5);
    expect(units[1].allocatedLineTotal).toBe(5);
    expect(units[0].allocatedQuantity).toBe(1);
    expect(units[1].allocatedQuantity).toBe(1);
  });

  test("an unevenly-divisible quantity splits with the remainder going to the first deities in order", () => {
    const gods = [deity("d1", "A", "g", "G"), deity("d2", "B", "g", "G")];
    const units = resolveLineUnits(line("Combo", "COMBO", { quantity: 3 }), { isDeityMappingRequired: true }, gods);
    expect(units.map((u) => u.allocatedQuantity)).toEqual([2, 1]);
  });

  test("an unevenly-divisible line total splits to the cent, with the remainder going to the first deities in order", () => {
    const gods = [deity("d1", "A", "g", "G"), deity("d2", "B", "g", "G"), deity("d3", "C", "g", "G")];
    const units = resolveLineUnits(line("Triple Combo", "TRI", { lineTotal: 10 }), { isDeityMappingRequired: true }, gods);
    const amounts = units.map((u) => u.allocatedLineTotal);
    // $10 / 3 = $3.33 repeating — must still sum back to exactly $10, never
    // silently drift to $9.99 or $10.01.
    expect(amounts).toEqual([3.34, 3.33, 3.33]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 2);
  });

  test("a single deity on a line keeps the line's full total and quantity (no split needed)", () => {
    const units = resolveLineUnits(line("Murugan Archana", "ARC-MUR"), { isDeityMappingRequired: true }, [deity("d1", "Murugan", "gA", "Group A")]);
    expect(units[0].allocatedLineTotal).toBe(10);
    expect(units[0].allocatedQuantity).toBe(1);
  });

  test("non-deity line resolves one unit via the offering's own print group", () => {
    const offering = { isDeityMappingRequired: false, printingGroup: { _id: "gC", name: "Group C" } };
    const units = resolveLineUnits(line("Special Offering", "SPO"), offering, []);
    expect(units).toEqual([
      expect.objectContaining({ isDeityBased: false, deityId: null, printGroupId: "gC", printGroupName: "Group C" }),
    ]);
  });

  test("throws rather than silently dropping a line when a required deity is missing", () => {
    expect(() => resolveLineUnits(line("Archana", "ARC"), { isDeityMappingRequired: true }, [])).toThrow(/requires a deity/);
  });

  test("throws when a non-deity line has no configured print group", () => {
    expect(() => resolveLineUnits(line("Offering", "OFF"), { isDeityMappingRequired: false, printingGroup: null }, [])).toThrow(
      /no Print Group configured/
    );
  });

  test("throws when a mapped deity itself has no print group", () => {
    const orphanDeity = { _id: "d9", name: "Orphan", printingGroup: null };
    expect(() => resolveLineUnits(line("Archana", "ARC"), { isDeityMappingRequired: true }, [orphanDeity])).toThrow(
      /no Print Group configured/
    );
  });
});

describe("buildTicketGroups", () => {
  test("Test 1 — one deity, one print group -> one ticket", () => {
    const units = resolveLineUnits(line("Murugan Archana", "ARC-MUR"), { isDeityMappingRequired: true }, [deity("d1", "Murugan", "gA", "Group A")]);
    const tickets = buildTicketGroups(units, "PRINT_GROUP_WISE");
    expect(tickets).toHaveLength(1);
    expect(tickets[0].lines).toHaveLength(1);
  });

  test("Test 2 — three deities, all same print group, Print Group Wise -> one ticket", () => {
    const gA = (id, name) => deity(id, name, "gA", "Group A");
    const units = [
      ...resolveLineUnits(line("Murugan Archana", "M"), { isDeityMappingRequired: true }, [gA("d1", "Murugan")]),
      ...resolveLineUnits(line("Durga Archana", "D"), { isDeityMappingRequired: true }, [gA("d2", "Durga")]),
      ...resolveLineUnits(line("Vinayagar Archana", "V"), { isDeityMappingRequired: true }, [gA("d3", "Vinayagar")]),
    ];
    const tickets = buildTicketGroups(units, "PRINT_GROUP_WISE");
    expect(tickets).toHaveLength(1);
    expect(tickets[0].lines).toHaveLength(3);
    // Each deity is on its own separate $10 line here (single deity per
    // line, so no split applies) — the combined ticket's total must add
    // all three, not show just one line's amount.
    expect(tickets[0].total).toBe(30);
  });

  test("Test 3 — three deities, two print groups, Print Group Wise -> two tickets (Murugan+Durga combined, Vinayagar separate)", () => {
    const units = [
      ...resolveLineUnits(line("Murugan Archana", "M"), { isDeityMappingRequired: true }, [deity("d1", "Murugan", "gA", "Group A")]),
      ...resolveLineUnits(line("Durga Archana", "D"), { isDeityMappingRequired: true }, [deity("d2", "Durga", "gA", "Group A")]),
      ...resolveLineUnits(line("Vinayagar Archana", "V"), { isDeityMappingRequired: true }, [deity("d3", "Vinayagar", "gB", "Group B")]),
    ];
    const tickets = buildTicketGroups(units, "PRINT_GROUP_WISE");
    expect(tickets).toHaveLength(2);
    const groupA = tickets.find((t) => t.printGroupId === "gA");
    const groupB = tickets.find((t) => t.printGroupId === "gB");
    expect(groupA.lines.map((l) => l.deityName).sort()).toEqual(["Durga", "Murugan"]);
    expect(groupB.lines.map((l) => l.deityName)).toEqual(["Vinayagar"]);
  });

  test("Test 4 — three deities, two print groups, Deity Wise -> three tickets (one per deity)", () => {
    const units = [
      ...resolveLineUnits(line("Murugan Archana", "M"), { isDeityMappingRequired: true }, [deity("d1", "Murugan", "gA", "Group A")]),
      ...resolveLineUnits(line("Durga Archana", "D"), { isDeityMappingRequired: true }, [deity("d2", "Durga", "gA", "Group A")]),
      ...resolveLineUnits(line("Vinayagar Archana", "V"), { isDeityMappingRequired: true }, [deity("d3", "Vinayagar", "gB", "Group B")]),
    ];
    const tickets = buildTicketGroups(units, "DEITY_WISE");
    expect(tickets).toHaveLength(3);
    expect(tickets.map((t) => t.deityName).sort()).toEqual(["Durga", "Murugan", "Vinayagar"]);
  });

  test("Test 5 — mixed deity + non-deity offering, Print Group Wise: 3 deity tickets collapse per shared group, non-deity item keeps its own group", () => {
    const units = [
      ...resolveLineUnits(line("Murugan Archana", "M"), { isDeityMappingRequired: true }, [deity("d1", "Murugan", "gA", "Group A")]),
      ...resolveLineUnits(line("Durga Archana", "D"), { isDeityMappingRequired: true }, [deity("d2", "Durga", "gA", "Group A")]),
      ...resolveLineUnits(line("Vinayagar Archana", "V"), { isDeityMappingRequired: true }, [deity("d3", "Vinayagar", "gB", "Group B")]),
      ...resolveLineUnits(line("Special Offering", "SPO"), { isDeityMappingRequired: false, printingGroup: { _id: "gC", name: "Group C" } }, []),
    ];
    const groupWise = buildTicketGroups(units, "PRINT_GROUP_WISE");
    expect(groupWise).toHaveLength(3); // Group A (Murugan+Durga), Group B (Vinayagar), Group C (Special Offering)

    const deityWise = buildTicketGroups(units, "DEITY_WISE");
    // 3 deity tickets + 1 non-deity ticket, grouped by its own print group, never attached to a deity.
    expect(deityWise).toHaveLength(4);
    const nonDeityTicket = deityWise.find((t) => t.splitType === "GROUP");
    expect(nonDeityTicket.printGroupId).toBe("gC");
    expect(nonDeityTicket.lines[0].name).toBe("Special Offering");
  });

  test("devotees stay attached to their own line, not merged across a combined ticket", () => {
    const murugansDevotee = { name: "Arun", nakshatra: "Ardra" };
    const durgasDevotee = { name: "Anjali", nakshatra: "Rohini" };
    const units = [
      ...resolveLineUnits(line("Murugan Archana", "M", { devotees: [murugansDevotee] }), { isDeityMappingRequired: true }, [deity("d1", "Murugan", "gA", "Group A")]),
      ...resolveLineUnits(line("Durga Archana", "D", { devotees: [durgasDevotee] }), { isDeityMappingRequired: true }, [deity("d2", "Durga", "gA", "Group A")]),
    ];
    const tickets = buildTicketGroups(units, "PRINT_GROUP_WISE");
    expect(tickets).toHaveLength(1);
    const murugansLine = tickets[0].lines.find((l) => l.deityName === "Murugan");
    const durgasLine = tickets[0].lines.find((l) => l.deityName === "Durga");
    expect(murugansLine.devotees).toEqual([murugansDevotee]);
    expect(durgasLine.devotees).toEqual([durgasDevotee]);
  });
});

describe("service-wise ticket grouping", () => {
  test("one service over 4 deities: deities sharing a print group share a ticket, the other group gets its own", () => {
    const gods = [deity("d1", "A", "gA", "A"), deity("d2", "B", "gA", "A"), deity("d3", "C", "gA", "A"), deity("d4", "D", "gB", "B")];
    const svc = line("Archana", "ARC", { refType: "Service", quantity: 4, lineTotal: 4 });
    const units = resolveLineUnits(svc, { isDeityMappingRequired: true }, gods);
    const tickets = buildTicketGroups(units, "PRINT_GROUP_WISE");
    expect(tickets).toHaveLength(2);
    expect(tickets[0].lines.map((l) => l.deityName)).toEqual(["A", "B", "C"]);
    expect(tickets[1].lines.map((l) => l.deityName)).toEqual(["D"]);
  });

  test("two different services for the same print group still print separately", () => {
    const g = deity("d1", "A", "gA", "A");
    const units = [
      ...resolveLineUnits(line("S1", "S1", { refType: "Service" }), { isDeityMappingRequired: true }, [g]),
      ...resolveLineUnits(line("S2", "S2", { refType: "Service" }), { isDeityMappingRequired: true }, [g]),
    ];
    expect(buildTicketGroups(units, "PRINT_GROUP_WISE")).toHaveLength(2);
  });
});
