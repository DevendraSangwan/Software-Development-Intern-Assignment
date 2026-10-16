"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Sender = { id: string; name: string; email: string };
type EmailRecord = {
  id: string;
  recipient: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt?: string | null;
  sender?: { name: string; email: string };
};
type EmailFilter = "all" | "scheduled" | "sent" | "failed";
type SlackStatus = {
  connected: boolean;
  teamName: string | null;
  channelId: string | null;
  channelName: string | null;
};
type SlackChannel = { id: string; name: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function dateForInput(): string {
  const date = new Date(Date.now() + 5 * 60_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export default function Home() {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [slack, setSlack] = useState<SlackStatus>({
    connected: false, teamName: null, channelId: null, channelName: null
  });
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [search, setSearch] = useState("");
  const [emailFilter, setEmailFilter] = useState<EmailFilter>("all");
  const [dateDefault, setDateDefault] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshEmails = useCallback(async (query = search, filter = emailFilter) => {
    const params = new URLSearchParams({ status: filter });
    if (query.trim()) params.set("q", query);
    const emailRows = await api<EmailRecord[]>(`/api/emails?${params.toString()}`);
    setEmails(emailRows);
  }, [emailFilter, search]);

  const refresh = useCallback(async () => {
    const [senderRows, slackStatus] = await Promise.all([
      api<Sender[]>("/api/senders"),
      api<SlackStatus>("/api/slack/status")
    ]);
    setSenders(senderRows);
    setSlack(slackStatus);
    await refreshEmails();
  }, [refreshEmails]);

  useEffect(() => {
    setDateDefault(dateForInput());
    const params = new URLSearchParams(window.location.search);
    if (params.get("slack") === "connected") setNotice("Slack connected. Choose a channel for notifications.");
    if (params.get("slack") === "error") setError("Slack authorization was cancelled or failed.");
    Promise.all([
      api<Sender[]>("/api/senders"),
      api<SlackStatus>("/api/slack/status")
    ]).then(([senderRows, slackStatus]) => {
      setSenders(senderRows);
      setSlack(slackStatus);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load dashboard."));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshEmails(search, emailFilter).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not refresh emails."));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, emailFilter, refreshEmails]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshEmails(search, emailFilter).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not refresh emails."));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [search, emailFilter, refreshEmails]);

  useEffect(() => {
    if (!slack.connected) {
      setChannels([]);
      return;
    }
    api<SlackChannel[]>("/api/slack/channels")
      .then(setChannels)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load Slack channels."));
  }, [slack.connected]);

  async function createSender(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api<Sender>("/api/senders", {
        method: "POST",
        body: JSON.stringify({ name: form.get("senderName"), email: form.get("senderEmail") })
      });
      formElement.reset();
      await refresh();
      setNotice("Sender added.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add sender.");
    } finally {
      setBusy(false);
    }
  }

  async function scheduleEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api<EmailRecord>("/api/emails", {
        method: "POST",
        body: JSON.stringify({
          senderId: form.get("senderId"),
          recipient: form.get("recipient"),
          subject: form.get("subject"),
          textBody: form.get("textBody"),
          scheduledAt: new Date(String(form.get("scheduledAt"))).toISOString()
        })
      });
      formElement.reset();
      const scheduledAtInput = formElement.elements.namedItem("scheduledAt");
      if (scheduledAtInput instanceof HTMLInputElement) {
        scheduledAtInput.value = dateForInput();
      }
      await refresh();
      setNotice("Email scheduled successfully.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not schedule email.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseChannel(channelId: string) {
    try {
      await api("/api/slack/channel", { method: "POST", body: JSON.stringify({ channelId }) });
      await refresh();
      setNotice("Slack notification channel saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save Slack channel.");
    }
  }

  async function disconnect() {
    try {
      await api("/api/slack", { method: "DELETE" });
      await refresh();
      setNotice("Slack disconnected.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect Slack.");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Mitra Mail home">
          <span className="brand-mark">M</span>
          <span>Mitra<span className="brand-light">Mail</span></span>
        </a>
        <a className="queue-link" href={`${API}/admin/queues`} target="_blank" rel="noreferrer">
          <span className="live-dot" /> Live queue <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-line" /> DELIVERY CONTROL CENTER</div>
        <h1>Good things arrive<br /><span>right on time.</span></h1>
        <p className="hero-copy">Plan, queue, and track every email from one calm, reliable workspace.</p>
      </section>

      {(error || notice) && (
        <div className={`flash ${error ? "flash-error" : "flash-success"}`} role="status">
          {error || notice}
          <button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss">×</button>
        </div>
      )}

      <section className="dashboard-grid">
        <div className="panel compose-panel">
          <div className="panel-heading">
            <div>
              <span className="section-index">01 / COMPOSE</span>
              <h2>Schedule an email</h2>
            </div>
            <span className="heading-icon">✳</span>
          </div>
          {senders.length === 0 ? (
            <div className="empty-sender">
              <strong>Start with a sender</strong>
              <span>Add a sender below, then you can schedule your first email.</span>
            </div>
          ) : (
            <form className="form-stack" onSubmit={scheduleEmail}>
              <label>Send from
                <select name="senderId" required defaultValue="">
                  <option value="" disabled>Select a sender</option>
                  {senders.map((sender) => <option key={sender.id} value={sender.id}>{sender.name} · {sender.email}</option>)}
                </select>
              </label>
              <label>Recipient
                <input name="recipient" type="email" placeholder="name@example.com" required />
              </label>
              <label>Subject
                <input name="subject" placeholder="A little note for you" maxLength={998} required />
              </label>
              <label>Message
                <textarea name="textBody" rows={4} placeholder="Write your message…" maxLength={100000} required />
              </label>
              <label>Delivery time
                <input name="scheduledAt" type="datetime-local" min={dateForInput()} defaultValue={dateDefault} required />
              </label>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Working…" : "Schedule email"} <span aria-hidden="true">→</span>
              </button>
            </form>
          )}
        </div>

        <div className="side-stack">
          <section className="panel sender-panel">
            <div className="panel-heading compact">
              <div><span className="section-index">02 / SENDERS</span><h2>Your senders</h2></div>
              <span className="count-badge">{senders.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="sender-list">
              {senders.map((sender, index) => (
                <div className="sender-row" key={sender.id}>
                  <span className={`sender-avatar avatar-${index % 4}`}>{sender.name.slice(0, 1).toUpperCase()}</span>
                  <span className="sender-details"><strong>{sender.name}</strong><small>{sender.email}</small></span>
                  <span className="sender-state">ACTIVE</span>
                </div>
              ))}
              {senders.length === 0 && <p className="muted-note">No senders yet.</p>}
            </div>
            <form className="add-sender-form" onSubmit={createSender}>
              <input name="senderName" placeholder="Sender name" aria-label="Sender name" required />
              <input name="senderEmail" type="email" placeholder="sender@example.com" aria-label="Sender email" required />
              <button type="submit" disabled={busy} aria-label="Add sender">+</button>
            </form>
          </section>

          <section className="panel slack-panel">
            <div className="panel-heading compact">
              <div><span className="section-index">03 / NOTIFICATIONS</span><h2>Slack alerts</h2></div>
              <span className="slack-mark">#</span>
            </div>
            {slack.connected ? (
              <div className="slack-connected">
                <div className="connection-copy">
                  <span className="connected-dot" /> Connected{slack.teamName ? ` to ${slack.teamName}` : ""}
                </div>
                <label className="channel-label">Rate-limit alert channel
                  <select value={slack.channelId ?? ""} onChange={(event) => chooseChannel(event.target.value)}>
                    <option value="" disabled>Select a channel</option>
                    {channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                  </select>
                </label>
                <button className="text-button" onClick={disconnect}>Disconnect Slack</button>
              </div>
            ) : (
              <div className="slack-connect-copy">
                <p>Get a real Slack message when a sender reaches its hourly limit.</p>
                <a className="slack-button" href={`${API}/api/slack/connect`}>
                  <span className="slack-glyph">#</span> Connect Slack
                </a>
              </div>
            )}
          </section>
        </div>
      </section>

      <section className="panel activity-panel">
        <div className="activity-heading">
          <div className="panel-heading compact">
            <div><span className="section-index">04 / ACTIVITY</span><h2>Email activity</h2></div>
          </div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search emails…" aria-label="Search emails" />
            <kbd>ELASTIC</kbd>
          </label>
        </div>
        <div className="activity-filters" role="group" aria-label="Filter email activity">
          {(["all", "scheduled", "sent", "failed"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={`filter-button ${emailFilter === filter ? "filter-active" : ""}`}
              aria-pressed={emailFilter === filter}
              onClick={() => setEmailFilter(filter)}
            >
              {filter[0].toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>RECIPIENT</th><th>SUBJECT</th><th>SENDER</th><th>SCHEDULED / SENT</th><th>STATUS</th></tr></thead>
            <tbody>
              {emails.map((email) => (
                <tr key={email.id}>
                  <td className="recipient-cell">{email.recipient}</td>
                  <td>{email.subject}</td>
                  <td>{email.sender?.email ?? "—"}</td>
                  <td>{new Date(email.sentAt ?? email.scheduledAt).toLocaleString()}</td>
                  <td><span className={`status-pill status-${email.status.toLowerCase()}`}><span />{email.status}</span></td>
                </tr>
              ))}
              {emails.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-table">
                    {search ? "No matching emails found." : {
                      all: "Your scheduled emails will appear here.",
                      scheduled: "No scheduled emails yet.",
                      sent: "No emails have been sent yet.",
                      failed: "No failed emails."
                    }[emailFilter]}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="activity-footer">
          <span>Showing {emails.length} email{emails.length === 1 ? "" : "s"}</span>
          <span>Powered by Elasticsearch <span className="elastic-mark">◆</span></span>
        </div>
      </section>

      <footer className="footer">
        <span>MITRA MAIL <span className="footer-dot">·</span> BUILT FOR THE RIGHT MOMENT</span>
        <span>Reliable delivery, thoughtfully scheduled.</span>
      </footer>
    </main>
  );
}
