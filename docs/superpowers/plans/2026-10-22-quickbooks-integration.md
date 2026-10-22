# QuickBooks Desktop integration (income + expenses) — plan

Status: plan only, not started. Lease app (leasing-bookings, USA server).
On hold by Francis's request: reconciliation (2026-10-22-bank-reconciliation-v1.md) and
anything about Zego. Focus is only lease app → QuickBooks.

## Goal

Fully automate the QuickBooks entries. Everything is recorded in the lease app; the app
writes the matching entries into QuickBooks. Nobody types into QuickBooks.

## What we know (checked 2026-10-22)

- **QuickBooks Enterprise Solutions 24.0** (2024), supported by Intuit until about May 2027.
- Company file: "Houston Commercial Investments, LLC".
- On the "Home Computer", reached through Chrome Remote Desktop.
- **QuickBooks Web Connector 34.0 is installed**, nothing registered yet
  (File → App Management → Update Web Services).
- Today staff type rent into QuickBooks by hand.
- The boss's own buildings only; no rent collected for other owners.

## How the connection works

1. The lease app keeps a **queue** of entries waiting for QuickBooks.
2. Web Connector on the Home Computer asks the lease app every few minutes for waiting
   entries (SOAP + qbXML), writes them into QuickBooks, and reports back what QuickBooks
   accepted or refused.
3. If the PC is off, entries wait in the queue. Nothing is lost.
4. Web Connector also reads QuickBooks' lists back (accounts, vendors, classes,
   customers), so the app shows the same names as QuickBooks.

Needs: the Home Computer on during work hours; Web Connector set to run even when
QuickBooks is closed; the lease app on **HTTPS with a real domain** (Web Connector refuses
a bare IP) — see the USA domain setup plan.

## What the app sends

| Happens in the lease app | Entry in QuickBooks (qbXML) |
|---|---|
| New tenant | Customer (CustomerAdd), linked by id |
| Building | Class (ClassAdd), so QuickBooks reports profit per building |
| Rent or a charge falls due | Invoice (InvoiceAdd) |
| Late fee / extra charge | Invoice line |
| Payment recorded | Receive payment against the invoice, into Undeposited funds (ReceivePaymentAdd) |
| Payments taken to the bank together | Deposit grouping them, so it matches the bank (DepositAdd) |
| Payment bounced | Payment reversed, invoice open again, fee invoiced |
| Overpayment kept as credit | Customer credit |
| Security deposit received | Held in a "Tenant security deposits" liability account, not income |
| Deposit refunded at move-out | Refund from the liability; deductions to income |
| Expense recorded (AI reads the receipt) | Check, credit card charge or bill (CheckAdd / CreditCardChargeAdd / BillAdd), building as Class |
| Repeating bills (insurance, utilities, loan) | Created each month from a schedule in the app |
| Edit or delete in the app | The same QuickBooks entry updated or voided |

Every entry carries "Lease app #<id>" in its memo, so it can always be found.
Receipts stay in the lease app (Web Connector cannot attach files); the memo points to them.

Expenses entered directly in QuickBooks are read back into the app, tagged
"From QuickBooks", and changed only in QuickBooks. Whoever created an entry owns it.

## Safety

1. Back up the company file before connecting (File → Back Up Company → Create Local Backup).
2. Build and test against a **copy** of the company file or a QuickBooks sample company,
   never the real books.
3. First live step is read only: lists come in, nothing is written.
4. Writing starts from an agreed **start date**; the first entries are checked by hand.
   From that date staff stop typing these entries into QuickBooks.
5. An off switch in the app stops all sending at once; entries wait in the queue.
6. A log of everything sent, accepted or refused, in Accounts → QuickBooks.

## Setup screen (master only, Accounts → QuickBooks)

Connection status and last contact; the mapping (which income account for rent and for
each charge type, which Class for each building, which account for security deposits,
Undeposited funds); start date; off switch; the log.

## Build order

1. Domain + HTTPS for the lease app (prerequisite). Domain **jnrpro.co** bought at
   GoDaddy on 2026-10-22; Cloudflare DNS + certificate still to do.
2. Web Connector endpoint, the queue, the log; read lists from a test copy.
3. Mapping screen.
4. Customers, classes, invoices, payments, deposits.
5. Security deposits, returned payments, credits.
6. Accounts → Expenses: record in the app (AI reads the receipt) and send; read
   QuickBooks-entered expenses back.
7. Repeating bills.
8. Go live on the real file: backup, start date, first entries checked by hand.

## Questions still open

1. Which income, expense and bank accounts in QuickBooks should be used? (Read from the
   file in step 2, then chosen on the mapping screen.)
2. Are buildings already split in QuickBooks (Classes, or jobs under a customer)?
3. Is there already a security deposits account in QuickBooks?
4. Start date for going live.
