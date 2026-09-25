/*
 * kyc-aml realm functions — deterministic half of the KYC + AML pipeline.
 *
 * Ported from meta-agent kycdemo (BaselineKycRiskMethodologyRule.kt, AmlRiskMethodology.kt,
 * RequiredSubjectFieldsRule, and the amend/final-risk steps of KycAmlRiskPipelineIntegrationTest).
 *
 * Two parts of the pipeline are deliberately NOT here, and run in the kyc-screen-certificate lens:
 * - the LLM steps (KycCase extraction, candidate disposition): a wasm handler is granted
 *   cypher_query only;
 * - sanctions matching: scoring the ~10k list records of a subject type is milliseconds in the
 *   lens's sandbox and measured at well over the 30s dispatch budget here, where both moving the
 *   list across the host boundary and interpreting the matcher dominate.
 *
 * All policy numbers are demo calibration values, not regulatory constants.
 */

// ── policy (AmlRiskMethodology, KycRiskScoringMethodology) ─────────────────────────────────────

const AML = {
  highRiskConfidenceThreshold: 0.6,
  mediumRiskConfidenceThreshold: 0.4,
  rejectCadence: "before any override request and at each list update",
  highRiskCadence: "every 3 months until AML disposition is cleared; then follow high-risk periodic review schedule",
  mediumRiskCadence: "every 6 months",
  lowRiskCadence: "every 12 months",
  unknownRiskCadence: "manual cadence required because risk remains unknown",
};

const LEVEL_SCORE = { LOW: 20, MEDIUM: 55, HIGH: 90, UNKNOWN: 50 };
const FACTOR_WEIGHT = {
  GEOGRAPHY: 15, OWNERSHIP: 30, DOCUMENT_QUALITY: 10, SOURCE_OF_FUNDS: 15, SOURCE_OF_WEALTH: 15, SANCTIONS: 15,
};
const factorWeight = (type) => FACTOR_WEIGHT[type] ?? 10;

const SCORING_DESCRIPTION =
  "Aggregate risk formula: assign each factor a categorical level LOW, MEDIUM, HIGH, or UNKNOWN and a weighted " +
  "numeric contribution. Numeric score is the weighted average rounded to 0-100. Categorical overall risk remains " +
  "conservative: HIGH if any factor is HIGH; otherwise MEDIUM if any factor is MEDIUM; otherwise UNKNOWN if any " +
  "factor is UNKNOWN; otherwise LOW.";

const LOW_RISK_JURISDICTIONS = new Set(["IE", "GB", "FR", "DE", "NL", "ES", "IT", "SE", "NO", "DK", "FI", "BE", "LU", "AT", "PT"]);
const MEDIUM_RISK_JURISDICTIONS = new Set(["HK"]);

// ── countries ────────────────────────────────────────────────────────────────────────────────────

