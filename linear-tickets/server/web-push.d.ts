// The part of web-push (https://github.com/web-push-libs/web-push) review-push.ts uses. Declared
// here rather than taken from @types/web-push: that package's `/// <reference types="node" />`
// loads Node's globals ahead of React Native's, which turns every setTimeout in the server into
// React Native's number-returning one.
declare module "web-push" {
  export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
  export type VapidKeys = { publicKey: string; privateKey: string };
  export type RequestOptions = {
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
  };
  function generateVAPIDKeys(): VapidKeys;
  function sendNotification(subscription: PushSubscription, payload?: string | Buffer | null, options?: RequestOptions): Promise<unknown>;
  const webpush: { generateVAPIDKeys: typeof generateVAPIDKeys; sendNotification: typeof sendNotification };
  export default webpush;
}
