/**
 * Registration, sign-in, sessions and the supplier's own profile.
 *
 * Every account belongs to exactly one company; the first user of a company
 * creates it during registration. Admin accounts are seeded, never registered
 * through the public form.
 */

import { CARGO_TYPES, EQUIPMENT_TYPES, SPECIAL_REQUIREMENTS } from "../domain/types.ts";
import type { Session, SupplierProfile, User } from "../domain/types.ts";
import { parseRegistrationInput } from "../domain/validation.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";
import { hashToken, newCsrfToken, newSessionToken } from "../security/tokens.ts";
import { badRequest, conflict, tooMany, unauthorized } from "./errors.ts";
import type { Principal } from "./principal.ts";
import { requireCompany } from "./principal.ts";

const SESSION_DAYS = 14;

/** Login throttling, per email. In-process on purpose: one server today, Redis when there are several. */
const attempts = new Map<string, { count: number; firstAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60_000;

function checkThrottle(email: string): void {
  const now = Date.now();
  const entry = attempts.get(email);
  if (!entry || now - entry.firstAt > WINDOW_MS) return;
  if (entry.count >= MAX_ATTEMPTS) {
    throw tooMany("Too many sign-in attempts. Wait 15 minutes and try again.");
  }
}

function recordFailure(email: string): void {
  const now = Date.now();
  const entry = attempts.get(email);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(email, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

export type SignedInSession = { token: string; csrfToken: string; expiresAt: string; user: User };

async function startSession(store: Store, user: User): Promise<SignedInSession> {
  const { token, tokenHash } = newSessionToken();
  const csrfToken = newCsrfToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  const session: Session = { userId: user.id, csrfToken, expiresAt };
  store.createSession(tokenHash, session);
  store.deleteExpiredSessions(new Date().toISOString());
  return { token, csrfToken, expiresAt, user };
}

export async function register(store: Store, body: unknown): Promise<SignedInSession> {
  const input = parseRegistrationInput(body);
  if (store.getUserByEmail(input.email)) {
    throw conflict("An account with that email already exists");
  }
  const company = store.createCompany({
    name: input.companyName,
    kind: input.companyKind,
    contactEmail: input.email,
    contactPhone: input.contactPhone,
    place: input.place,
    // Registration starts the trust process; an admin moves it forward.
    verificationStatus: "pending",
    verificationNotes: "",
    mcNumber: input.mcNumber,
    dotNumber: input.dotNumber,
    insuranceExpiresAt: null,
  });
  const user = store.createUser({
    email: input.email,
    name: input.name,
    role: input.companyKind,
    companyId: company.id,
    passwordHash: await hashPassword(input.password),
  });
  if (company.kind === "supplier") {
    // An empty profile makes the supplier visible to matching with honest gaps.
    store.putSupplierProfile({
      companyId: company.id,
      equipment: [],
      cargoTypes: [],
      serviceRegions: [`${input.place.country}-${input.place.region}`],
      lanes: [],
      capabilities: [],
      blackoutDates: [],
      maxWeightLbs: 0,
      ratePerMileCents: null,
      notes: "",
      updatedAt: new Date().toISOString(),
    });
  }
  return startSession(store, user);
}

export async function signIn(store: Store, body: unknown): Promise<SignedInSession> {
  const validator = new Validator(body);
  const email = validator.email("email");
  const password = validator.string("password", { min: 1, max: 200 });
  validator.done();

  checkThrottle(email);
  const record = store.getUserByEmail(email);
  // Verify against a dummy hash when the user is unknown so timing does not leak account existence.
  const hash = record?.passwordHash ?? (await dummyHash());
  const ok = await verifyPassword(password, hash);
  if (!record || !ok) {
    recordFailure(email);
    throw unauthorized("Email or password is incorrect");
  }
  attempts.delete(email);
  const at = new Date().toISOString();
  store.markLogin(record.id, at);
  const { passwordHash: _ignored, ...user } = record;
  return startSession(store, { ...user, lastLoginAt: at });
}

let dummyHashCache: string | null = null;
async function dummyHash(): Promise<string> {
  dummyHashCache ??= await hashPassword("password-that-is-never-valid");
  return dummyHashCache;
}

export function signOut(store: Store, token: string): void {
  store.deleteSession(hashToken(token));
}

export function resolvePrincipal(
  store: Store,
  token: string | null,
): { principal: Principal; session: Session } | null {
  if (!token) return null;
  const session = store.getSession(hashToken(token));
  if (!session) return null;
  if (Date.parse(session.expiresAt) < Date.now()) {
    store.deleteSession(hashToken(token));
    return null;
  }
  const user = store.getUserById(session.userId);
  if (!user) return null;
  return {
    principal: { user, company: user.companyId ? store.getCompany(user.companyId) : null },
    session,
  };
}

export function getSupplierProfile(store: Store, principal: Principal): SupplierProfile {
  const company = requireCompany(principal, "supplier");
  const profile = store.getSupplierProfile(company.id);
  if (!profile) throw badRequest("Supplier profile is missing");
  return profile;
}

export function updateSupplierProfile(
  store: Store,
  principal: Principal,
  body: unknown,
): SupplierProfile {
  const company = requireCompany(principal, "supplier");
  const validator = new Validator(body);
  const equipment = validator.manyOf("equipment", EQUIPMENT_TYPES);
  const cargoTypes = validator.manyOf("cargoTypes", CARGO_TYPES);
  const serviceRegions = validator.regionList("serviceRegions");
  const lanes = validator.lanes("lanes");
  const capabilities = validator.manyOf("capabilities", SPECIAL_REQUIREMENTS);
  const blackoutDates = validator.stringList("blackoutDates", { max: 120, itemMax: 10 });
  const maxWeightLbs = validator.integer("maxWeightLbs", { min: 0, max: 200_000 });
  const ratePerMile = validator.usdCents("ratePerMile", { optional: true });
  const notes = validator.string("notes", { optional: true, max: 1000 });
  for (const date of blackoutDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      validator.errors.blackoutDates ??= "Blackout dates must be YYYY-MM-DD";
    }
  }
  if (equipment.length === 0) validator.errors.equipment ??= "Add at least one equipment type";
  if (serviceRegions.length === 0)
    validator.errors.serviceRegions ??= "Add at least one region you serve";
  validator.done();

  return store.putSupplierProfile({
    companyId: company.id,
    equipment,
    cargoTypes,
    serviceRegions,
    lanes,
    capabilities,
    blackoutDates,
    maxWeightLbs,
    ratePerMileCents: ratePerMile,
    notes,
    updatedAt: new Date().toISOString(),
  });
}
