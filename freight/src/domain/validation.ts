/**
 * Input parsing for everything that arrives from a browser.
 *
 * Every route parses before it touches the store, so the rest of the codebase
 * can assume domain types are real. Errors collect rather than throw on the
 * first problem — a form that reports one field at a time is a bad form.
 */

import { isKnownRegion } from "./geo.ts";
import {
  CARGO_TYPES,
  COMPANY_KINDS,
  EQUIPMENT_TYPES,
  SHIPMENT_VISIBILITIES,
  SPECIAL_REQUIREMENTS,
} from "./types.ts";
import type {
  CargoType,
  CompanyKind,
  EquipmentType,
  Place,
  ShipmentVisibility,
  SpecialRequirement,
} from "./types.ts";

export class ValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(Object.values(fields)[0] ?? "Invalid input");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export class Validator {
  private readonly body: Record<string, unknown>;
  readonly errors: Record<string, string> = {};

  constructor(body: unknown) {
    this.body = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  }

  private fail<T>(field: string, message: string, fallback: T): T {
    this.errors[field] ??= message;
    return fallback;
  }

  string(field: string, options: { min?: number; max?: number; optional?: boolean } = {}): string {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === "") {
      if (options.optional) return "";
      return this.fail(field, "Required", "");
    }
    if (typeof raw !== "string") return this.fail(field, "Must be text", "");
    const value = raw.trim();
    if (options.min !== undefined && value.length < options.min) {
      return this.fail(field, `Must be at least ${options.min} characters`, value);
    }
    if (options.max !== undefined && value.length > options.max) {
      return this.fail(
        field,
        `Must be at most ${options.max} characters`,
        value.slice(0, options.max),
      );
    }
    return value;
  }

  email(field: string): string {
    const value = this.string(field, { max: 254 }).toLowerCase();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      return this.fail(field, "Enter a valid email address", value);
    }
    return value;
  }

  password(field: string): string {
    const raw = this.body[field];
    if (typeof raw !== "string" || raw.length < 12) {
      return this.fail(field, "Use at least 12 characters", typeof raw === "string" ? raw : "");
    }
    if (raw.length > 200) return this.fail(field, "Must be at most 200 characters", raw);
    return raw;
  }

  integer(field: string, options: { min?: number; max?: number; optional?: boolean } = {}): number {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === "") {
      if (options.optional) return 0;
      return this.fail(field, "Required", 0);
    }
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) return this.fail(field, "Must be a number", 0);
    const rounded = Math.round(value);
    if (options.min !== undefined && rounded < options.min) {
      return this.fail(field, `Must be at least ${options.min}`, rounded);
    }
    if (options.max !== undefined && rounded > options.max) {
      return this.fail(field, `Must be at most ${options.max}`, rounded);
    }
    return rounded;
  }

  /** Dollars in, cents out — the UI never sends cents and the domain never sees dollars. */
  usdCents(field: string, options: { optional?: boolean; min?: number } = {}): number | null {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === "") {
      if (options.optional) return null;
      return this.fail(field, "Required", null);
    }
    const dollars = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0)
      return this.fail(field, "Enter an amount in dollars", null);
    const cents = Math.round(dollars * 100);
    if (options.min !== undefined && cents < options.min) {
      return this.fail(field, `Must be at least $${(options.min / 100).toFixed(0)}`, cents);
    }
    if (cents > 100_000_000) return this.fail(field, "That is above the per-shipment limit", cents);
    return cents;
  }

  date(field: string, options: { optional?: boolean } = {}): string {
    const value = this.string(field, { optional: options.optional === true });
    if (!value) return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      return this.fail(field, "Use a YYYY-MM-DD date", value);
    }
    return value;
  }

  oneOf<T extends string>(
    field: string,
    allowed: readonly T[],
    options: { optional?: boolean } = {},
  ): T {
    const value = this.string(field, { optional: options.optional === true });
    if (!value && options.optional) return allowed[0] as T;
    if (!allowed.includes(value as T)) {
      return this.fail(field, `Choose one of: ${allowed.join(", ")}`, allowed[0] as T);
    }
    return value as T;
  }

  manyOf<T extends string>(field: string, allowed: readonly T[]): T[] {
    const raw = this.body[field];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return this.fail(field, "Must be a list", []);
    const values = raw.filter(
      (item): item is T => typeof item === "string" && allowed.includes(item as T),
    );
    if (values.length !== raw.length) return this.fail(field, `Unknown value in ${field}`, values);
    return [...new Set(values)];
  }

  stringList(field: string, options: { max?: number; itemMax?: number } = {}): string[] {
    const raw = this.body[field];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return this.fail(field, "Must be a list", []);
    if (options.max !== undefined && raw.length > options.max) {
      return this.fail(field, `At most ${options.max} entries`, []);
    }
    const values: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") return this.fail(field, "Entries must be text", values);
      const value = item.trim();
      if (!value) continue;
      if (value.length > (options.itemMax ?? 64))
        return this.fail(field, "Entry is too long", values);
      values.push(value);
    }
    return [...new Set(values)];
  }

  regionList(field: string): string[] {
    const values = this.stringList(field, { max: 60, itemMax: 8 }).map((value) =>
      value.toUpperCase(),
    );
    const unknown = values.filter((value) => !isKnownRegion(value));
    if (unknown.length > 0) {
      return this.fail(field, `Unknown region(s): ${unknown.join(", ")}`, values);
    }
    return values;
  }

  lanes(field: string): { origin: string; destination: string }[] {
    const raw = this.body[field];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 60)
      return this.fail(field, "Must be a list of lanes", []);
    const lanes: { origin: string; destination: string }[] = [];
    for (const item of raw) {
      const lane = item as { origin?: unknown; destination?: unknown };
      const origin = typeof lane?.origin === "string" ? lane.origin.toUpperCase() : "";
      const destination =
        typeof lane?.destination === "string" ? lane.destination.toUpperCase() : "";
      if (!isKnownRegion(origin) || !isKnownRegion(destination)) {
        return this.fail(field, "Each lane needs a known origin and destination region", lanes);
      }
      lanes.push({ origin, destination });
    }
    return lanes;
  }

  place(prefix: string): Place {
    const city = this.string(`${prefix}City`, { min: 2, max: 80 });
    const region = this.string(`${prefix}Region`, { min: 2, max: 8 }).toUpperCase();
    const country = this.string(`${prefix}Country`, { min: 2, max: 2 }).toUpperCase();
    const postalCode = this.string(`${prefix}PostalCode`, { optional: true, max: 12 });
    if (region && country && !isKnownRegion(`${country}-${region}`)) {
      this.fail(`${prefix}Region`, `We do not serve ${country}-${region} yet`, region);
    }
    return postalCode ? { city, region, country, postalCode } : { city, region, country };
  }

  done(): void {
    if (Object.keys(this.errors).length > 0) throw new ValidationError(this.errors);
  }
}

