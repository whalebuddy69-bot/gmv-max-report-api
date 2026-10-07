import express, { ErrorRequestHandler } from "express";
import { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { completeStatusCounts } from "../services/creativeDeliveryStatus";
import { AppError } from "../utils/errors";

const creativesMock = vi.fn();
vi.mock("../services/analytics.service", () => ({ creatives: (...args: unknown[]) => creativesMock(...args) }));
vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../services/excelExport.service", () => ({}));
vi.mock("../services/storeAuthorization.service", () => ({}));
vi.mock("../services/webOAuth.service", () => ({}));
vi.mock("../services/videoMetadata.service", () => ({}));
vi.mock("../db/dataSource", () => ({}));

import { analyticsRouter } from "./analytics.route";

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  app.use("/analytics", analyticsRouter);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof AppError ? error.httpStatus : 500).json({ error: error.message });
  };
  app.use(errors);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/analytics/creatives?from=2026-10-01&to=2026-10-03`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  creativesMock.mockReset();
  creativesMock.mockResolvedValue({ rows: [{ item_id: "1", creative_delivery_status: "LEARNING" }], total: 1, statusCounts: completeStatusCounts({ LEARNING: 1, IN_QUEUE: 3 }) });
});

describe("GET /analytics/creatives delivery status", () => {
  it("passes the selected status to the service and returns complete counts in the existing response", async () => {
    const response = await fetch(`${baseUrl}&storeId=shop&deliveryStatus=LEARNING&limit=1&offset=2`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      creatives: [{ item_id: "1", creative_delivery_status: "LEARNING" }], total: 1,
      statusCounts: completeStatusCounts({ LEARNING: 1, IN_QUEUE: 3 }), limit: 1, offset: 2,
    });
    expect(creativesMock).toHaveBeenCalledWith(expect.objectContaining({ storeIds: ["shop"], deliveryStatus: "LEARNING" }), undefined, "DESC", 1, 2);
  });

  it("keeps requests without a delivery status backwards compatible", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(creativesMock).toHaveBeenCalledWith(expect.objectContaining({ deliveryStatus: undefined }), undefined, "DESC", 100, 0);
  });

  it.each(["deliveryStatus=FAKE", "deliveryStatus=", "deliveryStatus=LEARNING&deliveryStatus=DELIVERING", "deliveryStatus=DELIVERING%27%20OR%201%3D1%3B%20--"])("rejects %s with 400 before querying data", async (query) => {
    const response = await fetch(`${baseUrl}&${query}`);
    expect(response.status).toBe(400);
    expect(creativesMock).not.toHaveBeenCalled();
  });
});
