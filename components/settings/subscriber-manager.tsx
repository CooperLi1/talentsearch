"use client";

import { Plus, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";

export type SubscriberView = {
  createdAt: string;
  deliveryStatus: "never_sent" | "delivered" | "bounced" | "complained" | "failed";
  email: string;
  id: string;
  isActive: boolean;
  lastSentAt?: string | null;
};

export function SubscriberManager({ initialSubscribers }: { initialSubscribers: SubscriberView[] }) {
  const [subscribers, setSubscribers] = useState(initialSubscribers);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function addSubscriber(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(false);

    try {
      const response = await fetch("/api/subscribers", {
        body: JSON.stringify({ email }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        subscriber?: SubscriberView & {
          createdAt?: string;
          deliveryStatus?: SubscriberView["deliveryStatus"];
          lastSentAt?: string | null;
          status?: "active" | "paused";
        };
        error?: string;
      };
      if (!response.ok || !payload.subscriber) throw new Error(payload.error ?? "Could not add recipient");

      const subscriber: SubscriberView = {
        createdAt: payload.subscriber.createdAt ?? "Just now",
        deliveryStatus: payload.subscriber.deliveryStatus ?? "never_sent",
        email: payload.subscriber.email,
        id: payload.subscriber.id,
        isActive: payload.subscriber.status
          ? payload.subscriber.status === "active"
          : payload.subscriber.isActive,
        lastSentAt: payload.subscriber.lastSentAt,
      };

      setSubscribers((current) => [
        subscriber,
        ...current.filter((item) => item.id !== subscriber.id),
      ]);
      setEmail("");
      setMessage(
        subscriber.isActive
          ? `${subscriber.email} will receive the next brief.`
          : `${subscriber.email} remains paused because delivery needs attention.`,
      );
    } catch (caught) {
      setError(true);
      setMessage(caught instanceof Error ? caught.message : "Could not add recipient");
    } finally {
      setSaving(false);
    }
  }

  async function removeSubscriber(id: string) {
    const target = subscribers.find((subscriber) => subscriber.id === id);
    if (!target || !window.confirm(`Remove ${target.email} from the weekly brief?`)) return;
    const previous = subscribers;
    setPendingId(id);
    setMessage(null);
    setSubscribers((current) => current.filter((subscriber) => subscriber.id !== id));

    try {
      const response = await fetch(`/api/subscribers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove recipient");
    } catch {
      setSubscribers(previous);
      setError(true);
      setMessage("Could not remove that recipient. Try again.");
    } finally {
      setPendingId(null);
    }
  }

  async function toggleSubscriber(subscriber: SubscriberView) {
    const previous = subscribers;
    const isActive = !subscriber.isActive;
    setPendingId(subscriber.id);
    setMessage(null);
    setError(false);
    setSubscribers((current) =>
      current.map((item) =>
        item.id === subscriber.id ? { ...item, isActive } : item,
      ),
    );

    try {
      const response = await fetch("/api/subscribers", {
        body: JSON.stringify({
          id: subscriber.id,
          status: isActive ? "active" : "paused",
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        subscriber?: { isActive?: boolean; status?: "active" | "paused" };
      };
      if (!response.ok || !payload.subscriber) {
        throw new Error(payload.error ?? "Could not update recipient");
      }
      const persistedActive = payload.subscriber.status
        ? payload.subscriber.status === "active"
        : Boolean(payload.subscriber.isActive);
      setSubscribers((current) =>
        current.map((item) =>
          item.id === subscriber.id
            ? { ...item, isActive: persistedActive }
            : item,
        ),
      );
      setMessage(
        persistedActive
          ? `${subscriber.email} will receive the next brief.`
          : `${subscriber.email} is paused.`,
      );
    } catch (caught) {
      setSubscribers(previous);
      setError(true);
      setMessage(caught instanceof Error ? caught.message : "Could not update recipient");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      <form className="subscriber-form" onSubmit={addSubscriber}>
        <div>
          <label htmlFor="digest-email">Add a recipient</label>
          <input
            autoComplete="email"
            id="digest-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.com"
            required
            type="email"
            value={email}
          />
        </div>
        <button className="editorial-button editorial-button-dark" disabled={saving} type="submit">
          <Plus aria-hidden="true" /> {saving ? "Adding" : "Add email"}
        </button>
      </form>

      {message ? (
        <p
          className={error ? "form-message form-message-error" : "form-message"}
          role={error ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}

      <ul className="subscriber-list">
        {subscribers.map((subscriber) => {
          const resumeBlocked = ["bounced", "complained"].includes(
            subscriber.deliveryStatus,
          );
          return (
            <li className="subscriber-row" key={subscriber.id}>
              <span className="subscriber-email">{subscriber.email}</span>
              <button
                className={
                  subscriber.isActive
                    ? "subscriber-status"
                    : "subscriber-status subscriber-status-paused"
                }
                disabled={
                  pendingId === subscriber.id || (!subscriber.isActive && resumeBlocked)
                }
                onClick={() => toggleSubscriber(subscriber)}
                title={
                  !subscriber.isActive && resumeBlocked
                    ? "Resolve the delivery issue before resuming"
                    : subscriber.isActive
                      ? "Pause weekly email"
                      : "Resume weekly email"
                }
                type="button"
              >
                {pendingId === subscriber.id
                  ? "Updating"
                  : subscriber.isActive
                    ? "Active"
                    : "Paused"}
              </button>
              <span
                className={
                  ["bounced", "complained", "failed"].includes(
                    subscriber.deliveryStatus,
                  )
                    ? "subscriber-meta subscriber-meta-error"
                    : "subscriber-meta"
                }
              >
                {["bounced", "complained", "failed"].includes(
                  subscriber.deliveryStatus,
                )
                  ? "Delivery issue"
                  : subscriber.lastSentAt
                    ? `Sent ${subscriber.lastSentAt}`
                    : "Awaiting first brief"}
              </span>
              <button
                aria-label={`Remove ${subscriber.email}`}
                className="subscriber-remove"
                disabled={pendingId === subscriber.id}
                onClick={() => removeSubscriber(subscriber.id)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
