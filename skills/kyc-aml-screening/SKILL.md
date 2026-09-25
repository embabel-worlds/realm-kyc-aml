---
name: kyc-aml-screening
description: KYC onboarding and AML sanctions screening of a company from its certificate of incorporation — "screen this certificate", "run KYC on <company>", "is <company> sanctioned", "what did screening find for <case>". Extracts a KycCase from an uploaded document, screens it against the OFAC SDN list loaded in this world, has the LLM disposition candidates, and reports baseline vs AML-adjusted risk and the recommendation.
---

# KYC + AML screening

## The app

`/apps/kyc-aml/kyc-report.html` does the whole flow for a person: upload a certificate, screen it,
read the report, save it as HTML or PDF, and reopen earlier cases. `?caseId=<id>` opens one case's
report directly. Offer it whenever someone wants to screen a document or see a report.

## Screen a certificate

1. The certificate must be in the user's Documents (uploaded through the Documents app). If it is
   not, ask them to upload it — do not paste its text into chat as a substitute.
2. Run the pipeline: open the `kyc-screen-certificate` lens with `document` set to the upload's
   file name (e.g. `acme-certificate.pdf`), its URI (`upload://acme-certificate.pdf`) or its title.
   If the lens reports the name matches several documents, re-run with the URI it lists.
3. Report from its result, in this order: subject and registration details as extracted, baseline
   risk, each sanctions candidate (listed name, the alias that matched, confidence, disposition),
   final risk and score, recommendation, required compliance actions, and the report link.

## Answer questions about screened cases

Use the views, not hand-written Cypher: `KycCases` (every case), `KycCasesNeedingReview`,
`KycCaseCandidates {caseId}` (one case's candidates) and `SanctionsListsLoaded` (which list and
publish date a CLEAR result was checked against).

## Rules

- A candidate is a POSSIBLE match until an analyst decides. Never call a subject sanctioned on a
  name match; never call it clear when candidates exist. The LLM disposition is advice, not a decision.
- Never overwrite the subject's identity with a sanctions record's name or details.
- A CLEAR screen is only as current as the loaded list: quote its publish date from
  `SanctionsListsLoaded`. Every screen scores all list records of the subject's type.
- Risk numbers are demo methodology (weights, country table, thresholds), not regulatory constants.
