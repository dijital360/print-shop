# Pricing Engine — Approved Decisions

These are the business rules confirmed for V1 and should be treated as product decisions, not implementation guesses.

- Roll widths are material-specific and configurable from data.
- Automatic 90° rotation is allowed when it produces a better valid layout.
- Quantity jobs must evaluate packing multiple copies across the roll width.
- The optimizer chooses the lowest billable valid layout, not simply the narrowest roll.
- Requested printed area is charged at the active customer/material rate.
- Physical waste is charged using a configurable factor; V1 default is 50%.
- If a job fits in one piece on any available roll, V1 keeps it one piece even if splitting could be marginally cheaper.
- If no single-piece layout fits, V1 may split the finished job into exactly two panels, evaluate both split axes and valid split positions, choose the best production plan, and show the customer a clear two-piece/join warning.
- Seam/overlap allowance is configurable. It remains 0 mm until the production overlap rule is explicitly finalized.
- Retail/dealer pricing must change commercial rates without changing the physical layout when roll/material constraints are otherwise the same.
- Historical accepted order totals must preserve the rate and optimizer plan used at order time.
- Browser-provided totals or customer-group identifiers are never authoritative; server/domain rules recalculate them.
