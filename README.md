# Betting Platform — Auth & Authorization API

Backend for the authentication and authorization module shared by `bettingApp`
(player mobile app) and `bettingWeb` (staff panel). Node.js, Express 5,
MongoDB/Mongoose, JWT access + rotating refresh tokens, bcrypt password
hashing, and a hierarchical role-based access control (RBAC) layer.

## Domain model

Every account — from the super-admin down to an individual player — is one
`User` document with a `role` and a `parent` pointer, forming a single tree:

```
super-admin
 └─ franchise
     └─ super-agent
         └─ agent
             └─ player
```

This mirrors `bettingWeb/src/config/roles.ts` (the four staff roles) plus
`player`, the role bettingApp's self-signup screen creates.

**Creation rule:** every role may create any role beneath it. A direct child
is parented under the creator by default; anything deeper needs an explicit
`parentId` of the role directly above the new account, and (except for
`super-admin`) that parent must sit inside the creator's own downline.
Only `super-admin` may leave a player unassigned. Players who self-register from the
app (`POST /auth/register`) have no parent — they aren't provisioned by any
agent.

A second, independent authorization layer — the **permission matrix** — governs
what `franchise` / `super-agent` / `agent` accounts may do to *player*
accounts specifically (view/create/edit/suspend users, wallet, …). It's
the same data `bettingWeb/src/features/permissions/PermissionsPage.tsx`
renders, seeded from the same defaults, editable only by `super-admin`.

## Getting started

```bash
cp .env.example .env   # then fill in real secrets before deploying anywhere real
npm install
npm run dev             # nodemon
# or
npm start
```

Requires a MongoDB instance reachable at `MONGO_URI`. On first boot the
server seeds:

- a root `super-admin` (`SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD`, falls
  back to `mithu8178` / `superadmin@123` outside production — the bettingWeb
  Quick Demo Login credentials);
- the demo `franchise01 → superagent01 → agent01` chain (also from
  `config/roles.ts`), skipped in production unless `SEED_DEMO_DATA=true`;
- the default permission matrix;
- a handful of demo rows (events, markets, bets, wallet requests,
  transactions, providers, flagged users, commission, partners, CMS content,
  notifications, a support ticket, and the settings singleton) for the
  super-admin panel modules below — idempotent, same `SEED_DEMO_DATA` gate.
  Three app players sit under `agent01`, all with password `player@123`:
  `demo_rahul`, `demo_priya` and `demo_amit`.

`SEED_DEMO_DATA=false` in `.env` keeps the database as it is — the server never
seeds demo players or matches on start. Back up with
`mongodump --uri="$MONGO_URI" --gzip --out=backups/<date>` (`backups/` is git-ignored).

## API

All routes are mounted under `/api`. Authenticated routes take
`Authorization: Bearer <accessToken>`.

`GET /health` (public) returns `{ status, dbMs, cpu, uptimeSeconds, liveMatches }`
— the panels' topbar and status bar poll it.

### Player — `/api/player` (players, from the app)

Bets are exchange style: the stake is **held**, not debited, until the market
settles. `available = walletBalance − open stakes − pending withdrawals`.
Every POST also returns the refreshed `wallet`.

| Method & path | Description |
| --- | --- |
| `GET /wallet` | `balance`, `openStake`, `pendingWithdrawal`, `available`, `wonToday`, `minDeposit`, `minWithdrawal`, last `transactions`, `requests`. |
| `POST /wallet/requests` | Body: `kind` (deposit/withdrawal), `amount`, `method`, `reference`. A deposit needs both its `reference` (the payment's UTR / transaction id, 6 to 40 letters or digits) and `proof` `{ name, data }`, the payment screenshot as a JPG / PNG / WebP data URI of up to 5MB. Withdrawals need `amount ≤ available`. The player's agent (or anyone above) approves it in the panel. |
| `GET /matches` | Live + upcoming events with Active markets, each market with its `runners` `[{ name, odds }]`. |
| `GET /matches/:id` | One match in the same shape. |
| `GET /bets` | The player's bets, newest first, with the current `cashOut` offer on open ones. |
| `POST /bets` | Body: `marketId`, `selection`, `stake`. Checks Settings `bettingLimits`, the market's `maxBet` and `available`. |
| `POST /bets/:id/cashout` | Closes an open bet at `stake × odds / currentOdds × 0.95`; the difference from the stake is written to the ledger. |
| `GET /notifications` | The player's own feed, newest first, plus `unreadCount`. Each row: `emoji`, `title`, `body`, `category`, `link` (screen to open: wallet/bets/live/profile), `unread`, `createdAt`. |
| `PATCH /notifications/:id/read` | Marks one of the player's rows read. |
| `PATCH /notifications/read-all` | Marks the whole feed read. |

Bets are checked against, in order: the platform stake limits
(`Settings.bettingLimits`), the market's `maxBet`, any `bettingLimit` set on the
player's agent / super agent / franchise, the player's available balance, the
platform's per-user and per-market exposure caps (`Settings.exposureLimits`,
`Market.maxExposure`) and any `maxExposure` set on an upline's whole book.
Deposit / withdrawal requests follow `Settings.walletRules`. Approving a
request, cashing out and settling are atomic: a double click or two reviewers
can never pay twice.

