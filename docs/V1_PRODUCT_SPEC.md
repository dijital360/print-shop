# V1 Product Specification

## Goal
Build a production-oriented web-to-print ordering system for outdoor/large-format printing on top of Adminium Print Shop. V1 must prioritize accurate pricing, simple artwork submission, proof approval and production tracking. Online design/editing is explicitly out of scope.

## Customer and access model
- Store access mode must be configurable by the operator.
- Support at least retail and dealer/reseller customer groups.
- Dealer/reseller customers see their own price set or discount rules.
- Tax display is configurable by customer group.
- Architecture should remain tenant-ready for future use by other print shops, while V1 operates as a single company.

## V1 product scope
Initial product families:
- Banner / PVC banner
- Mesh
- Self-adhesive vinyl
- One Way Vision
- Reflective media
- Citylight
- Canvas
- Roll-up

Signage, 3D/channel letters, lightboxes and custom fabricated signs are deferred to a later quote-request workflow.

## Payment
V1:
- Bank transfer
- Customer credit/current-account workflow where enabled by operator

Card payments are deferred.

## Delivery
The data model and UI must allow delivery methods such as:
- Pickup
- Cargo/courier
- Freight/ambar
- Local courier

Automatic carrier pricing is deferred.

## Artwork submission
Every order line must support one of three artwork modes:
1. Direct upload up to 50 MB.
2. External file URL for files larger than 50 MB (e.g. Drive, Dropbox, OneDrive, WeTransfer-style link).
3. "I will send the artwork later".

Online design studio and Canva import are out of scope and should not be part of the customer journey.

Uploaded binary files must not be stored in PostgreSQL. Production target is object storage (S3-compatible storage such as Cloudflare R2, S3 or MinIO); PostgreSQL stores metadata and the storage key/URL.

## Proof approval
A job must not enter production until the required proof is approved by the customer.

Customer-visible simplified states:
- Order received
- Artwork check
- In production
- Ready
- Dispatched / delivered

Internal production states may be more detailed, e.g.:
- Artwork waiting
- Prepress / RIP
- Proof sent
- Proof approved
- Printing
- Lamination
- Cutting / finishing
- Packaging
- Ready
- Dispatched / collected

## Roll-media pricing engine
The pricing engine is a core V1 feature and must remain pure/deterministic and unit tested.

### Product-specific roll widths
Each roll material has an editable set of available original roll widths. Example banner widths:
- 1100 mm
- 1600 mm
- 2200 mm
- 2500 mm
- 3200 mm
- 4200 mm
- 5000 mm

The list is data, not hard-coded business logic, and may differ by material.

### Automatic rotation
For every requested finished size, the optimizer evaluates both orientations and may rotate the artwork when this lowers material consumption/cost.

### Multiple quantities
For quantity > 1, the optimizer evaluates layouts that place multiple identical pieces across the same roll where beneficial. The goal is to select the lowest billable production layout rather than price each piece independently.

### Waste charging
For the selected layout:
- Printed area is charged at 100% of the applicable media rate.
- Unprinted consumed roll area (waste) is charged at 50% of the applicable media rate.

Equivalent billable area:
`printedArea + (wasteArea * 0.50)`

The 50% waste factor must be configurable rather than permanently hard-coded.

### Split jobs
If the requested finished piece cannot fit on any available roll in either orientation:
- The engine automatically evaluates a two-piece split.
- It selects the lowest-cost valid split/layout across available roll widths.
- The customer receives a clear warning: the product will be printed in two pieces and joined.
- The quote must preserve the split plan so production sees exactly how it was priced.

Open production rule before split implementation is finalized: define seam/overlap allowance (if any) and whether joining has an extra finishing charge.

### Price result must preserve the plan
A quote should store enough pricing-plan metadata to explain and reproduce the price, including where applicable:
- selected roll width(s)
- rotation
- pieces across
- rows / consumed linear length
- printed area
- waste area
- waste charge factor
- split count and split dimensions
- material rate / customer price group
- finishing charges
- tax

Historical orders must retain the price and plan accepted at order time even if the current rate card changes later.

## Pricing groups and tax
Pricing must be separated from catalogue identity.
- Product/material defines what can be made.
- Price list/customer group defines what that customer pays.
- Retail and dealer pricing must not require duplicate products.
- Tax presentation must be configurable by customer group.

## Non-goals for V1
- Browser design editor
- Canva import
- Card payment gateway
- Automatic courier rate integration
- Full SaaS billing/tenant administration
- Custom fabricated signage calculator

## Quality gates
No feature is merged to `main` without:
- TypeScript build passing
- Unit tests passing
- Relevant pricing edge cases covered
- No direct binary artwork storage in PostgreSQL
- No customer order entering printing before required proof approval
- Review via feature branch / pull request

## Branching policy
- `main`: stable/releasable only
- `develop`: integration branch
- `feature/*`: isolated feature development

Initial planned feature branch: `feature/pricing-engine`.
