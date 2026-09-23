/**
 * Persistence port.
 *
 * The application layer talks to this interface only, so the SQLite adapter in
 * `src/adapters/` can be swapped for Postgres when the platform outgrows a
 * single file. Nothing here knows SQL.
 */

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

export type NewUser = Omit<User, "id" | "createdAt" | "lastLoginAt"> & { passwordHash: string };
export type NewCompany = Omit<Company, "id" | "createdAt">;
export type NewShipment = Omit<
  Shipment,
  "id" | "reference" | "createdAt" | "closedAt" | "status" | "awardedQuoteId"
>;
export type NewQuote = Omit<Quote, "id" | "createdAt" | "updatedAt" | "offers" | "status">;

export type SupplierRecord = {
  company: Company;
  profile: SupplierProfile;
  stats: SupplierStats;
};

export type StatDelta = Partial<Omit<SupplierStats, "companyId">>;

export interface Store {
  // Identity
  createCompany(company: NewCompany): Company;
  getCompany(id: string): Company | null;
  listCompanies(filter?: {
    kind?: Company["kind"];
    verificationStatus?: VerificationStatus;
  }): Company[];
  setVerification(companyId: string, status: VerificationStatus, notes: string): Company | null;

  createUser(user: NewUser): User;
  getUserById(id: string): User | null;
  getUserByEmail(email: string): (User & { passwordHash: string }) | null;
  markLogin(userId: string, at: string): void;

  createSession(tokenHash: string, session: Session): void;
  getSession(tokenHash: string): Session | null;
  deleteSession(tokenHash: string): void;
  deleteExpiredSessions(now: string): void;

  // Supplier profiles
  putSupplierProfile(profile: SupplierProfile): SupplierProfile;
  getSupplierProfile(companyId: string): SupplierProfile | null;
  getSupplierStats(companyId: string): SupplierStats;
  bumpSupplierStats(companyId: string, delta: StatDelta): void;
  listSupplierRecords(): SupplierRecord[];
  getSupplierRecord(companyId: string): SupplierRecord | null;

  // Shipments
  createShipment(shipment: NewShipment): Shipment;
  getShipment(id: string): Shipment | null;
  listShipmentsForShipper(companyId: string): Shipment[];
  listPostedShipments(): Shipment[];
  listShipmentsForSupplier(companyId: string): Shipment[];
  listAllShipments(): Shipment[];
  setShipmentStatus(id: string, status: ShipmentStatus, closedAt: string | null): Shipment | null;
  awardShipment(shipmentId: string, quoteId: string, at: string): Shipment | null;

  // Quotes
  createQuote(quote: NewQuote, firstOffer: Omit<QuoteOffer, "id" | "quoteId">): Quote;
  getQuote(id: string): Quote | null;
  listQuotesForShipment(shipmentId: string): Quote[];
  listQuotesForSupplier(companyId: string): Quote[];
  findQuote(shipmentId: string, supplierCompanyId: string): Quote | null;
  addOffer(
    quoteId: string,
    offer: Omit<QuoteOffer, "id" | "quoteId">,
    status: Quote["status"],
  ): Quote | null;
  setQuoteStatus(quoteId: string, status: Quote["status"], at: string): Quote | null;
  declineOpenQuotes(shipmentId: string, exceptQuoteId: string, at: string): void;

  // Conversation and audit
  addMessage(message: Omit<Message, "id">): Message;
  listMessages(shipmentId: string, supplierCompanyId: string): Message[];
  listMessageThreads(
    shipmentId: string,
  ): { supplierCompanyId: string; lastMessageAt: string; count: number }[];
  addEvent(event: Omit<ShipmentEvent, "id">): ShipmentEvent;
  listEvents(shipmentId: string): ShipmentEvent[];

  /** Awarded prices used as rate comparables. */
  listComparableAwards(): ComparableAward[];

  close(): void;
}
