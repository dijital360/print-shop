# Technical Audit and Migration Plan

## Executive summary
The Adminium `print-shop` fork is a strong base for the project, but it is currently a polished demo/reference application rather than a production outdoor-print ordering system. The best path is to preserve its deterministic domain-engine style, proof gate, customer/staff split, PostgreSQL/Adminium integration seam, tests and Docker structure while replacing demo catalogue/pricing/artwork persistence with production-ready implementations.

## Keep

### React + TypeScript + Vite
Keep the current frontend stack and its strict typed domain model.

### Pure quote/job engines
Keep the pattern used by `src/lib/quote.ts` and `src/lib/jobs.ts`: domain rules are pure functions, UI does not own pricing logic, and tests assert business rules independently of React.

### Proof gate
Keep the existing requirement that a prepress job cannot move into production without proof approval. Extend it to the final customer workflow rather than replacing it.

### Customer/staff separation
Keep the two-surface concept: customer ordering/tracking and staff production management are genuinely separate experiences.

### PostgreSQL + Adminium back office
Keep PostgreSQL and Adminium as the operational data/back-office foundation. The existing `DataSource` seam is valuable and already separates demo data from a connected Adminium instance.

### Stored historical totals
Keep the principle that accepted quote/order totals are stored and never silently recalculated using a future rate card.

### Testing and build gates
Keep TypeScript, Vitest and build checks as mandatory quality gates.

## Change substantially

### Catalogue source of truth
Current issue: the product/material catalogue and prices are mostly compile-time TypeScript data, while PostgreSQL mirrors only part of it. A product added in the database is not automatically sellable by the storefront.

Target:
- Move operator-editable outdoor catalogue data into the database.
- Keep only stable domain types/rules in TypeScript.
- Store product/material compatibility in normalized or JSON-backed configuration that can be edited safely.
- Roll widths must be data per material.

### Large-format pricing
Current implementation charges large format largely by requested square metres and assumes a simple maximum roll width.

Target:
- Replace with deterministic roll-layout optimization.
- Evaluate rotation.
- Evaluate quantity packing across roll width.
- Calculate consumed roll area and waste.
- Charge waste using a configurable factor (V1 default 50%).
- Evaluate two-piece split when no single roll can fit the finished item.
- Preserve the winning production plan with the quote/order.

### Customer groups and price lists
Target:
- Add configurable customer groups (at minimum retail and dealer/reseller).
- Separate price lists/discount rules from products.
- Allow tax display behaviour by group.
- Add current-account eligibility/limit fields later without duplicating the product catalogue.

### Artwork storage
Current schema stores artwork binary as PostgreSQL `bytea`; the connected client intentionally does not read the binary. Customer upload in the demo is simulated rather than a production file transfer.

Target:
- Store files in S3-compatible object storage (R2/S3/MinIO).
- PostgreSQL stores file metadata, storage key, size, mime/type and status.
- Direct upload maximum: 50 MB.
- External URL mode for larger files.
- "Send later" mode.
- Validate file type/size server-side; never rely only on browser checks.
- Use short-lived/presigned upload/download URLs where possible.

### Write path / persistence
Current Zustand actions perform several demo-only state mutations (for example placing an order locally). Production actions must persist through server/Adminium APIs and refresh/patch local state from authoritative records.

Target:
- Explicit command/service layer for quote save, order placement, proof events, artwork metadata and production transitions.
- Server-side authorization for all mutations.

### Production inventory
Current stock consumption logic is primarily sheet-oriented even though roll rows exist.

Target:
- Track roll media in linear metres and/or roll lots.
- Commit the optimizer's selected roll width and consumed length.
- Record actual spoilage separately from quoted waste.

## Remove or disable for V1

### Design Studio add-on
Remove from the customer path.

### Canva import add-on
Remove from the customer path.

### Demo-only pinned clock controls
Remove/disable in production mode; real deployment uses tenant time.

### Fictional seeded shop/customer presentation
Retain only as development fixtures/tests, never as production defaults.

## Schema additions proposed
This is a design direction; migrations should be implemented incrementally.

### tenants / shops
Even if V1 runs one company, data should carry a shop/tenant boundary where practical so future SaaS conversion does not require rethinking every core table.

Possible shop fields:
- id
- name
- legal/display details
- address/contact
- timezone
- currency
- tax settings

### customer_groups
- id
- shop_id
- key/name
- tax_display_mode
- can_use_account
- active

### customers
Add:
- customer_group_id
- billing/shipping/contact fields as required
- active/status

### materials
Add/replace fields for roll media:
- base unit/rate
- material type
- active
- product compatibility or relation

### material_roll_widths
- id
- material_id
- width_mm
- active
- optional stock/on-hand data

### price_lists / price_list_items
Support retail/dealer rates without duplicating products/materials.

### jobs / quote configuration
Store immutable pricing-plan snapshot in JSON, including optimizer output and rate inputs used at quote time.

### artwork
Replace `file bytea` with fields such as:
- mode (`upload`, `external_url`, `later`)
- filename
- storage_provider
- storage_key
- external_url
- file_size_bytes
- mime_type
- upload/status timestamps
- validation/check metadata

## Security requirements
- Artwork object storage must not be public by default.
- Presigned URLs should be short-lived.
- External URLs must be treated as untrusted input.
- Allowed upload extensions/MIME types must be configurable and validated server-side.
- Rate calculation is authoritative on the server/domain service; customer-supplied totals are never trusted.
- Customer can access only own quotes/orders/artwork.
- Dealer pricing must be derived from authenticated account/group, not a browser parameter.
- Production-stage transitions require staff authorization.

## Licensing note
The fork is AGPL-3.0-only. Before commercial SaaS/hosted distribution decisions, licensing obligations must be reviewed and respected. Do not remove licence notices while building on this codebase.

## Migration order
1. Freeze/document V1 domain rules.
2. Add roll optimizer as an isolated pure module with exhaustive tests.
3. Integrate optimizer into quote engine without changing customer UI first.
4. Move catalogue/rates/roll widths toward DB-backed configuration.
5. Add customer groups and price lists.
6. Replace demo artwork with real upload/external-link/later workflow.
7. Replace local/demo writes with persistent commands.
8. Simplify customer UI and remove design/Canva paths.
9. Extend staff production stages and roll inventory.
10. Add delivery choices and current-account operations.
11. Security/permission audit, staging and release process.

## Audit conclusion
Proceed with the fork. Do not rewrite from scratch. The existing code has useful engineering discipline, but treat its business data, upload flow and production persistence as scaffolding that must be replaced before production use.
