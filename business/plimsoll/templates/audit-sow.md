# Statement of Work — Load Line Audit

> **Drafting template, not legal advice.** Have counsel review before first use. Bracketed
> fields are to be completed per engagement.

**Provider:** [Entity], [Address]
**Client:** [Entity], [Address]
**Effective date:** [Date]
**Fee:** $7,500 USD, fixed
**Term:** 10 business days from the Start Condition, plus a 60-day re-measurement

## 1. Purpose

Provider will measure what share of Client's merged code changes were authored with the
assistance of AI coding agents, compare the failure rate of those changes against
human-authored changes, and deliver a prioritised set of controls.

## 2. Start Condition

The term begins on the latest of: (a) execution of this SOW; (b) installation of Provider's
read-only GitHub App on the repositories in scope; (c) Client providing access to, or an
export of, incident and deployment records for the review period.

## 3. Scope

**In scope**
- Up to [10] repositories, over a review period of up to [12] months
- Provenance attribution from commit trailers and pull request metadata
- Cohort failure analysis: revert rate, rework rate, and the resulting risk ratio
- Breakdown by service, team and code path
- Identification of the [3] highest-risk paths where agent-authored changes concentrate
- A proposed merge policy, delivered as a pull request against Client's repositories
- Readout session of up to 90 minutes with Client's engineering leadership
- One re-measurement at 60 days with a written delta

**Out of scope** — available under a separate SOW
- Remediation of identified defects
- Changes to Client's CI/CD systems beyond the proposed policy pull request
- Ongoing monitoring (available as a Plimsoll Cloud subscription)
- Assessment of any code not in the repositories listed in Schedule A

## 4. Data handling

1. Provider processes **metadata only**: commit SHAs, timestamps, file paths, commit
   trailers, line counts, pull request records, CI results, deployment and incident records.
2. Provider does **not** retain Client source code or diff content. Where transient access
   to file contents is technically required, it is not persisted.
3. All access is read-only. Provider requests no write scope. The policy pull request is
   opened via Client-initiated means or delivered as a patch, at Client's election.
4. Provider deletes all Client data within 30 days of final deliverable, or sooner on
   written request, and confirms deletion in writing.
5. Provider will not report findings attributed to **any named individual**. All analysis is
   reported at the cohort, team or service level. This restriction is not waivable, including
   at Client's request.

## 5. Deliverables

| # | Deliverable | Day |
| --- | --- | --- |
| 1 | Load line report: agent share, cohort failure rates, risk ratio, with stated confidence | 9 |
| 2 | Per-service and per-team breakdown | 9 |
| 3 | Risk concentration analysis — the [3] highest-risk paths | 9 |
| 4 | Proposed merge policy as a pull request or patch | 10 |
| 5 | Readout session, up to 90 minutes | 10 |
| 6 | 60-day re-measurement and written delta | 70 |

## 6. Client responsibilities

Client will: install the read-only GitHub App or provide equivalent access; provide incident
and deployment records for the review period in any reasonable format; make 3–5 engineers
available for interviews of up to 45 minutes each; and nominate one person empowered to
accept the deliverables.

Delay by Client in meeting these responsibilities extends the term day for day.

## 7. Acceptance

Deliverables are deemed accepted on the earlier of written acceptance or **5 business days**
after delivery without written objection. A written objection must identify the specific
deliverable and the respect in which it does not conform to Section 5. Provider will correct
a conforming failure at no charge.

## 8. Fees and payment

$7,500 USD, fixed, invoiced 50% on execution and 50% on delivery of item 5. Net 15. The fee
is fixed regardless of hours worked. Expenses require prior written approval.

## 9. Methodology and its limits

Client acknowledges that Provider's failure metric is a **proxy**: a change is counted as
failed if it was reverted, or if a fix-shaped commit touched one of its files within the
analysis window. Where Client provides incident data, findings are joined to it and this is
stated in the report. Where Client does not, findings rest on the proxy alone and the report
states that plainly.

Provider will report the confidence level of every finding, including where sample size is
insufficient to support a conclusion. **Provider does not warrant that the analysis will
identify any particular defect, vulnerability or risk**, and the deliverables are not a
security audit, penetration test, or code review.

## 10. Confidentiality

Each party will protect the other's confidential information with at least reasonable care
and will not disclose it except to personnel who need it and are bound by equivalent
obligations. Obligations survive [3] years from disclosure.

## 11. Publicity

Provider may not name Client, or publish any finding identifying Client, without Client's
prior written consent. Provider may publish **anonymised and aggregated** findings that do
not identify Client, its repositories, or its personnel. Client may opt out of anonymised
publication by notice at any time. [Consent to be named: ☐ granted ☐ withheld]

## 12. Intellectual property

Client retains all rights in its code, data and systems. Provider retains all rights in its
methodology, software and templates, including any improvements made during the engagement.
Provider grants Client a perpetual, non-exclusive licence to use the deliverables internally.

## 13. Warranty and liability

Provider warrants it will perform in a professional and workmanlike manner. **Except as
stated, the deliverables are provided without warranty of any kind.** Each party's total
aggregate liability arising out of this SOW is limited to the fees paid. Neither party is
liable for indirect, incidental, special or consequential damages, or lost profits. Nothing
limits liability for fraud, wilful misconduct, or anything that cannot be limited by law.

## 14. General

Independent contractors; no partnership or employment. Neither party solicits the other's
personnel for [12] months. Governed by the laws of [State], exclusive venue in [County,
State]. This SOW and any MSA it references are the entire agreement, and amendments must be
in writing and signed.

---

**Provider** ____________________  Name/Title ____________  Date ________

**Client** ______________________  Name/Title ____________  Date ________

### Schedule A — Repositories in scope
| Repository | Primary language | Approx. engineers |
| --- | --- | --- |
| | | |