### Scoping for franchise / super-agent / agent

Wallet (`stats`, `requests`, approve/reject), Transactions, Commission and
Reports are also open to franchise, super-agent and agent — always filtered to
the caller's own downline (`scope.service.js`) and gated by the permission
matrix (`finance.walletBalance` V to read, `finance.deposit` / `finance.withdrawal`
X to approve, `finance.commission` V for the downline's commission rows,
`reportsAnalytics.reports` V). Manual entry, payments, disbursements, commission
settle and market settlement stay super-admin only.

More grants from the matrix that gate real behaviour:

| Grant | What it allows |
| --- | --- |
| `accountSettings.manageSubAgents` X | Create, edit and suspend the staff tier below (a super agent's agents). |
| `accountSettings.commissionSettings` X | Set share holding on those accounts (otherwise it's ignored on save). Session / match commission is set by the direct upline without this grant. |
| `finance.fundTransfer` X | `POST /wallet/transfer` — body `toUserId`, `amount`, `note`: moves money from the caller's own wallet to an account in its downline. |
| `reportsAnalytics.exportData` X | `GET /reports/:kind/export`. Previews need only `reports` V. |
| `support.raiseTicket` X | `POST /support/my-tickets` — body `subject`, `category`, `priority`, `body`. |
| `support.viewTickets` V | `GET /support/my-tickets`, `GET /support/my-tickets/:id`, `POST /support/my-tickets/:id/messages` — only the caller's own tickets. |

Commission is paid automatically at the end of each match (see Commission
below). Reports take `groupBy` (`Daily` / `Weekly` / `Monthly` /
`Quarterly`) to roll dated rows up per period; plain `from` / `to` dates are
whole days in India time.

### Auth — `/api/auth`

| Method & path | Auth | Description |
| --- | --- | --- |
| `POST /register` | — | Player self-signup (username, password, optional referral code). Every new player is placed under an agent: an active agent's code → that agent; a player's code → recorded as `referredBy`, placed under that player's agent; no/unknown code → a random active agent (unassigned only if no active agent exists). Returns tokens immediately. |
| `POST /login` | — | Username + password for any role. Optional `roleId` is cross-checked against the account's real role. |
| `POST /refresh` | — | Rotates a refresh token for a new access/refresh pair. Reuse of an already-rotated token revokes every session for that user (theft detection). |
| `POST /logout` | ✓ | Revokes the given refresh token. |
| `GET /me` | ✓ | Current user + their permission matrix (`null` for players). |
| `POST /change-password` | ✓ | Verifies current password, revokes every other session. |
| `POST /forgot-password` | — | `{ username }` → emails a 6-digit reset code (valid 10 min, 60s resend cooldown) to the account's email on file. Same reply whether or not the account exists. Without `SMTP_HOST`, development prints the code in the server console. |
| `POST /reset-password` | — | `{ username, code, newPassword }` → sets the new password and revokes every session. 5 wrong codes void the code. Outside production the master code `123456` (`RESET_MASTER_CODE`) also works for any account. |
| `GET /sessions` | ✓ | Caller's own active refresh-token sessions. |
| `DELETE /sessions/:id` | ✓ | Revoke a session (own, or any session if `super-admin`). |
| `GET /audit-logs` | ✓ super-admin | Paginated security audit trail (logins, provisioning, suspensions, permission edits). |

### Accounts — `/api/accounts` (all routes authenticated)

| Method & path | Description |
| --- | --- |
| `POST /` | Create a downline account. Body: `role, username, password` + profile fields, `parentId` (only meaningful for super-admin skip-level creates). |
| `GET /` | List accounts within the caller's own subtree (`super-admin` sees everyone). Query: `role, status, page, limit`. |
| `GET /me/permissions` | Caller's own permission matrix. |
| `GET /:id` | Fetch one account — must be the caller or within their subtree. |
| `PATCH /:id` | Edit profile fields (`name`, `email`, `phone`, `city`, `state`, `dob`) and, for staff, business fields (`businessName`, `bettingLimit`, `maxExposure`, `shareHolding`), plus `matchCommission` / `sessionCommission` for any role (capped at the upline's own rate; the direct upline may always set them). Players need the live `userManagement.editUser` grant; staff are `super-admin`-only. |
| `PATCH /:id/status` | Suspend/activate. For `player` targets, requires the live `userManagement.suspendUser` grant; staff targets are `super-admin`-only. |

### Network — `/api/network` (franchise, super-agent, agent, super-admin)

Backs the Users / Franchise / Super Agent / Agent pages. Results are always
limited to the caller's own downline (everyone, for `super-admin`).

| Method & path | Description |
| --- | --- |
| `GET /accounts` | Query: `role` (franchise/super-agent/agent/player), `status`, `q`, `page`, `limit`. Each row carries `summary` (downline counts, turnover, month-on-month turnover, open exposure, win rate, commission, risk). Also returns header `stats` over the whole role, the caller's `abilities` (create/edit/suspend) and `parentOptions` for new accounts. |
| `GET /dashboard` | The caller's own dashboard (Agent dashboard screen): user counts, today's bets/stake/commission/revenue vs yesterday, pending deposits/withdrawals, user overview, 7-day commission (stake × the caller's rate), recent activity and transactions — all limited to the caller's players. |
| `GET /accounts/:id` | Record sheet: account, ancestors, summary, downline (super agents / agents / players), wallet totals, recent bets, transactions, audit activity and live sessions. |

### Permissions — `/api/permissions` (all routes authenticated)

| Method & path | Description |
| --- | --- |
| `GET /` | Full matrix, all roles — `super-admin` only. |
| `GET /:roleKey` | One role's matrix (`superAgent`, `agent`, `franchise`) — any staff member can read their own; `super-admin` can read any. |
| `PUT /:roleKey/:groupKey/:permissionKey` | Replace one grant cell (`E`/`V`/`X` combination) — `super-admin` only. |

## Super Admin panel

Everything below backs the Super Admin dashboard in `bettingWeb`. Routes are
super-admin only unless the scoping note above opens them to the network
roles. Money fields are raw `Number` (rupees), formatted client-side.

### Dashboard — `/api/dashboard`

| Method & path | Description |
| --- | --- |
| `GET /` | Aggregated dashboard payload: `stats`, `revenue`, `sports`, `walletFlow`, `commission`, `commissionTotal`, `liveMatches`, `riskAlerts`, `health`, `transactions`, `bets`, `activity` (recent `AuditLog` entries). |

### Wallet — `/api/wallet`

| Method & path | Description |
| --- | --- |
| `GET /stats` | Pending deposit/withdrawal counts, total wallet balance, today's transaction volume. |
| `GET /requests` | Query: `kind` (deposit/withdrawal), `status`, `page`, `limit`. |
| `POST /requests/:id/approve` | Approves a pending request, adjusts `User.walletBalance`, writes a `Transaction`, notifies on large amounts. |
| `GET /requests/:id/proof` | The payment screenshot attached to a deposit (`proof.data` is a data URI). Lists never carry the image, only `proof.name` / `mime` / `size`. Limited to the caller's own network. |
| `POST /requests/:id/reject` | Rejects a pending request. Body: `reason` (optional, shown to the player in the app). |
| `POST /manual-entry` | Body: `userId`, `action` (`Credit`/`Debit`/`Adjustment`/`Transfer`), `amount`, `toUserId` (required for `Transfer`), `note`. |
| `GET /payments` | Query: `page`, `limit`. |
| `POST /payments` | Body: `recipientType` (`User`/`Partner`), `recipientId`, `paymentType`, `method`, `amount`, `note`. |
| `GET /disbursements` | Query: `page`, `limit`. |

### Transactions — `/api/transactions`

| Method & path | Description |
| --- | --- |
| `GET /` | Canonical ledger read. Query: `tab` (deposits/withdrawals/bets/commission/payments/adjustments), `q` (searches reference/note/method), `page`, `limit`. |

### Events — `/api/events`

| Method & path | Description |
| --- | --- |
| `GET /` | Query: `status` (Live/Upcoming/Suspended/Completed/Settled). |
| `POST /` | Body: `sport` (only the sports in `ENABLED_SPORTS` — Cricket for now), `name`, `league`, `emoji`, `startTime` (ISO 8601). |
| `GET /:id` | Event + its markets + recent bets. |
| `PATCH /:id/status` | Body: `status`. Moving to Suspended/Completed/Settled auto-suspends that event's active markets. |
| `PATCH /:id/score` | Body: `score` (up to 40 characters, '' clears it). The live score line players see on the match. |

### Markets — `/api/markets`

| Method & path | Description |
| --- | --- |
| `GET /` | Query: `eventId`, `status` (Active/Suspended), `type`. |
| `POST /` | Body: `event`, `code`, `name`, `type`, `maxBet`, `maxExposure`, `runners` `[{ name, odds }]` (what players can back; defaults to the event's two sides). `backOdds` / `layOdds` always mirror the first two runners. |
| `POST /suspend-all` | Bulk-suspends every Active market. |
| `PATCH /:id` | Partial update, including `runners`. A selection with open bets can be repriced but not renamed or removed; a settled market can't be edited. |
| `PATCH /:id/status` | Body: `status`. A settled market can't be re-activated. |
| `POST /:id/settle` | Body: `winner` (one of the market's selections). Marks every open bet Won/Lost, credits `Bet Win` / debits `Bet Loss`, closes the market. |
| `POST /:id/void` | No result (abandoned match): every open bet becomes `Void`, its stake is released, players are notified; the market can't be settled afterwards. Body: `reason` (optional). |

### Betting — `/api/betting`

| Method & path | Description |
| --- | --- |
| `GET /matches` | Query: `tab` (`live`/`upcoming`/`completed`) — Event+Market rollup for the board view. |
| `GET /providers` | Odds-provider connection status. |
| `POST /providers/sync-all` | Stub sync — marks every provider Connected/healthy. |

### Risk — `/api/risk`

| Method & path | Description |
| --- | --- |
| `GET /stats` | Flagged-user count, pattern count, high-exposure market count, large pending requests. |
| `GET /exposure` | Active markets sorted by exposure, descending. |
| `GET /panels` | Flagged users + suspicious patterns + large pending wallet requests. |
| `PATCH /exposure/:marketId/suspend` | Suspends one market. |

### Commission — `/api/commission`

| Method & path | Description |
| --- | --- |
Every account holds `sessionCommission` and `matchCommission`: the percent
it receives from its direct upline, which sets it (never above its own). An
account keeps what it receives minus what it passes down; the player keeps
all of its own rate. Once a match is Completed/Settled and has no pending
bets, `commission.service.js` (checked every minute) pays each account in
every player's chain, straight into its wallet with a `Commission` ledger row:

- **Session** — markets decided during the match (toss, fancy, over runs,
  odd/even, last digit): share × the player's session stake, won or lost.
- **Match** — Match Odds / Bookmaker: share × the player's net loss on them;
  nothing on a profit.

Each payout is one Settled row (`event`, `player`, `kind`, `turnover` = the
base, `rate` = the share). A match is paid once (`Event.commissionSettledAt`).

| Method & path | Description |
| --- | --- |
| `GET /` | Commission rows in the caller's scope, newest first. Query: `level` (Franchise/Super Agent/Agent/Player), `status`, `kind` (Session/Match). |
The player's own statement is `GET /api/player/statement`: per match, the
session and match results and the commission kept on each.

### Partnership — `/api/partnership`

| Method & path | Description |
| --- | --- |
| `GET /partners` | List partners (`apiKey` masked in the response). |
| `POST /partners` | Body: `name`, `type`, `revShare`, `monthlyFee`, `email`, … |
| `PATCH /partners/:id` | Partial update. |
| `PATCH /partners/:id/status` | Body: `status` (Active/Inactive/…). |
| `GET /revenue` | Revenue history aggregated across partners, by month. |
| `GET /settlements` | Partner settlement ledger. |

### Reports — `/api/reports`

| Method & path | Description |
| --- | --- |
| `GET /:kind/preview` | `kind` ∈ financial/betting/user/wallet/commission/exposure. Query: `from`, `to` (ISO 8601). JSON preview, capped at 1000 rows. |
| `GET /:kind/export` | Same data as CSV (`Content-Disposition: attachment`). |

### Analytics — `/api/analytics`

| Method & path | Description |
| --- | --- |
| `GET /series` | Query: `dimension` (`revenue`/`users`/`sports`/`commission`) — last 6 months. |
| `GET /highlights` | Total users, bets, turnover, commission. |

### CMS — `/api/cms`

| Method & path | Description |
| --- | --- |
| `GET /marquee` | Current dashboard marquee text. |
| `PATCH /marquee` | Body: `marqueeText`. |
| `GET /` | Query: `kind` (Announcement/Banner/Promotion/Notice). |
| `POST /` | Body: `kind`, `title`, `body`, `status`, `target`. |
| `PATCH /:id` | Partial update, including `runners`. A selection with open bets can be repriced but not renamed or removed; a settled market can't be edited. |
| `DELETE /:id` | Remove content. |

### Player notifications

Written by `notification.service.js#notifyPlayer()` when something happens to
the player's account; never by a route. A failure to write one never undoes
the action it describes.

| Event | Notification | Settings switch |
| --- | --- | --- |
| Deposit / withdrawal request approved or rejected | Deposit Successful, Withdrawal Approved, … Rejected (with the reason) | `notifyMoney` |
| Manual entry, transfer or fund transfer on the panel | Wallet Credited / Wallet Debited | `notifyMoney` |
| Market settled | Bet Won! / Bet Lost | `notifyLive` |
| Event set to Live (players holding an open bet on it) | "<match> — Live" | `notifyLive` |
| KYC verified or rejected | KYC Verified / KYC Rejected (with the reason) | always sent |
| Login, password change | Login Alert, Password Changed | `notifySecurity` |
| CMS Announcement / Promotion / Notice, `Published`, target `All` or players | The content itself; removed again when unpublished | `notifyPromos` |
| Sign-up | Welcome to BetPro | always sent |

The switches are the app's Settings toggles, saved on `User.preferences` via
`PATCH /api/auth/me` (`preferences: { notifyMoney: false }`; only the keys
sent change). A switch that was never touched counts as on. On boot, players
with no feed yet get one built from their history (reviewed requests, settled
bets, KYC decisions), marked read.

### Notifications — `/api/notifications`

| Method & path | Description |
| --- | --- |
| `GET /` | Recent notifications for the caller's role + unread count. |
| `PATCH /read-all` | Marks every notification read. |
| `DELETE /` | Clears the feed. |

Fired internally (via `notification.service.js#notify()`) on large wallet
requests, high-risk flags, and new support tickets.

### Support — `/api/support`

| Method & path | Description |
| --- | --- |
| `GET /tickets` | Query: `status`, `priority`, `q`. |
| `POST /tickets` | Body: `subject`, `raisedBy`, `category`, `role`, `priority`, `body`. |
| `GET /tickets/:id` | Ticket + its message thread. |
| `PATCH /tickets/:id/status` | Body: `status`. |
| `POST /tickets/:id/messages` | Body: `body`. Support replies auto-transition Open → In Progress. |

### Settings — `/api/settings`

| Method & path | Description |
| --- | --- |
| `GET /` | Singleton platform config (`apiKeys` masked). |
| `PATCH /:section` | `section` ∈ general/walletRules/bettingLimits/exposureLimits/commissionRates/smtp/sms/brand. |
| `POST /api-keys` | Body: `name`, `key`. |
| `PATCH /api-keys/:keyId` | Partial update. |
| `DELETE /api-keys/:keyId` | Remove a key. |

## Security notes

- Passwords are hashed with bcrypt (`BCRYPT_SALT_ROUNDS`, default 12).
- Access tokens are short-lived JWTs (`JWT_ACCESS_TTL`, default 15m).
- Refresh tokens are opaque random strings; only a SHA-256 hash is stored,
  with rotation and reuse detection.
- Login and registration are rate-limited (20 requests / 15 min / IP).
- Changing a password invalidates every access token issued before the
  change and revokes all refresh tokens.

## Live updates (Socket.IO)

The Diamond feed is REST-only, so the backend polls it (live matches every
second, `DIAMOND_LIVE_ODDS_MS`) and pushes what changed over Socket.IO on the
same port as the API. Connect with `io(<server>, { auth: { token: <access token> } })`.

| Event | Sent to | Payload / meaning |
| --- | --- | --- |
| `odds` | every client | `{ eventId, markets: [{ _id, name, type, status, maxBet, runners }] }` — only markets whose prices or status changed |
| `matches:changed` | every client | a match went live / finished or a market opened / closed — refetch `GET /player/matches` |
| `player:changed` | that player's devices | their wallet or bets changed — refetch them |
| `admin:changed` | panel (non-player) users | `{ kind: 'bets' \| 'ledger' \| 'wallet' }` — refresh open pages |

Clients may `emit('match:join', eventId)` / `match:leave`. Bets never trust a
pushed price: the server always takes the market's current odds, and refuses
bets on feed prices older than 20 s (live). `GET /api/health` reports
`liveClients`. Running several API servers needs the Socket.IO Redis adapter,
and only one of them should poll the feed.
