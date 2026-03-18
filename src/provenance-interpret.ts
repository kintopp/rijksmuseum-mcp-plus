/**
 * Layer 2: Semantic interpretation of provenance events into ownership periods.
 *
 * Takes RawProvenanceEvent[] (Layer 1 output) and produces ProvenancePeriod[]:
 *   - Reconstructs ownership spans from event sequences
 *   - Infers end dates from next event's start date
 *   - Assigns buyer/seller roles
 *   - Parses temporal bounds from date expressions
 *   - Tracks derivation of every interpreted field
 */

import type { RawProvenanceEvent } from "./provenance-peg.js";
import type { ProvenanceParty, ProvenanceCitation } from "./provenance.js";

// ─── Types ──────────────────────────────────────────────────────────

/** Derivation tracking: maps field name → rule that produced it */
export type Derivation = Record<string, string>;

export interface ProvenancePeriod {
  sequence: number;
  owner: ProvenanceParty | null;
  location: string | null;

  acquisitionMethod: string | null;
  acquisitionFrom: ProvenanceParty | null;

  beginDate: string | null;
  beginYear: number | null;
  beginYearLatest: number | null;
  endDate: string | null;
  endYear: number | null;

  derivation: Derivation;

  uncertain: boolean;
  citations: ProvenanceCitation[];
  sourceEvents: number[];
}

// ─── Temporal bound parsing ─────────────────────────────────────────

/**
 * Parse a date expression into two bounds: earliest and latest plausible year.
 *
 * | Expression       | earliest | latest |
 * |------------------|----------|--------|
 * | "1808"           | 1808     | 1808   |
 * | "by 1960"        | null     | 1960   |
 * | "after 1945"     | 1945     | null   |
 * | "ca. 1700"       | ~1690    | ~1710  |
 * | "before 1800"    | null     | 1800   |
 * | "16 May 1696"    | 1696     | 1696   |
 */
export function parseTemporalBounds(
  expr: string | null,
  year: number | null,
  qualifier: string | null
): { earliest: number | null; latest: number | null; rule: string } {
  if (!year && !expr) return { earliest: null, latest: null, rule: "no_date" };

  if (qualifier === "before") {
    return { earliest: null, latest: year, rule: "before_year" };
  }
  if (qualifier === "after") {
    return { earliest: year, latest: null, rule: "after_year" };
  }
  if (qualifier === "circa" && year) {
    return { earliest: year - 10, latest: year + 10, rule: "circa_year" };
  }

  // "by YYYY" pattern (not captured as qualifier by Layer 1, but present in expression)
  if (expr) {
    const byMatch = expr.match(/\bby\s+(\d{4})\b/i);
    if (byMatch) {
      return { earliest: null, latest: parseInt(byMatch[1], 10), rule: "by_year" };
    }
  }

  // Exact or bare year
  if (year) {
    return { earliest: year, latest: year, rule: "exact_year" };
  }

  return { earliest: null, latest: null, rule: "unparsed" };
}

// ─── Role assignment ────────────────────────────────────────────────

interface RoleAssignment {
  owner: ProvenanceParty | null;
  acquisitionFrom: ProvenanceParty | null;
  ownerRule: string;
  fromRule: string;
}

/**
 * Assign owner and acquisition-source roles based on event type and parties.
 */
