# V1 Implementation Backlog

GitHub Issues are currently disabled on this fork, so this file is the temporary source of truth for planned work.

## P0 — Core pricing and catalogue

### P0.1 Roll-media layout optimizer
Status: planned / feature branch created (`feature/pricing-engine`)

Deliverables:
- pure `rollOptimizer` domain module
- material-specific roll widths
- automatic rotation
- quantity packing
- waste calculation and configurable waste charge factor
- two-piece split fallback
- deterministic tie-breaking
- structured blocked reasons
- full Vitest coverage

Spec: `docs/PRICING_ENGINE_SPEC.md`

### P0.2 Integrate optimizer into quote engine
Status: blocked by P0.1

Deliverables:
- replace current simple large-format m² pricing path
- quote lines expose printed/waste/billable area cleanly
- preserve optimizer production plan in quote/order snapshot
- keep existing sheet-print pricing unchanged

### P0.3 Database-backed outdoor catalogue
Status: planned

Deliverables:
- outdoor products for V1
- editable material configuration
- editable roll widths per material
- finishing compatibility
- no compile-time-only product pricing as production source of truth

## P0 — Ordering and customer pricing

### P0.4 Customer groups and price lists
Status: planned

Deliverables:
- retail and dealer/reseller groups
- group-specific rate/discount rules
- tax display mode per group
- authoritative server/account-derived group selection
- no duplicated products for dealer pricing

### P0.5 Production-safe order persistence
Status: planned

Deliverables:
- replace demo-only local state mutations for quote/order placement
- persist accepted totals and pricing-plan snapshot
- persistent proof events
- persistent production-stage transitions
- staff/customer authorization boundaries

## P0 — Artwork

### P0.6 Real artwork submission
Status: planned

Deliverables:
- direct upload <= 50 MB
- external URL mode for >50 MB
- send-later mode
- object storage via S3-compatible provider
- metadata in PostgreSQL, not binary `bytea`
- server-side file type/size validation
- short-lived access URLs

### P0.7 Remove design-editor paths
Status: planned

Deliverables:
- remove/disable Design Studio from customer flow
- remove/disable Canva import from customer flow
- retain only upload / external link / later

## P1 — Production workflow

### P1.1 Outdoor production stages
Status: planned

Internal stages should support, where applicable:
- artwork waiting
- prepress / RIP
- proof sent
- proof approved
- printing
- lamination
- cutting / finishing
- packaging
- ready
- dispatched / collected

Customer sees a simplified mapping.

### P1.2 Roll inventory and consumption
Status: planned

Deliverables:
- roll-width-aware stock
- committed linear metres from optimizer plan
- actual spoilage separate from quoted waste
- reorder visibility

## P1 — Payments and delivery

### P1.3 Bank transfer and customer account
Status: planned

V1 payment choices:
- bank transfer
- current/customer account when customer is eligible

### P1.4 Delivery choices
Status: planned

Initial choices:
- pickup
- cargo/courier
- freight/ambar
- local courier

Automatic carrier pricing/integration is deferred.

## P1 — UX and branding

### P1.5 Simplify customer storefront for outdoor print
Status: planned

Deliverables:
- outdoor-first product grid
- material / size / finish / quantity configurator
- clear price breakdown
- split-job warning when applicable
- artwork step after configuration
- mobile-friendly checkout

### P1.6 Staff production UI
Status: planned

Deliverables:
- production board built around outdoor-print stages
- job ticket displays optimizer production plan
- proof gate remains explicit
- roll width / rotation / split panels visible to production

## P2 — Future readiness

### P2.1 Tenant-ready shop settings
Status: architectural preparation only in V1

Keep future multi-print-shop support possible without implementing SaaS billing/admin now.

### P2.2 Custom signage quote workflow
Status: deferred

Products such as lightboxes, fabricated signs and 3D/channel letters use quote-request flow rather than forced automatic pricing.

### P2.3 Card payments
Status: deferred

Do not block V1 architecture, but no payment gateway in first release.

## Release gates
Before V1 production release:
- typecheck passes
- all unit/integration tests pass
- pricing engine has boundary coverage
- proof approval cannot be bypassed
- customer authorization is verified
- dealer pricing cannot be selected by untrusted browser input
- artwork object storage is private by default
- uploaded files are server-validated
- historical accepted prices remain immutable
- staging deployment reviewed before main/release merge
