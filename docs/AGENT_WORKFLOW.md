# Agent and Skill Workflow

## Principle
AI agents accelerate implementation; they do not own product decisions or bypass review. Business rules live in specs/tests, not in agent memory.

## Recommended Adminium skills
The upstream Adminium project publishes seven agent skills. For this project, all seven may be installed, with these four being the most important:

### adminium-app
Use for:
- database tables
- dashboard/back-office pages
- roles and permissions
- app manifest/schema changes

### adminium-surface
Use for:
- customer storefront/order screens
- staff production screens
- public/authenticated access boundaries

### adminium-design
Use for:
- customer-facing UI quality
- responsive layout
- accessibility and interaction polish

### adminium-project
Use for:
- custom pricing engine integration
- storage/server rules
- Docker/deployment
- custom React/server code not covered by standard Adminium pages

Also useful when needed:
- `adminium`: router/orchestrator skill
- `adminium-add-ons`: only for approved integrations; do not reintroduce online design tools without a product decision
- `adminium-mobile`: out of V1 scope

Upstream installation command documented by Adminium:
`npx skills add Adminiumjs/skills`

## Agent roles for this repository

### Product/Domain Architect
Owns:
- V1 scope consistency
- pricing rule interpretation
- print-industry terminology
- acceptance criteria

Must read:
- `docs/V1_PRODUCT_SPEC.md`
- `docs/PRICING_ENGINE_SPEC.md`
- `docs/TECHNICAL_AUDIT.md`

### Backend/Data Architect
Owns:
- PostgreSQL schema
- customer groups/price lists
- object-storage metadata
- authorization boundaries
- immutable quote/order snapshots

### Pricing Engine Engineer
Owns:
- `src/lib/rollOptimizer.ts`
- physical layout calculations
- deterministic results
- tests and invariants

Must not put UI strings, database calls or authenticated customer selection inside the optimizer.

### Frontend Engineer
Owns:
- outdoor product configurator
- artwork upload/link/later UX
- split warning
- customer order tracking

Must consume domain results; must not duplicate pricing rules in React.

### QA/Security Reviewer
Owns:
- boundary/edge tests
- authorization review
- upload security
- pricing tamper resistance
- proof-gate bypass tests

### DevOps/Release Engineer
Owns:
- Docker/runtime configuration
- CI
- staging
- production deploy
- storage secrets/configuration

## Branch policy
- `main`: production/releasable only
- `develop`: integrated reviewed work
- `feature/*`: isolated implementation

No agent commits feature work directly to `main`.

## Pull request policy
Every functional PR must state:
- business rule implemented
- files/modules changed
- tests added/updated
- build/test status
- known open questions
- schema/security impact where relevant

PR stays draft while verification is incomplete.

## Required verification
Repository upstream CI defines the expected verification sequence:
- `npm run build`
- `npm test`
- manifest checks where applicable

A human/agent statement that code "looks correct" is not a substitute for these checks.

## Current note about fork CI
The fork contains the upstream GitHub Actions CI workflow. If pull requests produce no Actions runs, GitHub Actions may need to be enabled manually for the fork before PRs can be promoted from draft.

## Decision boundaries
Agents may decide implementation details that preserve documented behaviour.

Agents must stop for business approval when a choice materially changes:
- customer price
- production method/quality
- proof responsibility
- tax/account treatment
- accepted file policy
- customer-visible promise/turnaround

Example current business decision intentionally left configurable rather than guessed:
- seam/overlap allowance and any join finishing charge for two-panel large-format work.
