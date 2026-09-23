/**
 * SQLite adapter for the persistence port, on Node's built-in `node:sqlite`.
 *
 * Real SQL, real constraints, real transactions, in a file you can open with
 * any sqlite client — and no dependency to install. `:memory:` gives tests a
 * throwaway database with the same schema the server runs.
 */

import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { newId, newReference } from "../domain/ids.ts";
import type { ComparableAward } from "../domain/rates.ts";
import type {
  Company,
  Message,
  Quote,
  QuoteOffer,
  Session,
  Shipment,
  ShipmentEvent,
  ShipmentStatus,
  SupplierProfile,
  SupplierStats,
  User,
  VerificationStatus,
} from "../domain/types.ts";
import type {
  FloorEvent,
  NewCompany,
  NewQuote,
  NewShipment,
  NewUser,
  StatDelta,
  Store,
  SupplierRecord,
} from "../ports/store.ts";

type Row = Record<string, unknown>;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "sqlite-schema.sql");

const text = (row: Row, key: string): string => String(row[key] ?? "");
const textOrNull = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : String(row[key]);
const int = (row: Row, key: string): number => Number(row[key] ?? 0);
const intOrNull = (row: Row, key: string): number | null =>
  row[key] === null || row[key] === undefined ? null : Number(row[key]);