// Same table as scripts/build-ofac-reference.py, plus common spellings a certificate may use.
const COUNTRY_CODES = {
  "AFGHANISTAN": "AF", "ALBANIA": "AL", "ALGERIA": "DZ", "ANGOLA": "AO",
  "ANTIGUA AND BARBUDA": "AG", "ARGENTINA": "AR", "ARMENIA": "AM", "ARUBA": "AW",
  "AUSTRALIA": "AU", "AUSTRIA": "AT", "AZERBAIJAN": "AZ", "BAHAMAS": "BS", "BAHAMAS, THE": "BS",
  "BAHRAIN": "BH", "BANGLADESH": "BD", "BARBADOS": "BB", "BELARUS": "BY", "BELGIUM": "BE",
  "BELIZE": "BZ", "BENIN": "BJ", "BERMUDA": "BM", "BOLIVIA": "BO", "BOSNIA AND HERZEGOVINA": "BA",
  "BRAZIL": "BR", "BULGARIA": "BG", "BURKINA FASO": "BF", "BURMA": "MM", "CABO VERDE": "CV",
  "CAMBODIA": "KH", "CAMEROON": "CM", "CANADA": "CA", "CAYMAN ISLANDS": "KY",
  "CENTRAL AFRICAN REPUBLIC": "CF", "CHAD": "TD", "CHILE": "CL", "CHINA": "CN", "COLOMBIA": "CO",
  "COMOROS": "KM", "CONGO, DEMOCRATIC REPUBLIC OF THE": "CD", "CONGO, REPUBLIC OF THE": "CG",
  "COSTA RICA": "CR", "COTE D IVOIRE": "CI", "CROATIA": "HR", "CUBA": "CU", "CYPRUS": "CY",
  "CZECH REPUBLIC": "CZ", "CZECHIA": "CZ", "DENMARK": "DK", "DJIBOUTI": "DJ", "DOMINICA": "DM",
  "DOMINICAN REPUBLIC": "DO", "ECUADOR": "EC", "EGYPT": "EG", "EL SALVADOR": "SV",
  "EQUATORIAL GUINEA": "GQ", "ERITREA": "ER", "ESTONIA": "EE", "ETHIOPIA": "ET", "FIJI": "FJ",
  "FINLAND": "FI", "FRANCE": "FR", "GAMBIA": "GM", "GEORGIA": "GE", "GERMANY": "DE", "GHANA": "GH",
  "GIBRALTAR": "GI", "GREECE": "GR", "GUATEMALA": "GT", "GUINEA": "GN", "GUINEA-BISSAU": "GW",
  "GUYANA": "GY", "HAITI": "HT", "HONDURAS": "HN", "HONG KONG": "HK", "HUNGARY": "HU",
  "ICELAND": "IS", "INDIA": "IN", "INDONESIA": "ID", "IRAN": "IR", "IRAQ": "IQ", "IRELAND": "IE",
  "ISRAEL": "IL", "ITALY": "IT", "JAMAICA": "JM", "JAPAN": "JP", "JERSEY": "JE", "JORDAN": "JO",
  "KAZAKHSTAN": "KZ", "KENYA": "KE", "KOREA, NORTH": "KP", "KOREA, SOUTH": "KR", "KOSOVO": "XK",
  "KUWAIT": "KW", "KYRGYZSTAN": "KG", "LAOS": "LA", "LATVIA": "LV", "LEBANON": "LB",
  "LIBERIA": "LR", "LIBYA": "LY", "LIECHTENSTEIN": "LI", "LITHUANIA": "LT", "LUXEMBOURG": "LU",
  "MACAU": "MO", "MALAYSIA": "MY", "MALDIVES": "MV", "MALI": "ML", "MALTA": "MT",
  "MAN, ISLE OF": "IM", "MARSHALL ISLANDS": "MH", "MAURITANIA": "MR", "MAURITIUS": "MU",
  "MEXICO": "MX", "MOLDOVA": "MD", "MONACO": "MC", "MONGOLIA": "MN", "MONTENEGRO": "ME",
  "MOROCCO": "MA", "MOZAMBIQUE": "MZ", "MYANMAR": "MM", "NAMIBIA": "NA", "NETHERLANDS": "NL",
  "NETHERLANDS ANTILLES": "AN", "NEW ZEALAND": "NZ", "NICARAGUA": "NI", "NIGER": "NE",
  "NIGERIA": "NG", "NORTH MACEDONIA": "MK", "NORTH MACEDONIA, THE REPUBLIC OF": "MK",
  "NORWAY": "NO", "OMAN": "OM", "PAKISTAN": "PK", "PALAU": "PW", "PALESTINIAN": "PS",
  "PANAMA": "PA", "PARAGUAY": "PY", "PERU": "PE", "PHILIPPINES": "PH", "POLAND": "PL",
  "PORTUGAL": "PT", "QATAR": "QA", "ROMANIA": "RO", "RUSSIA": "RU", "RWANDA": "RW",
  "SAINT KITTS AND NEVIS": "KN", "SAINT VINCENT AND THE GRENADINES": "VC", "SAMOA": "WS",
  "SAN MARINO": "SM", "SAUDI ARABIA": "SA", "SENEGAL": "SN", "SERBIA": "RS", "SEYCHELLES": "SC",
  "SIERRA LEONE": "SL", "SINGAPORE": "SG", "SLOVAKIA": "SK", "SLOVENIA": "SI", "SOMALIA": "SO",
  "SOUTH AFRICA": "ZA", "SOUTH SUDAN": "SS", "SPAIN": "ES", "SRI LANKA": "LK", "SUDAN": "SD",
  "SURINAME": "SR", "SWEDEN": "SE", "SWITZERLAND": "CH", "SYRIA": "SY", "TAIWAN": "TW",
  "TAJIKISTAN": "TJ", "TANZANIA": "TZ", "THAILAND": "TH", "THE GAMBIA": "GM", "TOGO": "TG",
  "TRINIDAD AND TOBAGO": "TT", "TUNISIA": "TN", "TURKEY": "TR", "TURKIYE": "TR",
  "TURKMENISTAN": "TM", "UGANDA": "UG", "UKRAINE": "UA", "UNITED ARAB EMIRATES": "AE",
  "UNITED KINGDOM": "GB", "UNITED STATES": "US", "URUGUAY": "UY", "UZBEKISTAN": "UZ",
  "VANUATU": "VU", "VENEZUELA": "VE", "VIETNAM": "VN", "VIRGIN ISLANDS, BRITISH": "VG",
  "WEST BANK": "PS", "YEMEN": "YE", "ZAMBIA": "ZM", "ZIMBABWE": "ZW",
  "HONG KONG SAR": "HK", "HONG KONG SAR CHINA": "HK", "HONG KONG, CHINA": "HK", "UK": "GB",
  "GREAT BRITAIN": "GB", "ENGLAND": "GB", "ENGLAND AND WALES": "GB", "SCOTLAND": "GB", "USA": "US",
  "UNITED STATES OF AMERICA": "US", "PEOPLE'S REPUBLIC OF CHINA": "CN", "PRC": "CN",
  "BRITISH VIRGIN ISLANDS": "VG", "BVI": "VG", "UAE": "AE", "RUSSIAN FEDERATION": "RU",
  "SOUTH KOREA": "KR", "REPUBLIC OF KOREA": "KR", "NORTH KOREA": "KP", "MACAO": "MO",
};

