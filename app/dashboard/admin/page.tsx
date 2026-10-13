import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ledgerToRow, loanToRow, poolToRow, profileToRow, repaymentToRow } from "@/lib/db/rows";
import {
  fraudSignals as fraudSignalsTable,
  ledgerTransactions,
  lendingPools,
  loanRepayments,
  loans as loansTable,
  profiles as profilesTable,
} from "@/lib/db/schema";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils/formatting";

function sumByPeriod(
  rows: Array<{ amount: number; createdAt: string }>,
  startTime: number,
) {
  return rows
    .filter((row) => new Date(row.createdAt).getTime() >= startTime)
    .reduce((sum, row) => sum + row.amount, 0);
}

export default async function AdminDashboardPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const walletAddress = String(user.walletAddress ?? "") || null;
  const walletConnected = Boolean(walletAddress);
  
  // Platform-wide aggregates for the admin overview
  const db = getDb();

  const [profileRows, loanRows, repaymentRows, ledgerRowsRaw, fraudRows, poolRows] = db
    ? await Promise.all([
        db.select().from(profilesTable).orderBy(desc(profilesTable.createdAt)).limit(10),
        db.select().from(loansTable).orderBy(desc(loansTable.requestedAt)).limit(10),
        db.select().from(loanRepayments).orderBy(desc(loanRepayments.paidAt)).limit(120),
        db.select().from(ledgerTransactions).orderBy(desc(ledgerTransactions.createdAt)).limit(400),
        db
          .select({
            id: fraudSignalsTable.id,
            user_id: fraudSignalsTable.userId,
            signal_type: fraudSignalsTable.signalType,
            severity: fraudSignalsTable.severity,
            resolved: fraudSignalsTable.resolved,
            created_at: fraudSignalsTable.createdAt,
          })
          .from(fraudSignalsTable)
          .orderBy(desc(fraudSignalsTable.createdAt))
          .limit(120),
        db.select().from(lendingPools).orderBy(desc(lendingPools.createdAt)).limit(10),
      ])
    : [[], [], [], [], [], []];

  const profiles = profileRows.map(profileToRow);
  const loans = loanRows.map(loanToRow);
  const repayments = repaymentRows.map(repaymentToRow);
  const ledgerRows = ledgerRowsRaw.map(ledgerToRow);
  const fraudSignals = fraudRows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  const pools = poolRows.map(poolToRow);

  const anchorTime = new Date(
    String(ledgerRows[0]?.created_at ?? user.lastSignInAt ?? user.createdAt),
  ).getTime();
  const baseTime = Number.isFinite(anchorTime) ? anchorTime : 0;
  const baseDate = new Date(baseTime);
  const dayStartDate = new Date(baseDate);
  dayStartDate.setHours(0, 0, 0, 0);

  const todayStart = dayStartDate.getTime();
  const weeklyStart = baseTime - 7 * 24 * 60 * 60 * 1000;
  const monthlyStart = baseTime - 30 * 24 * 60 * 60 * 1000;
  const activeWindowStart = baseTime - 15 * 60 * 1000;

  const ledgerAmounts = ledgerRows.map((row) => ({
    amount: Number(row.amount ?? 0),
    createdAt: String(row.created_at ?? ""),
  }));

  const txToday = sumByPeriod(ledgerAmounts, todayStart);
  const txWeekly = sumByPeriod(ledgerAmounts, weeklyStart);
  const txMonthly = sumByPeriod(ledgerAmounts, monthlyStart);
  const txAllTime = ledgerAmounts.reduce((sum, row) => sum + row.amount, 0);

  const sanctionedLoans = loans.filter((loan) =>
    ["approved", "funded", "active", "repaid", "defaulted"].includes(String(loan.status).toLowerCase()),
  );
  const sanctionedAmount = sanctionedLoans.reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);
  const repaidAmount = repayments.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const lendersCount = profiles.filter((profile) => String(profile.role) === "lender").length;
  const borrowersCount = profiles.filter((profile) => String(profile.role) === "borrower").length;
  const activeUsers = new Set(
    ledgerRows
      .filter((row) => new Date(String(row.created_at)).getTime() >= activeWindowStart)
      .map((row) => String(row.user_id)),
  ).size;

  const maliciousUserIds = new Set(
    fraudSignals
      .filter((signal) => !signal.resolved && Number(signal.severity ?? 0) >= 4)
      .map((signal) => String(signal.user_id)),
  );

  const blockedUserIds = profiles
    .filter((profile) => ["high", "blocked"].includes(String(profile.risk_status)))
    .map((profile) => String(profile.id));

  blockedUserIds.forEach((id) => maliciousUserIds.add(id));

  const topUsersMap = new Map<string, number>();
  for (const row of ledgerRows) {
    const userId = String(row.user_id ?? "");
    const amount = Number(row.amount ?? 0);
    if (!userId) {
      continue;
    }
    topUsersMap.set(userId, (topUsersMap.get(userId) ?? 0) + amount);
  }

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Control Panel"
      description="Monitor platform health, credit activity, and security posture across TrustLend operations."
      email={user.email ?? null}
      userName={String(user.fullName ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin"
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={sanctionedAmount}
          pending={txToday}
          inLoansLabel="Sanctioned"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">
              Connect your Stellar wallet to unlock admin analytics and chain-linked verification data.
            </p>
          </article>
        ) : (
          <>
            <section className="workspace-grid workspace-grid--three">
              <article className="workspace-card">
                <h2 className="workspace-card-title">Users & access</h2>
                <p className="workspace-card-copy">Active now: {activeUsers}</p>
                <p className="workspace-card-copy">Total users: {profiles.length}</p>
                <p className="workspace-card-copy">Borrowers: {borrowersCount}</p>
                <p className="workspace-card-copy">Lenders: {lendersCount}</p>
              </article>

              <article className="workspace-card">
                <h2 className="workspace-card-title">Loan economy</h2>
                <p className="workspace-card-copy">Loans sanctioned: {sanctionedLoans.length}</p>
                <p className="workspace-card-copy">Amount sanctioned: {formatCurrency(sanctionedAmount)}</p>
                <p className="workspace-card-copy">Amount repaid: {formatCurrency(repaidAmount)}</p>
              </article>

              <article className="workspace-card">
                <h2 className="workspace-card-title">Transaction flow</h2>
                <p className="workspace-card-copy">Today: {formatCurrency(txToday)}</p>
                <p className="workspace-card-copy">Weekly: {formatCurrency(txWeekly)}</p>
                <p className="workspace-card-copy">Monthly: {formatCurrency(txMonthly)}</p>
                <p className="workspace-card-copy">All-time: {formatCurrency(txAllTime)}</p>
              </article>
            </section>

            <section className="workspace-grid workspace-grid--full">
              <article className="workspace-card workspace-card--full">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                  <h2 className="workspace-card-title" style={{ margin: 0 }}>Recent Users</h2>
                  <Link href="/dashboard/admin/users" className="workspace-nav-link" style={{ fontSize: "0.83rem" }}>
                    See more →
                  </Link>
                </div>
                <div className="workspace-table-wrap">
                  <table className="workspace-table">
                    <thead>
                      <tr>
                        <th>User ID</th>
                        <th>Role</th>
                        <th>Name</th>
                        <th>KYC</th>
                        <th>Risk</th>
                        <th>Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.length === 0 ? (
                        <tr><td colSpan={6} style={{ textAlign: "center", padding: "1.5rem", opacity: 0.5 }}>No users found.</td></tr>
                      ) : profiles.map((p) => (
                        <tr key={String(p.id)}>
                          <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{String(p.id).slice(0,8)}</td>
                          <td><span style={{ textTransform: "capitalize", fontWeight: 600 }}>{String(p.role)}</span></td>
                          <td>{String(p.full_name || "Unknown")}</td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "999px", fontSize: "0.75rem", fontWeight: 600, background: p.kyc_status === "verified" ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "color-mix(in srgb, var(--warning) 12%, transparent)", color: p.kyc_status === "verified" ? "var(--accent)" : "var(--warning)" }}>
                              {String(p.kyc_status).toUpperCase()}
                            </span>
                          </td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "999px", fontSize: "0.75rem", fontWeight: 600, color: p.risk_status === "low" ? "var(--accent)" : p.risk_status === "blocked" ? "var(--danger)" : "var(--warning)", background: p.risk_status === "low" ? "color-mix(in srgb, var(--accent) 12%, transparent)" : p.risk_status === "blocked" ? "color-mix(in srgb, var(--danger) 12%, transparent)" : "color-mix(in srgb, var(--warning) 12%, transparent)" }}>
                              {String(p.risk_status).toUpperCase()}
                            </span>
                          </td>
                          <td>{p.created_at ? new Date(String(p.created_at)).toLocaleDateString() : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>

            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Recent Lending Pools</h2>
                <div className="workspace-table-wrap">
                  <table className="workspace-table">
                    <thead>
                      <tr>
                        <th>Pool Name</th>
                        <th>Liquidity</th>
                        <th>Target APR</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pools.length === 0 ? (
                        <tr><td colSpan={4} style={{ textAlign: "center", padding: "1.5rem", opacity: 0.5 }}>No pools found.</td></tr>
                      ) : pools.map((p) => (
                        <tr key={String(p.id)}>
                          <td style={{ fontWeight: 600 }}>{String(p.name)}</td>
                          <td>{formatCurrency(Number(p.total_liquidity ?? 0))}</td>
                          <td style={{ color: "var(--accent)", fontWeight: "bold" }}>{(Number(p.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "999px", fontSize: "0.75rem", fontWeight: 600, background: p.status === "active" ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--surface-2)", color: p.status === "active" ? "var(--accent)" : "inherit" }}>
                              {String(p.status).toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Recent P2P Loans</h2>
                <div className="workspace-table-wrap">
                  <table className="workspace-table">
                    <thead>
                      <tr>
                        <th>Loan ID</th>
                        <th>Principal</th>
                        <th>Status</th>
                        <th>Borrower</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loans.length === 0 ? (
                        <tr><td colSpan={4} style={{ textAlign: "center", padding: "1.5rem", opacity: 0.5 }}>No loans found.</td></tr>
                      ) : loans.map((l) => (
                        <tr key={String(l.id)}>
                          <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{String(l.id).slice(0,8)}</td>
                          <td><strong>{formatCurrency(Number(l.principal_amount ?? 0))}</strong></td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "999px", fontSize: "0.75rem", fontWeight: 600, background: l.status === "repaid" ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "color-mix(in srgb, var(--accent) 12%, transparent)", color: l.status === "repaid" ? "var(--primary-muted)" : "var(--accent)" }}>
                              {String(l.status).toUpperCase()}
                            </span>
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.8 }}>{String(l.borrower_id).slice(0,6)}...</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