const json = <T>(row: Row, key: string, fallback: T): T => {
  const raw = row[key];
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  private transact<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------------------------------------------------------- companies

  createCompany(company: NewCompany): Company {
    const id = newId("co");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO companies (id, name, kind, contact_email, contact_phone, city, region, country,
           postal_code, verification_status, verification_notes, mc_number, dot_number,
           insurance_expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        company.name,
        company.kind,
        company.contactEmail,
        company.contactPhone,
        company.place.city,
        company.place.region,
        company.place.country,
        company.place.postalCode ?? null,
        company.verificationStatus,
        company.verificationNotes,
        company.mcNumber,
        company.dotNumber,
        company.insuranceExpiresAt,
        createdAt,
      );
    return this.getCompany(id) as Company;
  }

  getCompany(id: string): Company | null {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Row | undefined;
    return row ? toCompany(row) : null;
  }

  listCompanies(
    filter: { kind?: Company["kind"]; verificationStatus?: VerificationStatus } = {},
  ): Company[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.verificationStatus) {
      clauses.push("verification_status = ?");
      params.push(filter.verificationStatus);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM companies ${where} ORDER BY name`)
      .all(...params) as Row[];
    return rows.map(toCompany);
  }

  setVerification(companyId: string, status: VerificationStatus, notes: string): Company | null {
    this.db
      .prepare("UPDATE companies SET verification_status = ?, verification_notes = ? WHERE id = ?")
      .run(status, notes, companyId);
    return this.getCompany(companyId);
  }

  // -------------------------------------------------------------------- users

  createUser(user: NewUser): User {
    const id = newId("usr");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, name, role, company_id, created_at, last_login_at)
         VALUES (?,?,?,?,?,?,?,NULL)`,
      )
      .run(id, user.email, user.passwordHash, user.name, user.role, user.companyId, createdAt);
    return this.getUserById(id) as User;
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  getUserByEmail(email: string): (User & { passwordHash: string }) | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as
      | Row
      | undefined;
    return row ? { ...toUser(row), passwordHash: text(row, "password_hash") } : null;
  }

  markLogin(userId: string, at: string): void {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(at, userId);
  }

  // ----------------------------------------------------------------- sessions

  createSession(tokenHash: string, session: Session): void {
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?,?,?,?)",
      )
      .run(tokenHash, session.userId, session.csrfToken, session.expiresAt);
  }

  getSession(tokenHash: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
      | Row
      | undefined;
    if (!row) return null;
    return {
      userId: text(row, "user_id"),
      csrfToken: text(row, "csrf_token"),
      expiresAt: text(row, "expires_at"),
    };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteExpiredSessions(now: string): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  }

  // -------------------------------------------------------- supplier profiles

  putSupplierProfile(profile: SupplierProfile): SupplierProfile {
    this.db
      .prepare(
        `INSERT INTO supplier_profiles (company_id, equipment, cargo_types, service_regions, lanes,
           capabilities, blackout_dates, max_weight_lbs, rate_per_mile_cents, notes, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(company_id) DO UPDATE SET
           equipment = excluded.equipment,
           cargo_types = excluded.cargo_types,
           service_regions = excluded.service_regions,
           lanes = excluded.lanes,
           capabilities = excluded.capabilities,
           blackout_dates = excluded.blackout_dates,
           max_weight_lbs = excluded.max_weight_lbs,
           rate_per_mile_cents = excluded.rate_per_mile_cents,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .run(
        profile.companyId,
        JSON.stringify(profile.equipment),
        JSON.stringify(profile.cargoTypes),
        JSON.stringify(profile.serviceRegions),
        JSON.stringify(profile.lanes),
        JSON.stringify(profile.capabilities),
        JSON.stringify(profile.blackoutDates),
        profile.maxWeightLbs,
        profile.ratePerMileCents,
        profile.notes,
        profile.updatedAt,
      );
    return this.getSupplierProfile(profile.companyId) as SupplierProfile;
  }

  getSupplierProfile(companyId: string): SupplierProfile | null {
    const row = this.db
      .prepare("SELECT * FROM supplier_profiles WHERE company_id = ?")
      .get(companyId) as Row | undefined;
    return row ? toProfile(row) : null;
  }

  getSupplierStats(companyId: string): SupplierStats {
    const row = this.db
      .prepare("SELECT * FROM supplier_stats WHERE company_id = ?")
      .get(companyId) as Row | undefined;
    return row ? toStats(row) : emptyStats(companyId);
  }

  bumpSupplierStats(companyId: string, delta: StatDelta): void {
    const columns: Record<keyof StatDelta, string> = {
      completedShipments: "completed_shipments",
      onTimeDeliveries: "on_time_deliveries",
      lateDeliveries: "late_deliveries",
      cancellations: "cancellations",
      opportunitiesSeen: "opportunities_seen",
      quotesSubmitted: "quotes_submitted",
      responseSecondsTotal: "response_seconds_total",
      responsesCounted: "responses_counted",
    };
    this.db.prepare("INSERT OR IGNORE INTO supplier_stats (company_id) VALUES (?)").run(companyId);
    for (const [key, column] of Object.entries(columns) as [keyof StatDelta, string][]) {
      const amount = delta[key];
      if (amount === undefined || amount === 0) continue;
      this.db
        .prepare(`UPDATE supplier_stats SET ${column} = ${column} + ? WHERE company_id = ?`)
        .run(amount, companyId);
    }
  }

  listSupplierRecords(): SupplierRecord[] {
    const companies = this.listCompanies({ kind: "supplier" });
    const records: SupplierRecord[] = [];
    for (const company of companies) {
      const profile = this.getSupplierProfile(company.id);
      // A supplier with no profile has told us nothing to match on.
      if (!profile) continue;
      records.push({ company, profile, stats: this.getSupplierStats(company.id) });
    }
    return records;
  }

  getSupplierRecord(companyId: string): SupplierRecord | null {
    const company = this.getCompany(companyId);
    const profile = this.getSupplierProfile(companyId);
    if (!company || !profile) return null;
    return { company, profile, stats: this.getSupplierStats(companyId) };
  }

  // ---------------------------------------------------------------- shipments

  createShipment(shipment: NewShipment): Shipment {
    const id = newId("shp");
    const createdAt = new Date().toISOString();
    return this.transact(() => {
      this.db
        .prepare(
          `INSERT INTO shipments (id, reference, shipper_company_id, origin_city, origin_region,
             origin_country, origin_postal_code, dest_city, dest_region, dest_country, dest_postal_code,
             pickup_from, pickup_to, deliver_by, cargo_type, cargo_description, pallet_count, weight_lbs,
             length_in, width_in, height_in, equipment, special_requirements, target_price_cents,
             visibility, status, awarded_quote_id, created_at, closed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',NULL,?,NULL)`,
        )
        .run(
          id,
          newReference(),
          shipment.shipperCompanyId,
          shipment.origin.city,
          shipment.origin.region,
          shipment.origin.country,
          shipment.origin.postalCode ?? null,
          shipment.destination.city,
          shipment.destination.region,
          shipment.destination.country,
          shipment.destination.postalCode ?? null,
          shipment.pickupFrom,
          shipment.pickupTo,
          shipment.deliverBy,
          shipment.cargoType,
          shipment.cargoDescription,
          shipment.palletCount,
          shipment.weightLbs,
          shipment.dimensionsIn?.length ?? null,
          shipment.dimensionsIn?.width ?? null,
          shipment.dimensionsIn?.height ?? null,
          shipment.equipment,
          JSON.stringify(shipment.specialRequirements),
          shipment.targetPriceCents,
          shipment.visibility,
          createdAt,
        );
      for (const companyId of shipment.invitedCompanyIds) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO shipment_invitations (shipment_id, company_id) VALUES (?,?)",
          )
          .run(id, companyId);
      }
      return this.getShipment(id) as Shipment;
    });
  }

  getShipment(id: string): Shipment | null {
    const row = this.db.prepare("SELECT * FROM shipments WHERE id = ?").get(id) as Row | undefined;
    return row ? this.hydrateShipment(row) : null;
  }

  private hydrateShipment(row: Row): Shipment {
    const id = text(row, "id");
    const invitations = this.db
      .prepare("SELECT company_id FROM shipment_invitations WHERE shipment_id = ?")
      .all(id) as Row[];
    return toShipment(
      row,
      invitations.map((invitation) => text(invitation, "company_id")),
    );
  }

  listShipmentsForShipper(companyId: string): Shipment[] {
    const rows = this.db
      .prepare("SELECT * FROM shipments WHERE shipper_company_id = ? ORDER BY created_at DESC")
      .all(companyId) as Row[];
    return rows.map((row) => this.hydrateShipment(row));
  }

  listPostedShipments(): Shipment[] {
    const rows = this.db
      .prepare("SELECT * FROM shipments WHERE status = 'posted' ORDER BY created_at DESC")
      .all() as Row[];
    return rows.map((row) => this.hydrateShipment(row));
  }

  listShipmentsForSupplier(companyId: string): Shipment[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.* FROM shipments s
         LEFT JOIN quotes q ON q.shipment_id = s.id
         WHERE q.supplier_company_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(companyId) as Row[];
    return rows.map((row) => this.hydrateShipment(row));
  }

  listAllShipments(): Shipment[] {
    const rows = this.db.prepare("SELECT * FROM shipments ORDER BY created_at DESC").all() as Row[];
    return rows.map((row) => this.hydrateShipment(row));
  }

  setShipmentStatus(id: string, status: ShipmentStatus, closedAt: string | null): Shipment | null {
    this.db
      .prepare("UPDATE shipments SET status = ?, closed_at = ? WHERE id = ?")
      .run(status, closedAt, id);
    return this.getShipment(id);
  }

  awardShipment(shipmentId: string, quoteId: string, at: string): Shipment | null {
    return this.transact(() => {
      this.db
        .prepare("UPDATE shipments SET status = 'awarded', awarded_quote_id = ? WHERE id = ?")
        .run(quoteId, shipmentId);
      this.db
        .prepare("UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?")
        .run(at, quoteId);
      this.db
        .prepare(
          `UPDATE quotes SET status = 'declined', updated_at = ?
           WHERE shipment_id = ? AND id != ? AND status IN ('pending','countered')`,
        )
        .run(at, shipmentId, quoteId);
      return this.getShipment(shipmentId);
    });
  }

  // ------------------------------------------------------------------- quotes

  createQuote(quote: NewQuote, firstOffer: Omit<QuoteOffer, "id" | "quoteId">): Quote {
    const id = newId("qt");
    const now = new Date().toISOString();
    return this.transact(() => {
      this.db
        .prepare(
          `INSERT INTO quotes (id, shipment_id, supplier_company_id, status, price_cents, transit_days,
             equipment, terms, valid_until, created_at, updated_at)
           VALUES (?,?,?,'pending',?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          quote.shipmentId,
          quote.supplierCompanyId,
          quote.priceCents,
          quote.transitDays,
          quote.equipment,
          quote.terms,
          quote.validUntil,
          now,
          now,
        );
      this.insertOffer(id, firstOffer);
      return this.getQuote(id) as Quote;
    });
  }

  private insertOffer(quoteId: string, offer: Omit<QuoteOffer, "id" | "quoteId">): void {
    this.db
      .prepare(
        `INSERT INTO quote_offers (id, quote_id, actor, price_cents, transit_days, note, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        newId("off"),
        quoteId,
        offer.actor,
        offer.priceCents,
        offer.transitDays,
        offer.note,
        offer.createdAt,
      );
  }

  getQuote(id: string): Quote | null {
    const row = this.db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as Row | undefined;
    return row ? this.hydrateQuote(row) : null;
  }

  private hydrateQuote(row: Row): Quote {
    const id = text(row, "id");
    const offers = this.db
      .prepare("SELECT * FROM quote_offers WHERE quote_id = ? ORDER BY created_at, id")
      .all(id) as Row[];
    return toQuote(row, offers.map(toOffer));
  }

  listQuotesForShipment(shipmentId: string): Quote[] {
    const rows = this.db
      .prepare("SELECT * FROM quotes WHERE shipment_id = ? ORDER BY price_cents")
      .all(shipmentId) as Row[];
    return rows.map((row) => this.hydrateQuote(row));
  }

  listQuotesForSupplier(companyId: string): Quote[] {
    const rows = this.db
      .prepare("SELECT * FROM quotes WHERE supplier_company_id = ? ORDER BY updated_at DESC")
      .all(companyId) as Row[];
    return rows.map((row) => this.hydrateQuote(row));
  }

  findQuote(shipmentId: string, supplierCompanyId: string): Quote | null {
    const row = this.db
      .prepare("SELECT * FROM quotes WHERE shipment_id = ? AND supplier_company_id = ?")
      .get(shipmentId, supplierCompanyId) as Row | undefined;
    return row ? this.hydrateQuote(row) : null;
  }

  addOffer(
    quoteId: string,
    offer: Omit<QuoteOffer, "id" | "quoteId">,
    status: Quote["status"],
  ): Quote | null {
    return this.transact(() => {
      this.insertOffer(quoteId, offer);
      this.db
        .prepare(
          "UPDATE quotes SET price_cents = ?, transit_days = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(offer.priceCents, offer.transitDays, status, offer.createdAt, quoteId);
      return this.getQuote(quoteId);
    });
  }

  setQuoteStatus(quoteId: string, status: Quote["status"], at: string): Quote | null {
    this.db
      .prepare("UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, at, quoteId);
    return this.getQuote(quoteId);
  }

  declineOpenQuotes(shipmentId: string, exceptQuoteId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE quotes SET status = 'declined', updated_at = ?
         WHERE shipment_id = ? AND id != ? AND status IN ('pending','countered')`,
      )
      .run(at, shipmentId, exceptQuoteId);
  }

  // --------------------------------------------------------- messages, events

  addMessage(message: Omit<Message, "id">): Message {
    const id = newId("msg");
    this.db
      .prepare(
        `INSERT INTO messages (id, shipment_id, supplier_company_id, sender_user_id, sender_company_id,
           body, created_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        message.shipmentId,
        message.supplierCompanyId,
        message.senderUserId,
        message.senderCompanyId,
        message.body,
        message.createdAt,
      );
    return { id, ...message };
  }

  listMessages(shipmentId: string, supplierCompanyId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE shipment_id = ? AND supplier_company_id = ?
         ORDER BY created_at, id`,
      )
      .all(shipmentId, supplierCompanyId) as Row[];
    return rows.map(toMessage);
  }

  listMessageThreads(
    shipmentId: string,
  ): { supplierCompanyId: string; lastMessageAt: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT supplier_company_id, MAX(created_at) AS last_at, COUNT(*) AS count
         FROM messages WHERE shipment_id = ? GROUP BY supplier_company_id ORDER BY last_at DESC`,
      )
      .all(shipmentId) as Row[];
    return rows.map((row) => ({
      supplierCompanyId: text(row, "supplier_company_id"),
      lastMessageAt: text(row, "last_at"),
      count: int(row, "count"),
    }));
  }

  addEvent(event: Omit<ShipmentEvent, "id">): ShipmentEvent {
    const id = newId("evt");
    this.db
      .prepare(
        "INSERT INTO shipment_events (id, shipment_id, type, actor_user_id, detail, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, event.shipmentId, event.type, event.actorUserId, event.detail, event.createdAt);
    return { id, ...event };
  }

  listEvents(shipmentId: string): ShipmentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY created_at, id")
      .all(shipmentId) as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      shipmentId: text(row, "shipment_id"),
      type: text(row, "type"),
      actorUserId: textOrNull(row, "actor_user_id"),
      detail: text(row, "detail"),
      createdAt: text(row, "created_at"),
    }));
  }

  listRecentEvents(shipmentIds: string[] | null, limit: number): FloorEvent[] {
    if (shipmentIds !== null && shipmentIds.length === 0) return [];
    const scope =
      shipmentIds === null
        ? ""
        : `WHERE e.shipment_id IN (${shipmentIds.map(() => "?").join(",")})`;
    const params: (string | number)[] = shipmentIds === null ? [] : [...shipmentIds];
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT e.*, s.reference, u.name AS actor_name, c.name AS actor_company_name
         FROM shipment_events e
         JOIN shipments s ON s.id = e.shipment_id
         LEFT JOIN users u ON u.id = e.actor_user_id
         LEFT JOIN companies c ON c.id = u.company_id
         ${scope}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      shipmentId: text(row, "shipment_id"),
      type: text(row, "type"),
      actorUserId: textOrNull(row, "actor_user_id"),
      detail: text(row, "detail"),
      createdAt: text(row, "created_at"),
      reference: text(row, "reference"),
      actorName: textOrNull(row, "actor_name"),
      actorCompanyName: textOrNull(row, "actor_company_name"),
    }));
  }

  listComparableAwards(): ComparableAward[] {
    const rows = this.db
      .prepare(
        `SELECT s.origin_country, s.origin_region, s.dest_country, s.dest_region, s.equipment, q.price_cents
         FROM shipments s JOIN quotes q ON q.id = s.awarded_quote_id
         WHERE s.awarded_quote_id IS NOT NULL`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      originRegion: `${text(row, "origin_country")}-${text(row, "origin_region")}`,
      destinationRegion: `${text(row, "dest_country")}-${text(row, "dest_region")}`,
      equipment: text(row, "equipment") as ComparableAward["equipment"],
      priceCents: int(row, "price_cents"),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toCompany(row: Row): Company {
  const postalCode = textOrNull(row, "postal_code");
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    kind: text(row, "kind") as Company["kind"],
    contactEmail: text(row, "contact_email"),
    contactPhone: text(row, "contact_phone"),
    place: {
      city: text(row, "city"),
      region: text(row, "region"),
      country: text(row, "country"),
      ...(postalCode ? { postalCode } : {}),
    },
    verificationStatus: text(row, "verification_status") as Company["verificationStatus"],
    verificationNotes: text(row, "verification_notes"),
    mcNumber: text(row, "mc_number"),
    dotNumber: text(row, "dot_number"),
    insuranceExpiresAt: textOrNull(row, "insurance_expires_at"),
    createdAt: text(row, "created_at"),
  };
}

function toUser(row: Row): User {
  return {
    id: text(row, "id"),
    email: text(row, "email"),
    name: text(row, "name"),
    role: text(row, "role") as User["role"],
    companyId: textOrNull(row, "company_id"),
    createdAt: text(row, "created_at"),
    lastLoginAt: textOrNull(row, "last_login_at"),
  };
}

function toProfile(row: Row): SupplierProfile {
  return {
    companyId: text(row, "company_id"),
    equipment: json(row, "equipment", [] as SupplierProfile["equipment"]),
    cargoTypes: json(row, "cargo_types", [] as SupplierProfile["cargoTypes"]),
    serviceRegions: json(row, "service_regions", [] as string[]),
    lanes: json(row, "lanes", [] as SupplierProfile["lanes"]),
    capabilities: json(row, "capabilities", [] as SupplierProfile["capabilities"]),
    blackoutDates: json(row, "blackout_dates", [] as string[]),
    maxWeightLbs: int(row, "max_weight_lbs"),
    ratePerMileCents: intOrNull(row, "rate_per_mile_cents"),
    notes: text(row, "notes"),
    updatedAt: text(row, "updated_at"),
  };
}

function toStats(row: Row): SupplierStats {
  return {
    companyId: text(row, "company_id"),
    completedShipments: int(row, "completed_shipments"),
    onTimeDeliveries: int(row, "on_time_deliveries"),
    lateDeliveries: int(row, "late_deliveries"),
    cancellations: int(row, "cancellations"),
    opportunitiesSeen: int(row, "opportunities_seen"),
    quotesSubmitted: int(row, "quotes_submitted"),
    responseSecondsTotal: int(row, "response_seconds_total"),
    responsesCounted: int(row, "responses_counted"),
  };
}

export function emptyStats(companyId: string): SupplierStats {
  return {
    companyId,
    completedShipments: 0,
    onTimeDeliveries: 0,
    lateDeliveries: 0,
    cancellations: 0,
    opportunitiesSeen: 0,
    quotesSubmitted: 0,
    responseSecondsTotal: 0,
    responsesCounted: 0,
  };
}

function toShipment(row: Row, invitedCompanyIds: string[]): Shipment {
  const originPostal = textOrNull(row, "origin_postal_code");
  const destPostal = textOrNull(row, "dest_postal_code");
  const length = intOrNull(row, "length_in");
  const width = intOrNull(row, "width_in");
  const height = intOrNull(row, "height_in");
  return {
    id: text(row, "id"),
    reference: text(row, "reference"),
    shipperCompanyId: text(row, "shipper_company_id"),
    origin: {
      city: text(row, "origin_city"),
      region: text(row, "origin_region"),
      country: text(row, "origin_country"),
      ...(originPostal ? { postalCode: originPostal } : {}),
    },
    destination: {
      city: text(row, "dest_city"),
      region: text(row, "dest_region"),
      country: text(row, "dest_country"),
      ...(destPostal ? { postalCode: destPostal } : {}),
    },
    pickupFrom: text(row, "pickup_from"),
    pickupTo: text(row, "pickup_to"),
    deliverBy: textOrNull(row, "deliver_by"),
    cargoType: text(row, "cargo_type") as Shipment["cargoType"],
    cargoDescription: text(row, "cargo_description"),
    palletCount: int(row, "pallet_count"),
    weightLbs: int(row, "weight_lbs"),
    dimensionsIn: length && width && height ? { length, width, height } : null,
    equipment: text(row, "equipment") as Shipment["equipment"],
    specialRequirements: json(row, "special_requirements", [] as Shipment["specialRequirements"]),
    targetPriceCents: intOrNull(row, "target_price_cents"),
    visibility: text(row, "visibility") as Shipment["visibility"],
    invitedCompanyIds,
    status: text(row, "status") as Shipment["status"],
    awardedQuoteId: textOrNull(row, "awarded_quote_id"),
    createdAt: text(row, "created_at"),
    closedAt: textOrNull(row, "closed_at"),
  };
}

function toQuote(row: Row, offers: QuoteOffer[]): Quote {
  return {
    id: text(row, "id"),
    shipmentId: text(row, "shipment_id"),
    supplierCompanyId: text(row, "supplier_company_id"),
    status: text(row, "status") as Quote["status"],
    priceCents: int(row, "price_cents"),
    transitDays: int(row, "transit_days"),
    equipment: text(row, "equipment") as Quote["equipment"],
    terms: text(row, "terms"),
    validUntil: text(row, "valid_until"),
    offers,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function toOffer(row: Row): QuoteOffer {
  return {
    id: text(row, "id"),
    quoteId: text(row, "quote_id"),
    actor: text(row, "actor") as QuoteOffer["actor"],
    priceCents: int(row, "price_cents"),
    transitDays: int(row, "transit_days"),
    note: text(row, "note"),
    createdAt: text(row, "created_at"),
  };
}

function toMessage(row: Row): Message {
  return {
    id: text(row, "id"),
    shipmentId: text(row, "shipment_id"),
    supplierCompanyId: text(row, "supplier_company_id"),
    senderUserId: text(row, "sender_user_id"),
    senderCompanyId: text(row, "sender_company_id"),
    body: text(row, "body"),
    createdAt: text(row, "created_at"),
  };
}
