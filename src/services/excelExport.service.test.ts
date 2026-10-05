import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { writeLiveRoomsWorkbook } from "./excelExport.service";

// ExcelJS reopens elapsed-time number formats as Dates; recover the underlying day serial.
function serial(value: ExcelJS.CellValue): number {
  return value instanceof Date ? value.getTime() / 86_400_000 + 25_569 : Number(value);
}

describe("writeLiveRoomsWorkbook", () => {
  it("exports numeric elapsed durations while preserving IDs, seconds and metrics", async () => {
    const seconds = [502 * 3600 + 40 * 60, 25 * 3600 + 20 * 60 + 32, 32, 0];
    const rows = seconds.map((duration_seconds) => ({
      store_id: "7495637369664014736",
      room_id: "7582163856857006081",
      live_duration: "display label is not the numeric source",
      duration_seconds,
      cost: 1234.5,
    }));
    const output = await writeLiveRoomsWorkbook(rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Live Rooms")!;

    expect(sheet.rowCount).toBe(5);
    expect(sheet.columnCount).toBe(22);
    seconds.forEach((seconds, index) => {
      const row = sheet.getRow(index + 2);
      const duration = row.getCell(7);
      expect([ExcelJS.ValueType.Number, ExcelJS.ValueType.Date]).toContain(duration.type);
      expect(serial(duration.value)).toBeCloseTo(seconds / 86_400, 10);
      expect(duration.numFmt).toBe("[h]:mm:ss");
      expect(row.getCell(1).value).toBe("7495637369664014736");
      expect(row.getCell(3).value).toBe("7582163856857006081");
      expect(row.getCell(11).value).toBe(seconds);
      expect(row.getCell(12).value).toBe(1234.5);
    });
    const total = seconds.reduce((sum, _, index) => sum + serial(sheet.getCell(index + 2, 7).value), 0);
    expect(total * 86_400).toBeCloseTo(seconds.reduce((a, b) => a + b, 0), 5);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("keeps missing or invalid durations blank, including ongoing streams", async () => {
    const rows = [null, undefined, -1, NaN, Infinity, "1809600"].map((duration_seconds) => ({ duration_seconds }));
    const workbook = new ExcelJS.Workbook();
    const output = await writeLiveRoomsWorkbook(rows);
    await workbook.xlsx.load(output as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Live Rooms")!;
    rows.forEach((_, index) => expect(sheet.getCell(index + 2, 7).value).toBeNull());
  });
});
