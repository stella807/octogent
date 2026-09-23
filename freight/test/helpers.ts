import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { SqliteStore } from "../src/adapters/sqlite-store.ts";
import { emptyStats } from "../src/adapters/sqlite-store.ts";
import type { MatchInput } from "../src/domain/matching.ts";
import type { Shipment, SupplierProfile } from "../src/domain/types.ts";
import type { Company } from "../src/domain/types.ts";
import { createServer } from "../src/http/server.ts";

// biome-ignore lint/suspicious/noExplicitAny: a test client reads whatever shape the API returns
type ApiJson = any;

/** A signed-in browser: keeps the session cookie and echoes the CSRF token. */
export class Client {
  private cookies = new Map<string, string>();
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: ApiJson }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookieHeader) headers.cookie = cookieHeader;
    const csrf = this.cookies.get("fm_csrf");
    if (csrf) headers["x-fm-csrf"] = decodeURIComponent(csrf);

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [name, value] = (pair as string).split("=");
      if (!name) continue;
      if (value === "" || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value as string);
    }
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  get = (path: string) => this.request("GET", path);
  post = (path: string, body?: unknown) => this.request("POST", path, body ?? {});
  put = (path: string, body?: unknown) => this.request("PUT", path, body ?? {});
  /** Deliberately omits the CSRF header, for the negative test. */
  async postWithoutCsrf(path: string, body: unknown): Promise<{ status: number; json: ApiJson }> {
    const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }
}

export type Harness = {
  base: string;
  store: SqliteStore;
  client: () => Client;
  close: () => Promise<void>;
};

export async function startHarness(): Promise<Harness> {
  const store = new SqliteStore(":memory:");
  const server = createServer({ store, secureCookies: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    store,
    client: () => new Client(base),
    close: async () => {
      server.close();
      await once(server, "close");
      store.close();
    },
  };
}

export const shipperRegistration = (email: string) => ({
  email,
  password: "a-long-enough-password",
  name: "Dana Ops",
  companyName: "Acme Foods",
  companyKind: "shipper",
  contactPhone: "305-555-0100",
  companyCity: "Miami",
  companyRegion: "FL",
  companyCountry: "US",
});

export const supplierRegistration = (email: string, name = "Caribe Carriers") => ({
  email,
  password: "a-long-enough-password",
  name: "Sam Dispatch",
  companyName: name,
  companyKind: "supplier",
  contactPhone: "787-555-0110",
  companyCity: "San Juan",
  companyRegion: "PR",
  companyCountry: "US",
  mcNumber: "MC-123456",
});

export const supplierProfile = (overrides: Partial<SupplierProfile> = {}) => ({
  equipment: ["dry_van", "reefer"],
  cargoTypes: ["general_palletized", "refrigerated_food"],
  serviceRegions: ["US-FL", "US-PR"],
  lanes: [{ origin: "US-FL", destination: "US-PR" }],
  capabilities: ["port_drayage"],
  blackoutDates: [],
  maxWeightLbs: 44000,
  ratePerMile: 2.1,
  notes: "Weekly Jacksonville–San Juan sailings",
  ...overrides,
});

export const shipmentPayload = (overrides: Record<string, unknown> = {}) => ({
  originCity: "Miami",
  originRegion: "FL",
  originCountry: "US",
  destinationCity: "San Juan",
  destinationRegion: "PR",
  destinationCountry: "US",
  pickupFrom: "2026-10-05",
  pickupTo: "2026-10-06",
  deliverBy: "2026-10-12",
  cargoType: "general_palletized",
  cargoDescription: "8 pallets of shelf-stable groceries",
  palletCount: 8,
  weightLbs: 12000,
  equipment: "dry_van",
  specialRequirements: ["port_drayage"],
  targetPrice: 4500,
  ...overrides,
});

/** Builds a matching input without touching the database, for domain tests. */
export function matchInput(
  overrides: {
    company?: Partial<Company>;
    profile?: Partial<SupplierProfile>;
    stats?: Partial<MatchInput["stats"]>;
  } = {},
): MatchInput {
  const company: Company = {
    id: "co_supplier",
    name: "Caribe Carriers",
    kind: "supplier",
    contactEmail: "dispatch@caribe.example",
    contactPhone: "787-555-0110",
    place: { city: "San Juan", region: "PR", country: "US" },
    verificationStatus: "verified",
    verificationNotes: "",
    mcNumber: "MC-123456",
    dotNumber: "",
    insuranceExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides.company,
  };
  const profile: SupplierProfile = {
    companyId: company.id,
    equipment: ["dry_van", "reefer"],
    cargoTypes: ["general_palletized"],
    serviceRegions: ["US-FL", "US-PR"],
    lanes: [{ origin: "US-FL", destination: "US-PR" }],
    capabilities: ["port_drayage"],
    blackoutDates: [],
    maxWeightLbs: 44000,
    ratePerMileCents: 210,
    notes: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides.profile,
  };
  return { company, profile, stats: { ...emptyStats(company.id), ...overrides.stats } };
}

export function testShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: "shp_test",
    reference: "SHP-TEST01",
    shipperCompanyId: "co_shipper",
    origin: { city: "Miami", region: "FL", country: "US" },
    destination: { city: "San Juan", region: "PR", country: "US" },
    pickupFrom: "2026-10-05",
    pickupTo: "2026-10-06",
    deliverBy: "2026-10-12",
    cargoType: "general_palletized",
    cargoDescription: "8 pallets",
    palletCount: 8,
    weightLbs: 12000,
    dimensionsIn: null,
    equipment: "dry_van",
    specialRequirements: ["port_drayage"],
    targetPriceCents: 450_000,
    visibility: "marketplace",
    invitedCompanyIds: [],
    status: "posted",
    awardedQuoteId: null,
    createdAt: "2026-09-20T12:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}