export type ShipmentInput = {
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
  invitedCompanyIds: string[];
};

export function parseShipmentInput(body: unknown): ShipmentInput {
  const validator = new Validator(body);
  const origin = validator.place("origin");
  const destination = validator.place("destination");
  const pickupFrom = validator.date("pickupFrom");
  const pickupTo = validator.date("pickupTo");
  const deliverByRaw = validator.date("deliverBy", { optional: true });
  const cargoType = validator.oneOf("cargoType", CARGO_TYPES);
  const cargoDescription = validator.string("cargoDescription", { min: 3, max: 500 });
  const palletCount = validator.integer("palletCount", { min: 0, max: 200 });
  const weightLbs = validator.integer("weightLbs", { min: 1, max: 100_000 });
  const equipment = validator.oneOf("equipment", EQUIPMENT_TYPES);
  const specialRequirements = validator.manyOf("specialRequirements", SPECIAL_REQUIREMENTS);
  const targetPriceCents = validator.usdCents("targetPrice", { optional: true, min: 5_000 });
  const visibility = validator.oneOf("visibility", SHIPMENT_VISIBILITIES, { optional: true });
  const invitedCompanyIds = validator.stringList("invitedCompanyIds", { max: 40, itemMax: 40 });

  const length = validator.integer("lengthIn", { optional: true, min: 0, max: 700 });
  const width = validator.integer("widthIn", { optional: true, min: 0, max: 200 });
  const height = validator.integer("heightIn", { optional: true, min: 0, max: 200 });

  if (pickupFrom && pickupTo && pickupTo < pickupFrom) {
    validator.errors.pickupTo ??= "Pickup window ends before it starts";
  }
  if (deliverByRaw && pickupFrom && deliverByRaw < pickupFrom) {
    validator.errors.deliverBy ??= "Delivery deadline is before pickup";
  }
  if (visibility === "invited" && invitedCompanyIds.length === 0) {
    validator.errors.invitedCompanyIds ??=
      "Invite at least one supplier, or post to the marketplace";
  }
  validator.done();

  return {
    origin,
    destination,
    pickupFrom,
    pickupTo,
    deliverBy: deliverByRaw || null,
    cargoType,
    cargoDescription,
    palletCount,
    weightLbs,
    dimensionsIn: length && width && height ? { length, width, height } : null,
    equipment,
    specialRequirements,
    targetPriceCents,
    visibility,
    invitedCompanyIds: visibility === "invited" ? invitedCompanyIds : [],
  };
}

export type RegistrationInput = {
  email: string;
  password: string;
  name: string;
  companyName: string;
  companyKind: CompanyKind;
  contactPhone: string;
  place: Place;
  mcNumber: string;
  dotNumber: string;
};

export function parseRegistrationInput(body: unknown): RegistrationInput {
  const validator = new Validator(body);
  const email = validator.email("email");
  const password = validator.password("password");
  const name = validator.string("name", { min: 2, max: 80 });
  const companyName = validator.string("companyName", { min: 2, max: 120 });
  const companyKind = validator.oneOf("companyKind", COMPANY_KINDS);
  const contactPhone = validator.string("contactPhone", { min: 7, max: 32 });
  const place = validator.place("company");
  const mcNumber = validator.string("mcNumber", { optional: true, max: 20 });
  const dotNumber = validator.string("dotNumber", { optional: true, max: 20 });
  validator.done();
  return {
    email,
    password,
    name,
    companyName,
    companyKind,
    contactPhone,
    place,
    mcNumber,
    dotNumber,
  };
}