function countryCode(value) {
  const v = String(value || "").trim().toUpperCase();
  if (!v) return "";
  if (/^[A-Z]{2}$/.test(v)) return v;
  return COUNTRY_CODES[v] || v;
}


// ── risk (BaselineKycRiskMethodologyRule.kt) ────────────────────────────────────────────────────

const subjectOf = (kycCase) => (kycCase && kycCase.subject) || {};
const evidenceOf = (kycCase) => (kycCase && kycCase.evidence) || [];
const hasEvidence = (kycCase, type) => evidenceOf(kycCase).some((e) => e && e.type === type);

function certificateEvidence(kycCase, excerpt) {
  const cert = evidenceOf(kycCase).find((e) => e && e.type === "CERTIFICATE_OF_INCORPORATION");
  return cert ? { documentId: cert.documentId || cert.fileName || "certificate", page: 1, excerpt, confidence: 0.9 } : null;
}

function jurisdictionLevel(code) {
  if (LOW_RISK_JURISDICTIONS.has(code)) return "LOW";
  if (MEDIUM_RISK_JURISDICTIONS.has(code)) return "MEDIUM";
  return "UNKNOWN";
}

function baselineFactors(kycCase) {
  const subject = subjectOf(kycCase);
  const factors = [];
  const jurisdiction = countryCode(subject.jurisdictionOfIncorporation);
  if (jurisdiction) {
    const level = jurisdictionLevel(jurisdiction);
    factors.push({
      type: "GEOGRAPHY", level,
      rationale: `Jurisdiction of incorporation is ${jurisdiction}; demo country-risk methodology classifies it as ${level} based on the configured country risk table.`,
      evidence: certificateEvidence(kycCase, `Certificate identifies jurisdiction of incorporation as ${jurisdiction}.`),
    });
  }
  const owned = ((kycCase && kycCase.ownership) || []).length > 0;
  factors.push({
    type: "OWNERSHIP", level: owned ? "LOW" : "HIGH",
    rationale: owned ? "Beneficial ownership or control evidence is present."
      : "No beneficial ownership or control evidence is present in the supplied KYC package.",
  });
  const cert = hasEvidence(kycCase, "CERTIFICATE_OF_INCORPORATION");
  factors.push({
    type: "DOCUMENT_QUALITY", level: cert ? "LOW" : "MEDIUM",
    rationale: cert ? "Certificate of incorporation evidence is present and contains extractable structured facts."
      : "No certificate of incorporation evidence is present.",
    evidence: certificateEvidence(kycCase, "Certificate of incorporation evidence is present and contains extractable structured facts."),
  });
  for (const [type, label] of [["SOURCE_OF_FUNDS", "Source-of-funds"], ["SOURCE_OF_WEALTH", "Source-of-wealth"]]) {
    const present = hasEvidence(kycCase, type);
    factors.push({
      type, level: present ? "LOW" : "MEDIUM",
      rationale: present ? `${label} evidence is present.` : `${label} evidence is not present in the supplied KYC package.`,
    });
  }
  const screened = new Set(((kycCase && kycCase.screeningResults) || []).map((r) => r.type));
  const all = ["SANCTIONS", "PEP", "ADVERSE_MEDIA", "INTERNAL_WATCHLIST"].every((t) => screened.has(t));
  factors.push({
    type: "SANCTIONS", level: all ? "LOW" : "UNKNOWN",
    rationale: all ? "AML screening results are present for sanctions, PEP, adverse media, and internal watchlist checks."
      : "AML screening has not yet been performed at baseline; sanctions, PEP, adverse-media, and watchlist risk remain unassessed.",
  });
  return factors;
}

