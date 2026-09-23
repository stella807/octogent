/**
 * The HTTP surface. Each route parses its inputs, calls one use case and
 * returns plain data; authorization lives in the application layer so it holds
 * no matter which route reaches it.
 */

import {
  getSupplierProfile,
  register,
  signIn,
  signOut,
  updateSupplierProfile,
} from "../app/accounts.ts";
import { listCompanies, platformStats, setVerification } from "../app/admin.ts";
import { unauthorized } from "../app/errors.ts";
import { listThread, sendMessage } from "../app/messages.ts";
import { listOpportunities, parseFilters } from "../app/opportunities.ts";
import type { Principal } from "../app/principal.ts";
import {
  acceptQuote,
  counterQuote,
  declineQuote,
  listSupplierQuotes,
  submitQuote,
} from "../app/quotes.ts";
import {
  getMatches,
  getShipmentView,
  listShipments,
  postShipment,
  updateShipmentStatus,
} from "../app/shipments.ts";
import { knownRegions, regionName } from "../domain/geo.ts";
import {
  CARGO_EQUIPMENT_REQUIREMENTS,
  CARGO_TYPES,
  EQUIPMENT_TYPES,
  SPECIAL_REQUIREMENTS,
} from "../domain/types.ts";
import type { Session } from "../domain/types.ts";
import type { Store } from "../ports/store.ts";
import type { Route } from "./router.ts";

export type Ctx = {
  store: Store;
  principal: Principal | null;
  session: Session | null;
  body: unknown;
  query: URLSearchParams;
  /** Set by a route to start or end a session; the server turns it into cookies. */
  signIn: (result: { token: string; csrfToken: string; expiresAt: string }) => void;
  signOut: () => void;
};

function me(context: { principal: Principal | null }): Principal {
  if (!context.principal) throw unauthorized();
  return context.principal;
}

export const routes: Route<Ctx>[] = [
  {
    method: "GET",
    pattern: "/api/reference",
    handler: () => ({
      equipment: EQUIPMENT_TYPES,
      cargoTypes: CARGO_TYPES,
      specialRequirements: SPECIAL_REQUIREMENTS,
      cargoEquipmentRequirements: CARGO_EQUIPMENT_REQUIREMENTS,
      regions: knownRegions().map((key) => ({ key, name: regionName(key) })),
    }),
  },

  {
    method: "POST",
    pattern: "/api/auth/register",
    handler: async (context) => {
      const result = await register(context.store, context.body);
      context.signIn(result);
      return { user: result.user, csrfToken: result.csrfToken };
    },
  },
  {
    method: "POST",
    pattern: "/api/auth/login",
    handler: async (context) => {
      const result = await signIn(context.store, context.body);
      context.signIn(result);
      return { user: result.user, csrfToken: result.csrfToken };
    },
  },
  {
    method: "POST",
    pattern: "/api/auth/logout",
    handler: (context) => {
      context.signOut();
      return { ok: true };
    },
  },
  {
    method: "GET",
    pattern: "/api/me",
    auth: true,
    handler: (context) => {
      const principal = me(context);
      return {
        user: principal.user,
        company: principal.company,
        csrfToken: context.session?.csrfToken ?? null,
      };
    },
  },

  {
    method: "GET",
    pattern: "/api/supplier/profile",
    auth: true,
    handler: (context) => getSupplierProfile(context.store, me(context)),
  },
  {
    method: "PUT",
    pattern: "/api/supplier/profile",
    auth: true,
    handler: (context) => updateSupplierProfile(context.store, me(context), context.body),
  },
  {
    method: "GET",
    pattern: "/api/suppliers",
    auth: true,
    handler: (context) => {
      // The invite picker needs names and capabilities, never contact details.
      me(context);
      return context.store.listSupplierRecords().map(({ company, profile, stats }) => ({
        id: company.id,
        name: company.name,
        place: company.place,
        verificationStatus: company.verificationStatus,
        equipment: profile.equipment,
        serviceRegions: profile.serviceRegions,
        completedShipments: stats.completedShipments,
      }));
    },
  },

  {
    method: "GET",
    pattern: "/api/shipments",
    auth: true,
    handler: (context) => listShipments(context.store, me(context)),
  },
  {
    method: "POST",
    pattern: "/api/shipments",
    auth: true,
    handler: (context) => postShipment(context.store, me(context), context.body),
  },
  {
    method: "GET",
    pattern: "/api/shipments/:id",
    auth: true,
    handler: (context) => getShipmentView(context.store, me(context), context.params.id as string),
  },
  {
    method: "GET",
    pattern: "/api/shipments/:id/matches",
    auth: true,
    handler: (context) => getMatches(context.store, me(context), context.params.id as string),
  },
  {
    method: "POST",
    pattern: "/api/shipments/:id/status",
    auth: true,
    handler: (context) =>
      updateShipmentStatus(context.store, me(context), context.params.id as string, context.body),
  },
  {
    method: "POST",
    pattern: "/api/shipments/:id/quotes",
    auth: true,
    handler: (context) =>
      submitQuote(context.store, me(context), context.params.id as string, context.body),
  },
  {
    method: "GET",
    pattern: "/api/shipments/:id/threads/:supplierId",
    auth: true,
    handler: (context) =>
      listThread(
        context.store,
        me(context),
        context.params.id as string,
        context.params.supplierId as string,
      ),
  },
  {
    method: "POST",
    pattern: "/api/shipments/:id/threads/:supplierId",
    auth: true,
    handler: (context) =>
      sendMessage(
        context.store,
        me(context),
        context.params.id as string,
        context.params.supplierId as string,
        context.body,
      ),
  },

  {
    method: "GET",
    pattern: "/api/opportunities",
    auth: true,
    handler: (context) =>
      listOpportunities(context.store, me(context), parseFilters(context.query)),
  },
  {
    method: "GET",
    pattern: "/api/quotes",
    auth: true,
    handler: (context) => listSupplierQuotes(context.store, me(context)),
  },
  {
    method: "POST",
    pattern: "/api/quotes/:id/counter",
    auth: true,
    handler: (context) =>
      counterQuote(context.store, me(context), context.params.id as string, context.body),
  },
  {
    method: "POST",
    pattern: "/api/quotes/:id/accept",
    auth: true,
    handler: (context) => acceptQuote(context.store, me(context), context.params.id as string),
  },
  {
    method: "POST",
    pattern: "/api/quotes/:id/decline",
    auth: true,
    handler: (context) =>
      declineQuote(context.store, me(context), context.params.id as string, context.body),
  },

  {
    method: "GET",
    pattern: "/api/admin/companies",
    auth: true,
    handler: (context) => listCompanies(context.store, me(context)),
  },
  {
    method: "POST",
    pattern: "/api/admin/companies/:id/verification",
    auth: true,
    handler: (context) =>
      setVerification(context.store, me(context), context.params.id as string, context.body),
  },
  {
    method: "GET",
    pattern: "/api/admin/stats",
    auth: true,
    handler: (context) => platformStats(context.store, me(context)),
  },
];

export function logoutRoute(store: Store, token: string): void {
  signOut(store, token);
}
