/**
 * Domain vocabulary for the freight marketplace.
 *
 * Money is always integer cents; weights are pounds; distances are statute
 * miles. Timestamps are ISO-8601 strings in UTC so they survive JSON and SQL
 * without a date library.
 */

export const USER_ROLES = ["shipper", "supplier", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const COMPANY_KINDS = ["shipper", "supplier"] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

export const VERIFICATION_STATUSES = ["unverified", "pending", "verified", "rejected"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Trailer/equipment classes a shipment can require and a supplier can own. */
export const EQUIPMENT_TYPES = [
  "dry_van",
  "reefer",
  "flatbed",
  "step_deck",
  "container_20",
  "container_40",
  "box_truck",
  "tanker",
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const CARGO_TYPES = [
  "general_palletized",
  "refrigerated_food",
  "frozen_food",
  "beverages",
  "building_materials",
  "machinery",
  "vehicles",
  "pharmaceuticals",
  "hazmat",
  "household_goods",
] as const;
export type CargoType = (typeof CARGO_TYPES)[number];

/** Cargo that only certain equipment can legally or physically carry. */
export const CARGO_EQUIPMENT_REQUIREMENTS: Partial<Record<CargoType, readonly EquipmentType[]>> = {
  refrigerated_food: ["reefer", "container_40", "container_20"],
  frozen_food: ["reefer"],
  pharmaceuticals: ["reefer", "dry_van", "box_truck"],
  vehicles: ["flatbed", "step_deck"],
  building_materials: ["flatbed", "step_deck", "dry_van", "container_40"],
  hazmat: ["tanker", "dry_van", "container_20", "container_40"],
};

export const SPECIAL_REQUIREMENTS = [
  "liftgate",
  "inside_delivery",
  "appointment_required",
  "team_drivers",
  "tarps",
  "hazmat_certified",
  "temperature_logging",
  "customs_clearance",
  "port_drayage",
] as const;
export type SpecialRequirement = (typeof SPECIAL_REQUIREMENTS)[number];

export const SHIPMENT_STATUSES = [
  "posted",
  "awarded",
  "picked_up",
  "in_transit",
  "delivered",
  "cancelled",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const QUOTE_STATUSES = [
  "pending", // waiting on the shipper
  "countered", // waiting on the supplier
  "accepted",
  "declined",
  "withdrawn",
  "expired",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const SHIPMENT_VISIBILITIES = ["marketplace", "invited"] as const;
export type ShipmentVisibility = (typeof SHIPMENT_VISIBILITIES)[number];

export type Place = {
  city: string;
  /** ISO-3166-2 style subdivision code without the country prefix, e.g. "FL", "PR", "SD" (Santo Domingo). */
  region: string;
  /** ISO-3166-1 alpha-2, e.g. "US", "DO". */
  country: string;
  postalCode?: string;
};

export type Company = {
  id: string;
  name: string;
  kind: CompanyKind;
  contactEmail: string;
  contactPhone: string;
  place: Place;
  verificationStatus: VerificationStatus;
  verificationNotes: string;
  /** Carrier authority identifiers. Collected and shown; not validated against FMCSA (see README). */
  mcNumber: string;
  dotNumber: string;
  insuranceExpiresAt: string | null;
  createdAt: string;
};

export type User = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  companyId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

export type SupplierProfile = {
  companyId: string;
  equipment: EquipmentType[];
  cargoTypes: CargoType[];
  /** Regions served, as "COUNTRY-REGION" keys, e.g. "US-FL", "US-PR", "DO-SD". */
  serviceRegions: string[];
  /** Lanes the supplier actively runs; a match on one of these is a strong signal. */
  lanes: { origin: string; destination: string }[];
  capabilities: SpecialRequirement[];
  maxWeightLbs: number;
  /** Self-declared all-in rate used only to estimate price competitiveness. */
  ratePerMileCents: number | null;
  /** Dates the supplier cannot pick up (ISO dates, YYYY-MM-DD). */
  blackoutDates: string[];
  notes: string;
  updatedAt: string;
};

/**
 * Performance counters accumulated from real platform activity. A new supplier
 * has zeroes, and matching treats that as "no history" rather than as bad
 * history.
 */
export type SupplierStats = {
  companyId: string;
  completedShipments: number;
  onTimeDeliveries: number;
  lateDeliveries: number;
  cancellations: number;
  opportunitiesSeen: number;
  quotesSubmitted: number;
  responseSecondsTotal: number;
  responsesCounted: number;
};

export type Shipment = {
  id: string;
  reference: string;
  shipperCompanyId: string;
  origin: Place;
  destination: Place;
  pickupFrom: string;
  pickupTo: string;
  deliverBy: string | null;
  cargoType: CargoType;
  cargoDescription: string;
  palletCount: number;
  weightLbs: number;
  dimensionsIn: { length: number; width: number; height: number } | null;
  equipment: EquipmentType;
  specialRequirements: SpecialRequirement[];
  targetPriceCents: number | null;
  visibility: ShipmentVisibility;
  /** Populated when visibility is "invited". */
  invitedCompanyIds: string[];
  status: ShipmentStatus;
  awardedQuoteId: string | null;
  createdAt: string;
  closedAt: string | null;
};

export type QuoteOffer = {
  id: string;
  quoteId: string;
  actor: "supplier" | "shipper";
  priceCents: number;
  transitDays: number;
  note: string;
  createdAt: string;
};

export type Quote = {
  id: string;
  shipmentId: string;
  supplierCompanyId: string;
  status: QuoteStatus;
  priceCents: number;
  transitDays: number;
  equipment: EquipmentType;
  terms: string;
  validUntil: string;
  offers: QuoteOffer[];
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  shipmentId: string;
  /** Every thread is between the shipper and exactly one supplier company. */
  supplierCompanyId: string;
  senderUserId: string;
  senderCompanyId: string;
  body: string;
  createdAt: string;
};

export type ShipmentEvent = {
  id: string;
  shipmentId: string;
  type: string;
  actorUserId: string | null;
  detail: string;
  createdAt: string;
};

export type Session = {
  userId: string;
  csrfToken: string;
  expiresAt: string;
};