function aggregateScore(factors) {
  const total = factors.reduce((s, f) => s + factorWeight(f.type), 0);
  if (!total) return LEVEL_SCORE.UNKNOWN;
  return Math.trunc(factors.reduce((s, f) => s + LEVEL_SCORE[f.level] * factorWeight(f.type), 0) / total);
}

function overallRisk(factors) {
  for (const level of ["HIGH", "MEDIUM", "UNKNOWN"]) if (factors.some((f) => f.level === level)) return level;
  return "LOW";
}

function scoreBreakdown(factors) {
  return factors.map((f) => ({
    type: f.type, level: f.level, levelScore: LEVEL_SCORE[f.level], weight: factorWeight(f.type),
    weightedPoints: LEVEL_SCORE[f.level] * factorWeight(f.type),
  }));
}

function riskAssessment(factors, rationale, methodologySuffix) {
  return {
    overallRisk: overallRisk(factors),
    score: aggregateScore(factors),
    factors,
    breakdown: scoreBreakdown(factors),
    rationale,
    methodology: SCORING_DESCRIPTION + " " + methodologySuffix,
  };
}

// RequiredSubjectFieldsRule.kt
function requiredFieldIssues(kycCase) {
  const s = subjectOf(kycCase);
  const issues = [];
  if (!String(s.displayName || "").trim()) {
    issues.push({ severity: "ERROR", code: "DISPLAY_NAME_MISSING", message: "Subject display name is required", fieldPath: "subject.displayName" });
  }
  if ((s.partyType || "legalEntity") === "legalEntity") {
    if (!String(s.registrationNumber || "").trim()) {
      issues.push({ severity: "ERROR", code: "REGISTRATION_NUMBER_MISSING", message: "Legal entity registration number is required", fieldPath: "subject.registrationNumber" });
    }
    if (!String(s.jurisdictionOfIncorporation || "").trim()) {
      issues.push({ severity: "ERROR", code: "INCORPORATION_JURISDICTION_MISSING", message: "Jurisdiction of incorporation is required", fieldPath: "subject.jurisdictionOfIncorporation" });
    }
  }
  return issues;
}

const mergeIssues = (existing, added) => {
  const codes = new Set(existing.map((i) => i.code));
  return existing.concat(added.filter((i) => !codes.has(i.code)));
};

export async function assessBaselineRisk(input, ctx) {
  const kycCase = input && input.kycCase;
  if (!kycCase || !kycCase.subject) throw new Error("kycCase with a subject is required");
  const risk = riskAssessment(
    baselineFactors(kycCase),
    "Baseline pre-screening KYC risk is composed from geography, ownership/control, document quality, source-of-funds, source-of-wealth, and AML-screening readiness factors.",
    "Baseline assessment uses a pre-screening AML/SANCTIONS factor of UNKNOWN until screening is performed.",
  );
  return {
    riskAssessment: risk,
    issues: mergeIssues(kycCase.issues || [], requiredFieldIssues(kycCase)),
    screeningSubject: screeningSubjectFor(kycCase),
  };
}

