import {
  addDigestSubscriber,
  listDigestSubscribers,
  removeDigestSubscriber,
  SubscriberDeliveryBlockedError,
  updateDigestSubscriber,
} from "@/lib/data/talent-radar";

import { ApiError, getWorkspaceId, readJson, withDashboard } from "../_lib/http";
import {
  subscriberCreateSchema,
  subscriberDeleteSchema,
  subscriberUpdateSchema,
} from "../_lib/schemas";

export const runtime = "nodejs";

function subscriberView<T extends { status: string }>(subscriber: T) {
  return { ...subscriber, isActive: subscriber.status === "active" };
}

export async function GET(request: Request) {
  return withDashboard(request, async () => {
    const subscribers = await listDigestSubscribers(getWorkspaceId());
    return Response.json({ subscribers: subscribers.map(subscriberView) });
  });
}

export async function POST(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, subscriberCreateSchema);
    const subscriber = await addDigestSubscriber(getWorkspaceId(), input);
    return Response.json({ subscriber: subscriberView(subscriber) }, { status: 201 });
  });
}

export async function PATCH(request: Request) {
  return withDashboard(request, async () => {
    const { id, ...input } = await readJson(request, subscriberUpdateSchema);
    let subscriber;
    try {
      subscriber = await updateDigestSubscriber(getWorkspaceId(), id, input);
    } catch (error) {
      if (error instanceof SubscriberDeliveryBlockedError) {
        throw new ApiError(409, error.message);
      }
      throw error;
    }
    return Response.json({ subscriber: subscriberView(subscriber) });
  });
}

export async function DELETE(request: Request) {
  return withDashboard(request, async () => {
    const requestUrl = new URL(request.url);
    const queryId = requestUrl.searchParams.get("id");
    const input = queryId
      ? subscriberDeleteSchema.parse({ id: queryId })
      : await readJson(request, subscriberDeleteSchema);
    if (!input.id) throw new ApiError(400, "Subscriber id is required");
    await removeDigestSubscriber(getWorkspaceId(), input.id);
    return new Response(null, { status: 204 });
  });
}