function assignRoles(event: RawProvenanceEvent): RoleAssignment {
  const parties = event.parties;
  const noParty: RoleAssignment = {
    owner: null, acquisitionFrom: null,
    ownerRule: "no_parties", fromRule: "no_parties",
  };

  if (!parties.length) return noParty;

  switch (event.transferType) {
    case "sale": {
      const seller = parties.find(p => p.role === "seller");
      const buyer = parties.find(p => p.role === "buyer");
      if (buyer && seller) {
        return { owner: buyer, acquisitionFrom: seller, ownerRule: "buyer_clause", fromRule: "seller_clause" };
      }
      if (buyer) {
        return { owner: buyer, acquisitionFrom: null, ownerRule: "buyer_clause", fromRule: "no_seller" };
      }
      if (seller) {
        // In sale events where only the seller is named, the seller is the period's owner
        // (the sale ends their period). Layer 2 can't know the buyer without the next event.
        return { owner: seller, acquisitionFrom: null, ownerRule: "seller_as_owner", fromRule: "no_buyer" };
      }
      return noParty;
    }

    case "purchase": {
      const buyer = parties.find(p => p.role === "buyer") || parties[0];
      return { owner: buyer, acquisitionFrom: null, ownerRule: "purchase_buyer", fromRule: "no_seller" };
    }

    case "bequest":
    case "inheritance": {
      const heir = parties.find(p => p.role === "heir" || p.role?.includes("son") || p.role?.includes("daughter")
        || p.role?.includes("widow") || p.role?.includes("nephew") || p.role?.includes("grandson")
        || p.role?.includes("granddaughter") || p.role?.includes("husband") || p.role?.includes("widower"));
      return {
        owner: heir || parties[0],
        acquisitionFrom: null,
        ownerRule: heir ? "heir_role" : "first_party",
        fromRule: "no_source",
      };
    }

    case "gift": {
      const donor = parties.find(p => p.role === "donor");
      const recipient = parties.find(p => p.role === "recipient");
      if (recipient) {
        return { owner: recipient, acquisitionFrom: donor || null, ownerRule: "gift_recipient", fromRule: donor ? "gift_donor" : "no_donor" };
      }
      // If only donor, they are the source (the recipient is in the next event)
      if (donor) {
        return { owner: null, acquisitionFrom: donor, ownerRule: "no_recipient", fromRule: "gift_donor" };
      }
      return { owner: parties[0], acquisitionFrom: null, ownerRule: "first_party", fromRule: "no_source" };
    }

    case "commission": {
      const patron = parties.find(p => p.role === "patron");
      return { owner: patron || parties[0], acquisitionFrom: null, ownerRule: patron ? "patron_role" : "first_party", fromRule: "no_source" };
    }

    case "collection": {
      const collector = parties.find(p => p.role === "collector" || p.role === "deceased");
      return { owner: collector || parties[0], acquisitionFrom: null, ownerRule: collector ? "collector_role" : "first_party", fromRule: "no_source" };
    }

    default: {
      return { owner: parties[0], acquisitionFrom: null, ownerRule: "first_party", fromRule: "no_source" };
    }
  }
}

// ─── Period reconstruction ──────────────────────────────────────────

/**
 * Transform Layer 1 events into Layer 2 ownership periods.
 * Skips cross-reference events.
 */
export function interpretPeriods(events: RawProvenanceEvent[]): ProvenancePeriod[] {
  const substantive = events.filter(e => !e.isCrossRef);
  const periods: ProvenancePeriod[] = [];

  for (let i = 0; i < substantive.length; i++) {
    const event = substantive[i];
    const next = i + 1 < substantive.length ? substantive[i + 1] : null;

    const roles = assignRoles(event);
    const temporal = parseTemporalBounds(event.dateExpression, event.dateYear, event.dateQualifier);

    // Infer end date from next event's start date
    let endYear: number | null = null;
    let endDate: string | null = null;
    const derivation: Derivation = {};

    if (roles.owner) derivation.owner = roles.ownerRule;
    if (roles.acquisitionFrom) derivation.acquisition_from = roles.fromRule;
    if (temporal.earliest !== null || temporal.latest !== null) {
      derivation.begin_year = temporal.rule;
    }

    if (next) {
      const nextTemporal = parseTemporalBounds(next.dateExpression, next.dateYear, next.dateQualifier);
      if (nextTemporal.earliest !== null) {
        endYear = nextTemporal.earliest;
        endDate = next.dateExpression;
        derivation.end_year = "inferred_from_next";
      }
    }

    if (event.location) derivation.location = "explicit";

    periods.push({
      sequence: i + 1,
      owner: roles.owner,
      location: event.location,
      acquisitionMethod: event.transferType,
      acquisitionFrom: roles.acquisitionFrom,
      beginDate: event.dateExpression,
      beginYear: temporal.earliest,
      beginYearLatest: temporal.latest,
      endDate,
      endYear,
      derivation,
      uncertain: event.uncertain,
      citations: event.citations,
      sourceEvents: [event.sequence],
    });
  }

  return periods;
}