// The ScreeningSubject the test builds from a legal-entity KycCase, generalized to persons.
function screeningSubjectFor(kycCase) {
  const s = subjectOf(kycCase);
  const isPerson = s.partyType === "person";
  const countries = isPerson ? (s.nationalities || []) : [s.jurisdictionOfIncorporation].filter(Boolean);
  const identifiers = [];
  if (!isPerson && s.registrationNumber) {
    identifiers.push({ type: "COMPANY_REGISTRATION_NUMBER", value: s.registrationNumber, issuingCountry: s.jurisdictionOfIncorporation || null });
  }
  return {
    id: s.id || "",
    displayName: s.displayName || "",
    subjectType: isPerson ? "PERSON" : "LEGAL_ENTITY",
    dateOfBirth: isPerson ? (s.dateOfBirth || null) : null,
    countries: countries.map(countryCode).filter(Boolean),
    identifiers,
  };
}

// ── amend + final risk (KycAmlRiskPipelineIntegrationTest.amendKycCase / finalRiskAssessment) ────

function mergeTreatment(candidate) {
  if (candidate.recommendedDisposition === "CONFIRMED_MATCH" || candidate.confidenceLevel === "HIGH") {
    return "confirmed AML identity enrichment";
  }
  if (candidate.recommendedDisposition === "POSSIBLE_MATCH" || candidate.confidenceLevel === "MEDIUM") {
    return "provisional AML enrichment for manual review";
  }
  return "screening evidence retained without identity merge";
}

function sanctionsRiskLevel(candidate) {
  if (candidate.recommendedDisposition === "CONFIRMED_MATCH") return "HIGH";
  if (candidate.confidenceScore >= AML.highRiskConfidenceThreshold) return "HIGH";
  if (candidate.confidenceScore >= AML.mediumRiskConfidenceThreshold) return "MEDIUM";
  return "UNKNOWN";
}

const KYC_SCREENING_STATUS = { CONFIRMED_MATCH: "CONFIRMED_MATCH", POSSIBLE_MATCH: "POSSIBLE_MATCH", LIKELY_FALSE_POSITIVE: "CLEAR" };

function hitFor(screening, candidate) {
  const hits = screening.hits || [];
  const byId = hits.find((h) => h.sourceRecordId === String(candidate.sourceRecordId) || h.entryId === String(candidate.sourceRecordId));
  if (byId) return byId;
  const name = String(candidate.candidateName || "").toLowerCase();
  const byName = hits.find((h) => h.primaryName.toLowerCase() === name || h.matchedName.toLowerCase() === name);
  if (byName) return byName;
  throw new Error(`No screening hit found for LLM candidate ${candidate.sourceRecordId} / '${candidate.candidateName}'. ` +
    `Available hits: ${hits.map((h) => `${h.sourceRecordId} '${h.primaryName}'`).join(", ")}`);
}

function addressLine(a) {
  if (!a) return "";
  const line1 = a.line1 || "";
  const suffix = [a.city, a.region, a.postalCode, a.countryCode]
    .filter((x) => x && x !== "N/A" && !line1.toLowerCase().includes(String(x).toLowerCase()));
  return [line1, a.line2].filter(Boolean).concat(suffix).join(", ");
}

