/**
 * Seeds an admin account, and optionally a small Puerto Rico corridor demo so
 * the marketplace has something to show on first run.
 *
 * Everything here goes through the same application layer the HTTP routes use,
 * so seeded data obeys the same rules as data a user creates.
 */

import { SqliteStore } from "./adapters/sqlite-store.ts";
import type { User } from "./domain/types.ts";
import type { Store } from "./ports/store.ts";
import { hashPassword } from "./security/passwords.ts";

export async function seedAdmin(store: Store, email: string, password: string): Promise<User> {
  const existing = store.getUserByEmail(email);
  if (existing) {
    const { passwordHash: _ignored, ...user } = existing;
    return user;
  }
  return store.createUser({
    email: email.toLowerCase(),
    name: "Platform Admin",
    role: "admin",
    companyId: null,
    passwordHash: await hashPassword(password),
  });
}

const DEMO_PASSWORD = "demo-password-1234";

export async function seedDemo(store: Store): Promise<void> {
  const { register, updateSupplierProfile } = await import("./app/accounts.ts");
  const { postShipment } = await import("./app/shipments.ts");
  const { submitQuote, acceptQuote } = await import("./app/quotes.ts");
  const { updateShipmentStatus } = await import("./app/shipments.ts");
  const principalOf = (user: User) => ({
    user,
    company: user.companyId ? store.getCompany(user.companyId) : null,
  });

  const shipper = principalOf(
    (
      await register(store, {
        email: "ops@islandgrocers.example",
        password: DEMO_PASSWORD,
        name: "Dana Ortiz",
        companyName: "Island Grocers",
        companyKind: "shipper",
        contactPhone: "305-555-0100",
        companyCity: "Miami",
        companyRegion: "FL",
        companyCountry: "US",
      })
    ).user,
  );

  const suppliers = [
    {
      email: "dispatch@caribelines.example",
      companyName: "Caribe Lines",
      city: "San Juan",
      region: "PR",
      profile: {
        equipment: ["dry_van", "container_40", "reefer"],
        cargoTypes: ["general_palletized", "refrigerated_food", "beverages"],
        serviceRegions: ["US-FL", "US-PR", "US-VI"],
        lanes: [{ origin: "US-FL", destination: "US-PR" }],
        capabilities: ["port_drayage", "appointment_required", "temperature_logging"],
        maxWeightLbs: 44000,
        ratePerMile: 1.95,
        notes: "Twice-weekly Jacksonville–San Juan sailings, own drayage in both ports.",
      },
      history: {
        completedShipments: 18,
        onTimeDeliveries: 17,
        lateDeliveries: 1,
        opportunitiesSeen: 30,
        quotesSubmitted: 24,
        responseSecondsTotal: 90_000,
        responsesCounted: 24,
      },
    },
    {
      email: "ops@borinquenfreight.example",
      companyName: "Borinquen Freight",
      city: "Ponce",
      region: "PR",
      profile: {
        equipment: ["dry_van", "flatbed", "box_truck"],
        cargoTypes: ["general_palletized", "building_materials", "machinery"],
        serviceRegions: ["US-PR"],
        lanes: [{ origin: "US-PR", destination: "US-PR" }],
        capabilities: ["liftgate", "port_drayage", "tarps"],
        maxWeightLbs: 40000,
        ratePerMile: 2.4,
        notes: "Island-wide distribution out of the Ponce port.",
      },
      history: {
        completedShipments: 6,
        onTimeDeliveries: 5,
        lateDeliveries: 1,
        opportunitiesSeen: 14,
        quotesSubmitted: 8,
        responseSecondsTotal: 120_000,
        responsesCounted: 8,
      },
    },
    {
      email: "quotes@antillanacargo.example",
      companyName: "Antillana Cargo",
      city: "Santo Domingo",
      region: "SD",
      profile: {
        equipment: ["container_20", "container_40", "reefer"],
        cargoTypes: ["general_palletized", "refrigerated_food", "frozen_food"],
        serviceRegions: ["DO-SD", "DO-ST", "US-PR"],
        lanes: [{ origin: "US-PR", destination: "DO-SD" }],
        capabilities: ["customs_clearance", "port_drayage", "temperature_logging"],
        maxWeightLbs: 48000,
        ratePerMile: 2.1,
        notes: "Customs brokerage in-house for DR imports.",
      },
      history: {
        completedShipments: 0,
        onTimeDeliveries: 0,
        lateDeliveries: 0,
        opportunitiesSeen: 3,
        quotesSubmitted: 1,
        responseSecondsTotal: 30_000,
        responsesCounted: 1,
      },
    },
  ];

  const supplierPrincipals = [];
  for (const supplier of suppliers) {
    const session = await register(store, {
      email: supplier.email,
      password: DEMO_PASSWORD,
      name: "Dispatch Desk",
      companyName: supplier.companyName,
      companyKind: "supplier",
      contactPhone: "787-555-0110",
      companyCity: supplier.city,
      companyRegion: supplier.region,
      companyCountry: supplier.region === "SD" ? "DO" : "US",
      mcNumber: "MC-000000",
    });
    const principal = principalOf(session.user);
    updateSupplierProfile(store, principal, supplier.profile);
    if (principal.company) {
      store.bumpSupplierStats(principal.company.id, supplier.history);
      // Demo suppliers are pre-verified so the trust states are visible side by side.
      store.setVerification(
        principal.company.id,
        supplier.history.completedShipments > 0 ? "verified" : "pending",
        supplier.history.completedShipments > 0
          ? "Authority and insurance on file"
          : "Awaiting insurance certificate",
      );
    }
    supplierPrincipals.push(principal);
  }

  const openLoad = postShipment(store, shipper, {
    originCity: "Miami",
    originRegion: "FL",
    originCountry: "US",
    destinationCity: "San Juan",
    destinationRegion: "PR",
    destinationCountry: "US",
    pickupFrom: nextWeek(0),
    pickupTo: nextWeek(1),
    deliverBy: nextWeek(8),
    cargoType: "general_palletized",
    cargoDescription: "8 pallets of shelf-stable groceries, stackable",
    palletCount: 8,
    weightLbs: 12000,
    equipment: "dry_van",
    specialRequirements: ["port_drayage"],
    targetPrice: 4500,
  });
  submitQuote(store, supplierPrincipals[0] as never, openLoad.id, {
    price: 4850,
    transitDays: 3,
    equipment: "dry_van",
    terms: "Net 30. Detention after 2 free hours.",
    note: "Space on Thursday's sailing.",
  });

  // A delivered shipment gives the rate engine a real comparable to work from.
  const pastLoad = postShipment(store, shipper, {
    originCity: "Jacksonville",
    originRegion: "FL",
    originCountry: "US",
    destinationCity: "San Juan",
    destinationRegion: "PR",
    destinationCountry: "US",
    pickupFrom: lastWeek(6),
    pickupTo: lastWeek(5),
    deliverBy: lastWeek(1),
    cargoType: "beverages",
    cargoDescription: "14 pallets of bottled water",
    palletCount: 14,
    weightLbs: 28000,
    equipment: "dry_van",
    specialRequirements: ["port_drayage"],
    targetPrice: 5200,
  });
  const pastQuote = submitQuote(store, supplierPrincipals[0] as never, pastLoad.id, {
    price: 5100,
    transitDays: 4,
    equipment: "dry_van",
    terms: "Net 30",
  });
  acceptQuote(store, shipper, pastQuote.id);
  for (const status of ["picked_up", "in_transit", "delivered"]) {
    updateShipmentStatus(store, supplierPrincipals[0] as never, pastLoad.id, { status });
  }
}

function nextWeek(offsetDays: number): string {
  return new Date(Date.now() + (7 + offsetDays) * 86_400_000).toISOString().slice(0, 10);
}

function lastWeek(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databasePath = process.env.FREIGHT_DB ?? "data/freight.db";
  const store = new SqliteStore(databasePath);
  const email = process.env.FREIGHT_ADMIN_EMAIL ?? "admin@freightmarket.local";
  const password = process.env.FREIGHT_ADMIN_PASSWORD;
  if (!password) {
    console.error("Set FREIGHT_ADMIN_PASSWORD (at least 12 characters) before seeding.");
    process.exit(1);
  }
  await seedAdmin(store, email, password);
  console.log(`admin ready: ${email}`);
  if (process.argv.includes("--demo")) {
    await seedDemo(store);
    console.log(`demo companies seeded, all with password "${DEMO_PASSWORD}"`);
  }
  store.close();
}