function mergeDecision(kycCase, hit, candidate) {
  const s = subjectOf(kycCase);
  const treatment = mergeTreatment(candidate);
  const kycAddresses = (s.addresses || []).map(addressLine).filter(Boolean);
  const listAddresses = hit.addresses.length ? hit.addresses : ["not available in list record"];
  const missing = (candidate.missingEvidence || []).length ? candidate.missingEvidence.join(", ") : "none stated";
  return {
    sourceRecordId: hit.sourceRecordId,
    entryId: hit.entryId,
    treatment,
    rationale:
      `Merge treatment: ${treatment} based on LLM confidence ${candidate.confidenceScore}/${candidate.confidenceLevel} ` +
      `and disposition ${candidate.recommendedDisposition}. KYC subject name='${s.displayName}'. ` +
      `List primary name='${hit.primaryName}'. Matched alias/name='${hit.matchedName}'. ` +
      `KYC registration='${s.registrationNumber || ""}'. List identifiers='${hit.identifiers.join(" ") || "none listed"}'. ` +
      `KYC addresses='${kycAddresses.join(" | ") || "not present in KYC case"}'. List addresses='${listAddresses.join(" | ")}'. ` +
      `Conflicts/missing evidence: ${missing}. ${candidate.rationale || ""}`,
    evidenceExcerpt:
      `KYC '${s.displayName}' screened against ${hit.source} '${hit.primaryName}' using matched alias '${hit.matchedName}'. ` +
      `Treatment=${treatment}; confidence=${candidate.confidenceScore}/${candidate.confidenceLevel}; disposition=${candidate.recommendedDisposition}.`,
  };
}

function periodicCadence(amlStatus, risk) {
  if (amlStatus === "REJECT") return AML.rejectCadence;
  if (amlStatus === "MANUAL_REVIEW_REQUIRED" || risk === "HIGH") return AML.highRiskCadence;
  if (risk === "MEDIUM") return AML.mediumRiskCadence;
  if (risk === "LOW") return AML.lowRiskCadence;
  return AML.unknownRiskCadence;
}

function manualDisposition(amlStatus) {
  if (amlStatus === "REJECT") return "required for rejection approval and audit record";
  if (amlStatus === "MANUAL_REVIEW_REQUIRED") return "required before approval because one or more AML candidates remain possible matches";
  return "not required by AML screening result";
}

function recommendationFor(amlStatus, primary, risk) {
  if (primary && primary.recommendedDisposition === "CONFIRMED_MATCH") return "REJECT";
  if (amlStatus === "MANUAL_REVIEW_REQUIRED" || risk === "HIGH") return "ENHANCED_DUE_DILIGENCE";
  if (risk === "LOW") return "APPROVE";
  return "MANUAL_REVIEW";
}

function eddActions(kycCase) {
  const s = subjectOf(kycCase);
  const needs = [];
  if (!((kycCase.ownership || []).length)) needs.push("beneficial ownership");
  if (!s.registrationNumber) needs.push("registration number");
  needs.push("registration corroboration");
  if (!(s.addresses || []).length) needs.push("address evidence");
  if (!hasEvidence(kycCase, "SOURCE_OF_FUNDS")) needs.push("source-of-funds evidence");
  if (!hasEvidence(kycCase, "SOURCE_OF_WEALTH")) needs.push("source-of-wealth evidence");
  return `Obtain ${needs.join(", ")} before onboarding decision`;
}

export async function amendCase(input, ctx) {
  const kycCase = input && input.kycCase;
  const screening = input && input.screening;
  const aml = (input && input.amlAssessment) || { candidateAssessments: [] };
  if (!kycCase || !kycCase.subject) throw new Error("kycCase with a subject is required");
  if (!screening) throw new Error("screening (the sanctions screening result: subject, status, hits, candidatesExamined) is required");

  const candidates = (aml.candidateAssessments || []).map((c) => ({
    ...c,
    sourceRecordId: String(c.sourceRecordId),
    confidenceScore: Math.min(1, Math.max(0, Number(c.confidenceScore) || 0)),
  }));
  const s = subjectOf(kycCase);
  const now = new Date().toISOString();

  const merges = candidates.map((c) => ({ candidate: c, hit: hitFor(screening, c) }))
    .map(({ candidate, hit }) => ({ candidate, hit, merge: mergeDecision(kycCase, hit, candidate) }));
  const screeningResults = merges.map(({ candidate, hit, merge }) => ({
    partyId: s.id,
    type: "SANCTIONS",
    status: KYC_SCREENING_STATUS[candidate.recommendedDisposition] || "MANUAL_REVIEW_REQUIRED",
    provider: hit.source === "OFAC_SANCTIONS" ? "OFAC" : hit.source,
    matchScore: candidate.confidenceScore,
    rationale: merge.rationale,
    evidence: { documentId: hit.entryId, page: 1, excerpt: merge.evidenceExcerpt, confidence: candidate.confidenceScore },
    screenedAt: now,
  }));
  if (!screeningResults.length) {
    screeningResults.push({
      partyId: s.id, type: "SANCTIONS", status: "CLEAR", provider: "OFAC", matchScore: 0,
      rationale: `No sanctions list record matched above the name threshold (${screening.candidatesExamined} candidates examined).`,
      screenedAt: now,
    });
  }

  const primary = candidates.slice().sort((a, b) => b.confidenceScore - a.confidenceScore)[0] || null;
  const primaryMerge = primary ? merges.find((m) => m.candidate === primary) : null;
  const amlStatus = aml.overallStatus || screening.status;

  const retained = baselineFactors(kycCase).filter((f) => f.type !== "SANCTIONS");
  const sanctionsFactor = primary
    ? {
      type: "SANCTIONS",
      level: sanctionsRiskLevel(primary),
      rationale:
        `Sanctions screening produced ${screening.hits.length} candidate hit(s). The highest-confidence LLM assessment is ` +
        `${primary.confidenceScore}/${primary.confidenceLevel} with disposition ${primary.recommendedDisposition}` +
        (primary.recommendedDisposition === "CONFIRMED_MATCH" ? "." : "; manual review is required before identity confirmation."),
      evidence: { documentId: primaryMerge.hit.entryId, page: 1, excerpt: primaryMerge.merge.evidenceExcerpt, confidence: primary.confidenceScore },
    }
    : {
      type: "SANCTIONS",
      level: "LOW",
      rationale: `Sanctions screening found no list record above the name threshold (${screening.candidatesExamined} candidates examined).`,
    };
  const factors = retained.concat(sanctionsFactor);
  const finalRisk = riskAssessment(
    factors,
    primary
      ? `Final risk recomputed after AML enrichment. Primary AML concern '${primary.candidateName}' (${primary.confidenceScore}/${primary.confidenceLevel}, ${primary.recommendedDisposition}) sets the sanctions factor to ${sanctionsFactor.level}.`
      : "Final risk recomputed after AML enrichment. No sanctions candidates, so the sanctions factor is LOW.",
    "Final AML-adjusted risk starts from baseline KYC factors, replaces the pre-screening sanctions readiness factor with LLM-dispositioned AML sanctions risk, applies merge rules based on LLM confidence/disposition, and recomputes the cross-factor weighted 0-100 score.",
  );
  const recommendation = recommendationFor(amlStatus, primary, finalRisk.overallRisk);

  const added = requiredFieldIssues(kycCase);
  if (primary && primary.recommendedDisposition === "CONFIRMED_MATCH") {
    added.push({ severity: "ERROR", code: "CONFIRMED_SANCTIONS_MATCH", message: `Sanctions match '${primary.candidateName}' is confirmed.`, fieldPath: "screeningResults" });
  } else if (primary && primary.recommendedDisposition === "POSSIBLE_MATCH") {
    added.push({ severity: "WARNING", code: "POSSIBLE_SANCTIONS_MATCH", message: `Primary AML concern '${primary.candidateName}' requires manual review.`, fieldPath: "screeningResults" });
  }

  return {
    kycCase: {
      ...kycCase,
      screeningResults: (kycCase.screeningResults || []).concat(screeningResults),
      riskAssessment: finalRisk,
      recommendation,
      issues: mergeIssues(kycCase.issues || [], added),
    },
    amlStatus,
    primaryConcern: primary,
    mergeDecisions: merges.map(({ candidate, merge }) => ({ ...merge, candidateName: candidate.candidateName,
      confidenceScore: candidate.confidenceScore, confidenceLevel: candidate.confidenceLevel,
      recommendedDisposition: candidate.recommendedDisposition, missingEvidence: candidate.missingEvidence || [] })),
    complianceActions: {
      caseRecommendation: recommendation,
      manualAmlDisposition: manualDisposition(amlStatus),
      periodicScreeningCadence: periodicCadence(amlStatus, finalRisk.overallRisk),
      eddAction: recommendation === "APPROVE" ? "none required" : eddActions(kycCase),
    },
  };
}
